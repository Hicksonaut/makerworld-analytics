// Betrieb: Pull-Steuerung (Watchdog, RAM-Wache), Login, Einstellungen, Cron-Plaene.
import express from 'express';
import cron from 'node-cron';
import { db, getSetting, setSetting, nowIso } from './db.js';
import { T } from './i18n.js';
import { eurRate } from './kpi.js';
import { pullState, pushLog, memAvailableMb, mwJob } from './health.js';
import { weeklyText, sendDigest, pushNotify, checkMilestones } from './insights.js';
import { checkExperiments } from './experiments.js';

const app = express.Router();
export const router = app;

// Watchdog: ein Pull, der laenger laeuft, wird abgebrochen (haengendes Chromium/Request).
// Normal dauert ein Pull ~5 Min fuer 22 Modelle; 25 Min lassen reichlich Luft fuers Wachstum.
const PULL_TIMEOUT_MS = +process.env.PULL_TIMEOUT_MS || 25 * 60 * 1000;

// Pull-Laeufe, die noch als "running" stehen, obwohl keiner laeuft (Absturz/Neustart/Timeout), schliessen.
export function closeStaleRuns(reason) {
  const r = db.prepare(`UPDATE pull_runs SET status='error', finished_at=?, log=COALESCE(log,'') || ? WHERE status='running'`)
    .run(nowIso(), '\nABBRUCH: ' + reason);
  if (r.changes) console.log(`[pull] ${r.changes} haengenden Lauf als Fehler markiert (${reason})`);
  return r.changes;
}

// Ein Pull startet ein vollstaendiges Chromium (Spitze ~1,2 GB RAM). Bei knappem Arbeitsspeicher
// (die Pi teilt sich 4 GB mit Home Assistant & Co.) erst warten, statt einen OOM-Kill zu riskieren.
const PULL_MIN_RAM_MB = +process.env.PULL_MIN_RAM_MB || 800;
async function waitForRam(onLog) {
  for (let i = 0; i < 20; i++) {                 // bis zu 10 Minuten (20 x 30 s)
    const m = memAvailableMb();
    if (m == null || m >= PULL_MIN_RAM_MB) return true;
    if (i === 0) onLog(T(`Wenig freier RAM (${m} MB, benötigt ~${PULL_MIN_RAM_MB} MB) - warte ...`, `Low free RAM (${m} MB, needs ~${PULL_MIN_RAM_MB} MB) - waiting ...`));
    await new Promise(r => setTimeout(r, +process.env.PULL_RAM_WAIT_MS || 30000));
  }
  return false;
}

async function startPull(mode) {
  if (pullState.running) return { started: false, reason: T('Ein Pull läuft bereits.', 'A pull is already running.') };
  if (mwJob.running) return { started: false, reason: T(`Ein Browser-Auftrag (${mwJob.name}) läuft gerade - bitte danach erneut starten.`, `A browser job (${mwJob.name}) is running - please try again afterwards.`) };
  pullState.running = true; pullState.mode = mode; pullState.startedAt = nowIso(); pullState.log = [];
  pushLog(T(`Pull gestartet (${mode}) ...`, `Pull started (${mode}) ...`));
  let timedOut = false;
  let watchdog = setTimeout(async () => {
    timedOut = true;
    pushLog(T(`WATCHDOG: Pull läuft länger als ${PULL_TIMEOUT_MS / 60000} Min - wird abgebrochen.`, `WATCHDOG: pull has been running longer than ${PULL_TIMEOUT_MS / 60000} min - aborting.`));
    try { const { abortPull } = await import('./scraper.js'); await abortPull(); } catch (e) { pushLog(T('Abbruch: ', 'Abort: ') + e.message); }
    // Falls runPull trotzdem nicht zurueckkehrt: Zustand nach 60 s zwangsweise freigeben.
    setTimeout(() => {
      if (!pullState.running) return;
      pushLog(T('WATCHDOG: Zustand zwangsweise zurückgesetzt.', 'WATCHDOG: state forcibly reset.'));
      closeStaleRuns('Watchdog-Timeout');
      pullState.lastResult = { ok: false, error: 'Watchdog-Timeout', at: nowIso() }; pullState.running = false;
    }, 60000);
  }, PULL_TIMEOUT_MS);
  (async () => {
    try {
      if (!(await waitForRam(pushLog))) {
        const msg = T(`Zu wenig freier Arbeitsspeicher (< ${PULL_MIN_RAM_MB} MB) - Pull nicht gestartet.`, `Not enough free memory (< ${PULL_MIN_RAM_MB} MB) - pull not started.`);
        const now = nowIso();   // als Fehlerlauf in die Historie, damit Systemhinweise/Health es zeigen
        db.prepare(`INSERT INTO pull_runs(started_at,finished_at,status,mode,models_ok,models_failed,log) VALUES(?,?,?,?,0,0,?)`).run(now, now, 'error', mode, T('ABBRUCH: ', 'ABORTED: ') + msg);
        throw new Error(msg);
      }
      const { runPull } = await import('./scraper.js');   // lazy: Server startet auch ohne Playwright
      const res = await runPull({ mode, onLog: pushLog });
      pullState.lastResult = { ok: true, ...res, at: nowIso() };
      try { await checkMilestones(); } catch (e) { pushLog(T('Meilenstein-Check: ', 'Milestone check: ') + e.message); }
      try { await checkExperiments(pushNotify); } catch (e) { pushLog(T('Experiment-Check: ', 'Experiment check: ') + e.message); }
      try { await sendDigest('pull'); } catch {}   // Digest/Push nach erfolgreichem Pull
    } catch (e) {
      const msg = timedOut ? T(`Watchdog: Pull nach ${+(PULL_TIMEOUT_MS / 60000).toFixed(1)} Min abgebrochen (${e.message})`, `Watchdog: pull aborted after ${+(PULL_TIMEOUT_MS / 60000).toFixed(1)} min (${e.message})`) : e.message;
      pushLog(T('Fehler: ', 'Error: ') + msg);
      pullState.lastResult = { ok: false, error: msg, at: nowIso() };
      if (timedOut) db.prepare("UPDATE pull_runs SET log=COALESCE(log,'') || ? WHERE id=(SELECT MAX(id) FROM pull_runs)").run('\n' + msg);
      try { await pushNotify(T('MakerWorld Pull fehlgeschlagen', 'MakerWorld pull failed'), msg); } catch {}
    } finally { clearTimeout(watchdog); pullState.running = false; }
  })();
  return { started: true };
}

// ---- Pull / Login / Settings -------------------------------------
app.post('/api/pull/start', async (req, res) => res.json(await startPull('manual')));
app.get('/api/pull/status', (req, res) => res.json({
  ...pullState,
  lastRun: db.prepare('SELECT * FROM pull_runs ORDER BY id DESC LIMIT 1').get()
}));
app.post('/api/pull/cancel', async (req, res) => {
  if (!pullState.running) return res.json({ ok: false, reason: T('Es läuft kein Pull.', 'No pull is running.') });
  pushLog(T('Abbruch angefordert ...', 'Abort requested ...'));
  try { const { abortPull } = await import('./scraper.js'); await abortPull(); } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});

// Status aus dem gespeicherten letzten Login (kein headless-Check – den blockt
// Cloudflare). Mit ?deep=1 kann optional trotzdem live geprueft werden.
app.get('/api/login/status', async (req, res) => {
  if (req.query.deep === '1') {
    try { const { checkLogin } = await import('./scraper.js'); return res.json(await checkLogin()); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  res.json({
    loggedIn: getSetting('logged_in', '0') === '1',
    handle: getSetting('login_handle', null),
    at: getSetting('login_at', null)
  });
});
const loginState = { running: false, log: [] };
app.post('/api/login/start', async (req, res) => {
  if (loginState.running) return res.json({ started: false, reason: 'Login-Fenster ist bereits offen.' });
  loginState.running = true; loginState.log = [];
  (async () => {
    try {
      const { interactiveLogin } = await import('./scraper.js');
      const r = await interactiveLogin(m => { loginState.log.push(m); });
      if (r.handle) {
        setSetting('handle', '@' + r.handle);
        setSetting('login_handle', r.handle);
        setSetting('logged_in', '1');
        setSetting('login_at', nowIso());
      }
      loginState.result = r;
    } catch (e) { loginState.log.push('Fehler: ' + e.message); loginState.result = { error: e.message }; }
    finally { loginState.running = false; }
  })();
  res.json({ started: true });
});
app.get('/api/login/progress', (req, res) => res.json(loginState));

app.get('/api/settings', (req, res) => res.json({
  schedule_time: getSetting('schedule_time', '03:00'),
  schedule_enabled: getSetting('schedule_enabled', '0') === '1',
  start_date: getSetting('start_date', '2023-01-01'),
  eur_per_point: eurRate(),
  notify_url: getSetting('notify_url', ''),
  weekly_enabled: getSetting('weekly_enabled', '0') === '1',
  weekly_day: +getSetting('weekly_day', '1'),      // 0=So … 1=Mo
  weekly_time: getSetting('weekly_time', '08:00'),
  spool_low_g: +getSetting('spool_low_g', '150'),
  public_base_url: getSetting('public_base_url', ''),
  lang: getSetting('lang', 'de')
}));
app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  const { schedule_time, schedule_enabled, start_date, eur_per_point, notify_url } = b;
  if (schedule_time != null) setSetting('schedule_time', schedule_time);
  if (schedule_enabled != null) setSetting('schedule_enabled', schedule_enabled ? '1' : '0');
  if (start_date != null) setSetting('start_date', start_date);
  if (eur_per_point != null && Number.isFinite(+eur_per_point) && +eur_per_point > 0) setSetting('eur_per_point', String(+eur_per_point));
  if (notify_url != null) setSetting('notify_url', String(notify_url).trim());
  if (b.weekly_enabled != null) setSetting('weekly_enabled', b.weekly_enabled ? '1' : '0');
  if (b.weekly_day != null) setSetting('weekly_day', String(Math.max(0, Math.min(6, +b.weekly_day))));
  if (b.weekly_time != null) setSetting('weekly_time', String(b.weekly_time));
  if (b.spool_low_g != null) setSetting('spool_low_g', String(Math.max(0, +b.spool_low_g)));
  if (b.lang != null) setSetting('lang', b.lang === 'en' ? 'en' : 'de');
  if (b.public_base_url != null) setSetting('public_base_url', String(b.public_base_url).trim().replace(/\/+$/, ''));
  rescheduleCron(); rescheduleWeekly();
  res.json({ ok: true });
});

// ---- Cron: taeglicher Pull ------------------------------------------------
let cronTask = null;
export function rescheduleCron() {
  if (cronTask) { cronTask.stop(); cronTask = null; }
  if (getSetting('schedule_enabled', '0') !== '1') { console.log('[cron] deaktiviert'); return; }
  const [h, m] = getSetting('schedule_time', '03:00').split(':').map(Number);
  const expr = `${m || 0} ${h || 3} * * *`;
  cronTask = cron.schedule(expr, () => {
    console.log('[cron] Tages-Pull startet', new Date().toISOString());
    startPull('scheduled');
  });
  console.log('[cron] geplant:', expr);
}
// ---- Cron: woechentlicher Insight-Report ----------------------------------
let weeklyTask = null;
export function rescheduleWeekly() {
  if (weeklyTask) { weeklyTask.stop(); weeklyTask = null; }
  if (getSetting('weekly_enabled', '0') !== '1') return;
  const [h, m] = getSetting('weekly_time', '08:00').split(':').map(Number);
  const day = +getSetting('weekly_day', '1');
  const expr = `${m || 0} ${h || 8} * * ${day}`;
  weeklyTask = cron.schedule(expr, async () => {
    console.log('[cron] Wochen-Report', new Date().toISOString());
    try { await pushNotify(T('MakerWorld Wochen-Report', 'MakerWorld weekly report'), weeklyText()); } catch (e) { console.log(e.message); }
  });
  console.log('[cron] Wochen-Report geplant:', expr);
}

