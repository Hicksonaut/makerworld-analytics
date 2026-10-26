// Express-Server: REST-API + statisches Frontend + Tages-Scheduler.
import express from 'express';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, DATA_DIR, getSetting, setSetting, nowIso } from './db.js';
import { crm } from './crm.js';
import { trashPut, trashRestore, trashPurge, trashList, purgeOld, newAcc, addRows, rowsOf } from './trash.js';
import { renderStatus, projectFileByToken } from './publicPage.js';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const app = express();
app.disable('x-powered-by');

// ---- Schutz ohne Anmeldung ----------------------------------------------------------------
// Die App hat bewusst kein Passwort. Damit trotzdem keine fremde Webseite im Browser des Nutzers
// (CSRF) oder per DNS-Rebinding an die API kommt:
//  1. Host-Header muss ein lokaler/privater Name oder eine private IP sein (LAN, Tailscale, WireGuard).
//     Weitere Namen per Umgebungsvariable ALLOWED_HOSTS="a.example.com,b.example.com".
//  2. Schreibende Anfragen (POST/PUT/DELETE) mit Origin-Header muessen von derselben Adresse kommen.
const EXTRA_HOSTS = String(process.env.ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const hostOnly = h => { h = String(h || '').toLowerCase(); return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]; };
const PRIVATE_HOST = new RegExp('^(localhost|127(\\.\\d+){3}|\\[::1\\]|10(\\.\\d+){3}|192\\.168(\\.\\d+){2}|172\\.(1[6-9]|2\\d|3[01])(\\.\\d+){2}'
  + '|169\\.254(\\.\\d+){2}|100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(\\.\\d+){2}|\\[(fd|fe80)[0-9a-f:]*\\]|[^.]+|.+\\.(local|lan|fritz\\.box|home\\.arpa|ts\\.net))$');
const hostAllowed = h => PRIVATE_HOST.test(h) || EXTRA_HOSTS.includes(h);
app.use((req, res, next) => {
  const host = hostOnly(req.headers.host);
  if (!hostAllowed(host)) { console.log('[security] Host abgelehnt:', req.headers.host); return res.status(403).type('text').send('Host nicht erlaubt.'); }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "frame-ancestors 'none'" });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    let bad = req.headers['sec-fetch-site'] === 'cross-site' || origin === 'null';
    if (origin && origin !== 'null') { try { bad = bad || new URL(origin).host !== req.headers.host; } catch { bad = true; } }
    if (bad) { console.log('[security] Fremde Herkunft abgelehnt:', req.method, req.url, origin); return res.status(403).json({ error: 'Anfrage von fremder Herkunft abgelehnt.' }); }
  }
  next();
});

// Body-Limits: nur der .3mf-Upload darf gross sein (60 MB als Base64 ~ 80 MB); alles andere 2 MB.
app.use('/api/projects/:id/file', express.json({ limit: '85mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));
app.use('/api', crm);

// ---- Pull-Status (eine Instanz gleichzeitig) ------------------------------
const pullState = { running: false, mode: null, startedAt: null, log: [], lastResult: null };
function pushLog(m) { pullState.log.push(m); if (pullState.log.length > 500) pullState.log.shift(); }

// Watchdog: ein Pull, der laenger laeuft, wird abgebrochen (haengendes Chromium/Request).
// Normal dauert ein Pull ~5 Min fuer 22 Modelle; 25 Min lassen reichlich Luft fuers Wachstum.
const PULL_TIMEOUT_MS = +process.env.PULL_TIMEOUT_MS || 25 * 60 * 1000;

// Pull-Laeufe, die noch als "running" stehen, obwohl keiner laeuft (Absturz/Neustart/Timeout), schliessen.
function closeStaleRuns(reason) {
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
    if (i === 0) onLog(`Wenig freier RAM (${m} MB, benoetigt ~${PULL_MIN_RAM_MB} MB) - warte ...`);
    await new Promise(r => setTimeout(r, +process.env.PULL_RAM_WAIT_MS || 30000));
  }
  return false;
}

async function startPull(mode) {
  if (pullState.running) return { started: false, reason: 'Ein Pull laeuft bereits.' };
  pullState.running = true; pullState.mode = mode; pullState.startedAt = nowIso(); pullState.log = [];
  pushLog(`Pull gestartet (${mode}) ...`);
  let timedOut = false;
  let watchdog = setTimeout(async () => {
    timedOut = true;
    pushLog(`WATCHDOG: Pull laeuft laenger als ${PULL_TIMEOUT_MS / 60000} Min - wird abgebrochen.`);
    try { const { abortPull } = await import('./scraper.js'); await abortPull(); } catch (e) { pushLog('Abbruch: ' + e.message); }
    // Falls runPull trotzdem nicht zurueckkehrt: Zustand nach 60 s zwangsweise freigeben.
    setTimeout(() => {
      if (!pullState.running) return;
      pushLog('WATCHDOG: Zustand zwangsweise zurueckgesetzt.');
      closeStaleRuns('Watchdog-Timeout');
      pullState.lastResult = { ok: false, error: 'Watchdog-Timeout', at: nowIso() }; pullState.running = false;
    }, 60000);
  }, PULL_TIMEOUT_MS);
  (async () => {
    try {
      if (!(await waitForRam(pushLog))) {
        const msg = `Zu wenig freier Arbeitsspeicher (< ${PULL_MIN_RAM_MB} MB) - Pull nicht gestartet.`;
        const now = nowIso();   // als Fehlerlauf in die Historie, damit Systemhinweise/Health es zeigen
        db.prepare(`INSERT INTO pull_runs(started_at,finished_at,status,mode,models_ok,models_failed,log) VALUES(?,?,?,?,0,0,?)`).run(now, now, 'error', mode, 'ABBRUCH: ' + msg);
        throw new Error(msg);
      }
      const { runPull } = await import('./scraper.js');   // lazy: Server startet auch ohne Playwright
      const res = await runPull({ mode, onLog: pushLog });
      pullState.lastResult = { ok: true, ...res, at: nowIso() };
      try { await checkMilestones(); } catch (e) { pushLog('Meilenstein-Check: ' + e.message); }
      try { await sendDigest('pull'); } catch {}   // Digest/Push nach erfolgreichem Pull
    } catch (e) {
      const msg = timedOut ? `Watchdog: Pull nach ${+(PULL_TIMEOUT_MS / 60000).toFixed(1)} Min abgebrochen (${e.message})` : e.message;
      pushLog('Fehler: ' + msg);
      pullState.lastResult = { ok: false, error: msg, at: nowIso() };
      if (timedOut) db.prepare("UPDATE pull_runs SET log=COALESCE(log,'') || ? WHERE id=(SELECT MAX(id) FROM pull_runs)").run('\n' + msg);
      try { await pushNotify('MakerWorld Pull fehlgeschlagen', msg); } catch {}
    } finally { clearTimeout(watchdog); pullState.running = false; }
  })();
  return { started: true };
}

// ---- SQL-Bausteine --------------------------------------------------------
// neuester Snapshot = zuletzt eingefuegter (hoechste id), robuster als
// MAX(captured_at) – ein CSV-Import kann sonst per Datei-Datum den Live-Pull schlagen.
const latestSnapSub = `
  SELECT s.* FROM snapshots s
  JOIN (SELECT design_id, MAX(id) m FROM snapshots GROUP BY design_id) t
    ON t.design_id = s.design_id AND t.m = s.id`;

function modelsWithKpis() {
  return db.prepare(`
    SELECT m.*, s.impression, s.view, s.download, s.print, s.collect, s."like", s.follower,
           s.point, s.boost, s.ctr_pct, s.like_count, s.collect_count,
           s.comment_count, s.captured_at AS snap_at
    FROM models m
    LEFT JOIN (${latestSnapSub}) s ON s.design_id = m.design_id
    WHERE COALESCE(m.planned,0)=0
    ORDER BY s.download DESC NULLS LAST, s.view DESC NULLS LAST`).all();
}

// ---- API ------------------------------------------------------------------
// Momentum je Modell (7/30-Tage-Fenster, Delta ggue. Vorperiode) + Sparkline.
function attachMomentum(models) {
  const mom = {};
  for (const r of db.prepare(`
    SELECT design_id,
      SUM(CASE WHEN date >= date('now','-7 day')  THEN download ELSE 0 END) dl7,
      SUM(CASE WHEN date >= date('now','-14 day') AND date < date('now','-7 day') THEN download ELSE 0 END) dl_p7,
      SUM(CASE WHEN date >= date('now','-30 day') THEN download ELSE 0 END) dl30,
      SUM(CASE WHEN date >= date('now','-7 day')  THEN view ELSE 0 END) v7,
      SUM(CASE WHEN date >= date('now','-14 day') AND date < date('now','-7 day') THEN view ELSE 0 END) v_p7,
      SUM(CASE WHEN date >= date('now','-30 day') THEN view ELSE 0 END) v30,
      SUM(CASE WHEN date >= date('now','-30 day') THEN (point_from_model+point_from_inst+point_from_ratings+point_from_others) ELSE 0 END) pts30
    FROM daily_metrics GROUP BY design_id`).all()) mom[r.design_id] = r;
  const spark = {};
  for (const r of db.prepare(`SELECT design_id, view FROM daily_metrics
      WHERE date >= date('now','-30 day') ORDER BY design_id, date`).all())
    (spark[r.design_id] = spark[r.design_id] || []).push(r.view || 0);
  for (const m of models) {
    const x = mom[m.design_id] || {};
    m.dl7 = x.dl7 || 0; m.dl30 = x.dl30 || 0; m.v7 = x.v7 || 0; m.v30 = x.v30 || 0; m.pts30 = x.pts30 || 0;
    m.dl_per_day = +(m.dl7 / 7).toFixed(2); m.v_per_day = +(m.v7 / 7).toFixed(1);
    m.dl_delta = (x.dl7 || 0) - (x.dl_p7 || 0);            // absolute Aenderung Woche vs Vorwoche
    m.v_trend = (x.v_p7 > 0) ? +(((x.v7 - x.v_p7) / x.v_p7) * 100).toFixed(0) : null; // % ggue Vorwoche
    m.spark = spark[m.design_id] || [];
  }
  return models;
}

// Prognose je Modell per linearer Regression ueber die letzten 90 Tage (dichte
// Tagesreihe, fehlende Tage = 0). Trifft Anlauf/Abklingen besser als 30-Tage-Schnitt.
function projectSeries(dense, days) {
  const n = dense.length; if (!n) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += dense[i]; sxx += i * i; sxy += i * dense[i]; }
  const det = n * sxx - sx * sx;
  const b = det ? (n * sxy - sx * sy) / det : 0, a = (sy - b * sx) / n;
  let sum = 0; for (let t = n; t < n + days; t++) sum += Math.max(0, a + b * t);
  return Math.round(sum);
}
function attachForecast(models) {
  const WIN = 90;
  const base = new Date(); base.setUTCHours(0, 0, 0, 0);
  const dates = []; for (let i = WIN - 1; i >= 0; i--) { const d = new Date(base); d.setUTCDate(d.getUTCDate() - i); dates.push(d.toISOString().slice(0, 10)); }
  const idx = new Map(dates.map((d, i) => [d, i]));
  const series = {};
  for (const r of db.prepare(`SELECT design_id, date, download, view,
      (point_from_model+point_from_inst+point_from_ratings+point_from_others) pts
      FROM daily_metrics WHERE date >= ?`).all(dates[0])) {
    const i = idx.get(r.date); if (i == null) continue;
    const s = series[r.design_id] || (series[r.design_id] = { dl: Array(WIN).fill(0), vw: Array(WIN).fill(0), pt: Array(WIN).fill(0) });
    s.dl[i] += r.download || 0; s.vw[i] += r.view || 0; s.pt[i] += r.pts || 0;
  }
  const rate = eurRate();
  for (const m of models) {
    const s = series[m.design_id] || { dl: [], vw: [], pt: [] };
    m.proj_dl30 = projectSeries(s.dl, 30); m.proj_dl90 = projectSeries(s.dl, 90);
    m.proj_v30 = projectSeries(s.vw, 30); m.proj_v90 = projectSeries(s.vw, 90);
    m.proj_pts30 = projectSeries(s.pt, 30); m.proj_pts90 = projectSeries(s.pt, 90);
    m.proj_eur30 = +(m.proj_pts30 * rate).toFixed(2); m.proj_eur90 = +(m.proj_pts90 * rate).toFixed(2);
  }
  return models;
}

// 524 Punkte = 40 EUR-Gutschein (MakerWorld). Eine Stelle fuer die Konstanten.
const VOUCHER_POINTS = 524, VOUCHER_EUR = 40;
const DEFAULT_RATE = VOUCHER_EUR / VOUCHER_POINTS;
// Gutschein-Status aus Kontostand + erwarteten Punkten je Tag. EINZIGE Quelle fuer die ETA
// (Uebersicht, Heute-Insights, Bericht) - Basis ist die Trend-Prognose (attachForecast, 90 Tage).
function voucherStatus(walletPts, perDayPts) {
  const remaining = Math.max(0, VOUCHER_POINTS - ((walletPts || 0) % VOUCHER_POINTS));
  return { remaining: Math.round(remaining), perDay: perDayPts, etaDays: perDayPts > 0 ? Math.ceil(remaining / perDayPts) : null };
}
// ---- Gruppierung (Kategorie / eigene Gruppe / Hashtag): EINE Stelle fuer Schluessel + Aggregation ----
const parseTags = m => { try { return m.tags ? JSON.parse(m.tags) : []; } catch { return []; } };
function groupKeysOf(m, by) {
  if (by === 'tag') { const t = parseTags(m); return t.length ? t : ['—']; }
  return [(by === 'group' ? m.group_label : m.category) || '—'];
}
const GROUP_SUM = ['view', 'impression', 'download', 'print', 'collect', 'like', 'point', 'boost', 'dl30', 'v30'];
function aggregateGroups(models, by) {
  const buckets = {};
  for (const m of models) for (const key of groupKeysOf(m, by)) {
    const b = buckets[key] || (buckets[key] = { key, count: 0, ...Object.fromEntries(GROUP_SUM.map(k => [k, 0])) });
    b.count++; for (const k of GROUP_SUM) b[k] += (m[k] || 0);
  }
  return Object.values(buckets).map(b => ({ ...b, ctr: b.impression ? +((b.view / b.impression) * 100).toFixed(2) : null })).sort((a, b) => b.download - a.download);
}
const eurRate = () => { const r = parseFloat(getSetting('eur_per_point', String(DEFAULT_RATE))); return Number.isFinite(r) ? r : DEFAULT_RATE; };

app.get('/api/overview', (req, res) => {
  const models = attachForecast(attachMomentum(modelsWithKpis()));
  const rate = eurRate();
  for (const m of models) { m.earned = +(((m.point || 0) * rate)).toFixed(2); m.earned30 = +(((m.pts30 || 0) * rate)).toFixed(2); }
  const totals = models.reduce((a, m) => {
    for (const k of ['impression','view','download','print','collect','like','follower','point','boost'])
      a[k] = (a[k] || 0) + (m[k] || 0);
    return a;
  }, {});
  totals.dl30 = models.reduce((s, m) => s + (m.dl30 || 0), 0);
  totals.v30 = models.reduce((s, m) => s + (m.v30 || 0), 0);
  totals.pts30 = models.reduce((s, m) => s + (m.pts30 || 0), 0);
  totals.earned = +(totals.point * rate).toFixed(2);
  totals.earned30 = +(totals.pts30 * rate).toFixed(2);
  // Portfolio-Prognose (Summe der Regressions-Projektionen)
  for (const k of ['proj_dl30','proj_dl90','proj_v30','proj_v90','proj_pts30','proj_pts90','proj_eur30','proj_eur90'])
    totals[k] = +(models.reduce((s, m) => s + (m[k] || 0), 0)).toFixed(2);
  // Konto-Snapshot (Portfolio-Ebene) + echter Punkte-Kontostand
  const account = db.prepare('SELECT * FROM account_snapshots ORDER BY id DESC LIMIT 1').get();
  if (account) account.wallet_eur = +(((account.point || 0) * rate)).toFixed(2);
  // ETA bis zum naechsten 40-EUR-Gutschein (524 Punkte) - echter Kontostand bevorzugt
  const walletPts = account?.point != null ? account.point : totals.point;
  const vs = voucherStatus(walletPts, totals.proj_pts30 / 30);
  totals.voucher_remaining = vs.remaining;
  totals.voucher_eta_days = vs.etaDays;
  totals.wallet_point = account?.point ?? null;
  totals.wallet_eur = account?.wallet_eur ?? null;
  const lastPull = db.prepare('SELECT * FROM pull_runs ORDER BY id DESC LIMIT 1').get();
  const openTodos = db.prepare('SELECT COUNT(*) c FROM todos WHERE done=0').get().c;
  const planned = db.prepare('SELECT * FROM models WHERE planned=1 ORDER BY rowid DESC').all();
  res.json({
    handle: getSetting('handle', '@you'),
    models, totals, account, count: models.length, lastPull, openTodos, planned,
    settings: {
      schedule_time: getSetting('schedule_time', '03:00'),
      schedule_enabled: getSetting('schedule_enabled', '0') === '1',
      start_date: getSetting('start_date', '2023-01-01'),
      eur_per_point: eurRate()
    }
  });
});

// Schlanke Teilabfragen (Aufgaben, Druckprofile) - damit das Frontend nicht fuer jede Kleinigkeit das ganze Modell-Detail laedt.
const modelTodos = id => db.prepare('SELECT t.*, m.title AS model_title FROM todos t LEFT JOIN models m ON m.design_id=t.design_id WHERE t.design_id=? ORDER BY t.done, t.priority DESC, t.id').all(id);
const modelInstances = id => db.prepare('SELECT * FROM instances WHERE design_id=? ORDER BY is_default DESC, download_count DESC').all(id)
  .map(x => ({ ...x, rating_avg: x.rating_count ? +(x.rating_score_total / x.rating_count).toFixed(2) : null, print_min: x.prediction ? Math.round(x.prediction / 60) : null }));
app.get('/api/model/:id/todos', (req, res) => res.json(modelTodos(req.params.id)));
app.get('/api/model/:id/instances', (req, res) => res.json(modelInstances(req.params.id)));
app.get('/api/model/:id', (req, res) => {
  const id = req.params.id;
  const model = db.prepare('SELECT * FROM models WHERE design_id = ?').get(id);
  if (!model) return res.status(404).json({ error: 'unbekanntes Modell' });
  // Momentum (dl30/v30/pts30/v_trend) + Prognose + Verdienst fuer die Detailseite.
  attachMomentum([model]); attachForecast([model]);
  const pt = db.prepare('SELECT point FROM snapshots WHERE design_id=? ORDER BY id DESC LIMIT 1').get(id);
  model.earned = +(((pt?.point || 0) * eurRate())).toFixed(2);
  const snaps = db.prepare('SELECT * FROM snapshots WHERE design_id=? ORDER BY id').all(id);
  const daily = db.prepare('SELECT * FROM daily_metrics WHERE design_id=? ORDER BY date').all(id);
  const traffic = db.prepare(`SELECT * FROM traffic_sources WHERE design_id=? AND captured_at=
      (SELECT MAX(captured_at) FROM traffic_sources WHERE design_id=?)`).all(id, id);
  const events = db.prepare('SELECT * FROM events WHERE design_id=? ORDER BY date DESC, id DESC').all(id);
  const images = db.prepare(`SELECT * FROM images WHERE design_id=?
      AND (url LIKE '%/design/%' OR url LIKE '%/instance/%') ORDER BY position`).all(id);
  const todos = modelTodos(id);
  const instances = modelInstances(id);
  const crmProjects = db.prepare(`SELECT p.id, p.title, p.stage, p.price, COALESCE(c.name, 'Eigenprojekt') contact_name, c.id contact_id
    FROM projects p LEFT JOIN contacts c ON c.id=p.contact_id WHERE p.design_id=? ORDER BY p.id DESC`).all(id);
  res.json({ model: { ...model, tags: model.tags ? JSON.parse(model.tags) : [] }, snaps, daily, traffic, events, images, todos, instances, crmProjects });
});

// Vergleichs-Zeitreihen. Query: ids=a,b metric=view granularity=day|week|month
//   mode=date|age  cumulative=0|1
app.get('/api/timeseries', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  const group = String(req.query.group || '');   // '' | category | group | tag
  const metric = String(req.query.metric || 'view');
  const gran = String(req.query.granularity || 'day');
  const mode = String(req.query.mode || 'date');
  const cumulative = req.query.cumulative === '1';

  const metricSql = metric === 'points'
    ? '(point_from_model+point_from_inst+point_from_ratings+point_from_others)'
    : (['impression','view','download','print','collect','like','follower','boost'].includes(metric)
        ? `"${metric}"` : '"view"');
  const bucket = gran === 'month' ? `strftime('%Y-%m', date)`
                : gran === 'week' ? `strftime('%Y-W%W', date)`
                : 'date';

  // Zeitreihe fuer eine Menge von Modell-IDs aggregieren.
  const seriesFor = (memberIds) => {
    if (!memberIds.length) return [];
    const ph = memberIds.map(() => '?').join(',');
    let rows;
    if (mode === 'age') {
      rows = db.prepare(`SELECT days_since_publish AS x, SUM(${metricSql}) AS y FROM daily_metrics
        WHERE design_id IN (${ph}) AND days_since_publish IS NOT NULL GROUP BY days_since_publish ORDER BY x`).all(...memberIds);
    } else {
      rows = db.prepare(`SELECT ${bucket} AS x, SUM(${metricSql}) AS y FROM daily_metrics
        WHERE design_id IN (${ph}) GROUP BY ${bucket} ORDER BY x`).all(...memberIds);
    }
    if (cumulative) { let c = 0; rows = rows.map(r => ({ x: r.x, y: (c += r.y || 0) })); }
    return rows;
  };

  // Gruppen-Modus: eine aggregierte Linie je Kategorie/Tag/eigener Gruppe.
  if (group) {
    const map = {};
    for (const m of db.prepare('SELECT design_id, category, group_label, tags FROM models').all())
      for (const k of groupKeysOf(m, group)) (map[k] = map[k] || []).push(m.design_id);
    // groesste Gruppen zuerst, auf 12 begrenzen
    const series = Object.entries(map)
      .map(([k, mids]) => ({ id: k, title: `${k} (${mids.length})`, count: mids.length, points: seriesFor(mids) }))
      .sort((a, b) => b.count - a.count).slice(0, 12);
    return res.json({ series, metric, gran, mode, cumulative, grouped: group });
  }

  if (!ids.length) return res.json({ series: [] });
  const series = ids.map(id => {
    const m = db.prepare('SELECT title FROM models WHERE design_id=?').get(id);
    return { id, title: m ? m.title : id, points: seriesFor([id]) };
  });
  res.json({ series, metric, gran, mode, cumulative });
});

// ---- Events (Zeitstempel der Upload-Aenderungen) --------------------------
app.get('/api/events', (req, res) => {
  const rows = req.query.design_id
    ? db.prepare('SELECT * FROM events WHERE design_id=? ORDER BY date DESC, id DESC').all(req.query.design_id)
    : db.prepare('SELECT * FROM events ORDER BY date DESC, id DESC').all();
  res.json(rows);
});
app.post('/api/events', (req, res) => {
  const { design_id, date, type, title, note } = req.body || {};
  if (!date) return res.status(400).json({ error: 'date fehlt' });
  const r = db.prepare(`INSERT INTO events(design_id,date,type,title,note,created_at) VALUES(?,?,?,?,?,?)`)
    .run(design_id || null, date, type || 'other', title || '', note || '', nowIso());
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/events/:id', (req, res) => {
  const { date, type, title, note } = req.body || {};
  db.prepare('UPDATE events SET date=?,type=?,title=?,note=? WHERE id=?')
    .run(date, type, title, note, req.params.id);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id));
});
app.delete('/api/events/:id', (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  const trash_id = ev ? trashPut('event', ev.title || ev.type || 'Änderung', addRows(newAcc(), 'events', [ev])) : null;
  db.prepare('DELETE FROM events WHERE id=?').run(req.params.id);
  res.json({ ok: true, trash_id });
});

// ---- Alerts (aus Momentum + Zielen) ---------------------------------------
function computeAlerts(models) {
  const out = [];
  for (const m of models) {
    const age = m.publish_date ? Math.round((Date.now() - Date.parse(m.publish_date)) / 86400000) : 0;
    if (m.v_trend != null && m.v_trend >= 60 && m.v7 >= 80)
      out.push({ type: 'hot', design_id: m.design_id, title: m.title, text: `läuft heiß: Views +${m.v_trend}% ggü. Vorwoche` });
    if (m.v_trend != null && m.v_trend <= -40 && m.v30 >= 200)
      out.push({ type: 'cool', design_id: m.design_id, title: m.title, text: `kühlt ab: Views ${m.v_trend}% ggü. Vorwoche` });
    // Stillstand: 0 Downloads in 30 Tagen, obwohl das Modell sonst regelmaessig geladen wird. Statt fester Schwelle
    // zaehlt die Erwartung aus dem Lebensdurchschnitt: Alarm nur, wenn eine Null dabei unwahrscheinlich ist
    // (Poisson: P(0) = e^-erwartet < 10 % <=> erwartet >= 2,3 Downloads je 30 Tage). Sonst ist die Null normales Rauschen.
    const expected30 = age > 0 ? ((m.download || 0) / age) * 30 : 0;
    if (age > 60 && m.dl30 === 0 && expected30 >= 2.3)
      out.push({ type: 'stall', design_id: m.design_id, title: m.title, text: `keine Downloads in 30 Tagen (üblich: ~${expected30.toFixed(1).replace('.', ',')} je 30 Tage)` });
    if (m.goal_download && m.download != null) {
      const p = m.download / m.goal_download;
      if (p >= 1) out.push({ type: 'goal', design_id: m.design_id, title: m.title, text: `Ziel erreicht: ${m.download}/${m.goal_download} DL` });
      else if (p >= 0.8) out.push({ type: 'goal_near', design_id: m.design_id, title: m.title, text: `nah am Ziel: ${m.download}/${m.goal_download} DL (${Math.round(p*100)}%)` });
    }
  }
  const rank = { hot: 0, goal: 1, cool: 2, stall: 3, goal_near: 4 };
  return out.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));
}

// ---- Notizen / Ziele / Gruppe je Modell -----------------------------------
app.put('/api/model/:id/notes', (req, res) => {
  db.prepare('UPDATE models SET notes=? WHERE design_id=?').run(req.body?.notes ?? '', req.params.id);
  res.json({ ok: true });
});
// nur die eigene Kategorie/Gruppe setzen (ohne Ziele zu ueberschreiben)
app.put('/api/model/:id/group', (req, res) => {
  db.prepare('UPDATE models SET group_label=? WHERE design_id=?').run(req.body?.group_label || null, req.params.id);
  res.json({ ok: true });
});
// Status / Pipeline-Stufe
app.put('/api/model/:id/status', (req, res) => {
  db.prepare('UPDATE models SET status=? WHERE design_id=?').run(req.body?.status || 'live', req.params.id);
  res.json({ ok: true });
});

// Titel / Beschreibung / Tags bearbeiten (v.a. fuer geplante Modelle —
// bei echten werden Beschreibung/Tags beim naechsten Pull von MakerWorld ueberschrieben).
app.put('/api/model/:id/meta', (req, res) => {
  const { title, description, tags } = req.body || {};
  const cur = db.prepare('SELECT * FROM models WHERE design_id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'nicht gefunden' });
  let tagsJson = cur.tags, tagCount = cur.tag_count;
  if (tags !== undefined) {
    const arr = Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()).filter(Boolean);
    tagsJson = arr.length ? JSON.stringify(arr) : null; tagCount = arr.length;
  }
  db.prepare('UPDATE models SET title=?, description=?, tags=?, tag_count=?, updated_at=? WHERE design_id=?')
    .run(title != null ? title : cur.title, description != null ? description : cur.description, tagsJson, tagCount, nowIso(), req.params.id);
  res.json({ ok: true });
});

// ---- Geplante Modelle (noch nicht auf MakerWorld) ------------------------
app.post('/api/products/plan', (req, res) => {
  const { title, status, group_label, notes } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Titel fehlt' });
  const id = 'plan_' + Date.now().toString(36);
  db.prepare(`INSERT INTO models(design_id,title,status,group_label,notes,planned,created_at,updated_at)
              VALUES(?,?,?,?,?,1,?,?)`)
    .run(id, title.trim(), ['idee','arbeit'].includes(status) ? status : 'idee', group_label || null, notes || null, nowIso(), nowIso());
  res.json(db.prepare('SELECT * FROM models WHERE design_id=?').get(id));
});
// nur geplante Modelle loeschbar (schuetzt echte Daten)
app.delete('/api/products/:id', (req, res) => {
  const m = db.prepare('SELECT planned FROM models WHERE design_id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'nicht gefunden' });
  if (!m.planned) return res.status(400).json({ error: 'nur geplante Modelle löschbar' });
  const acc = newAcc();
  addRows(acc, 'models', rowsOf('models', 'design_id=?', req.params.id));
  addRows(acc, 'todos', rowsOf('todos', 'design_id=?', req.params.id));
  addRows(acc, 'events', rowsOf('events', 'design_id=?', req.params.id));
  const trash_id = trashPut('model', rowsOf('models', 'design_id=?', req.params.id)[0]?.title || 'Geplantes Modell', acc);
  db.transaction(() => {
    db.prepare('DELETE FROM todos WHERE design_id=?').run(req.params.id);
    db.prepare('DELETE FROM events WHERE design_id=?').run(req.params.id);
    db.prepare('DELETE FROM models WHERE design_id=?').run(req.params.id);
  })();
  res.json({ ok: true, trash_id });
});

// CTR-Wirkung von Titelbild-/Titel-Aenderungen: Vorher/Nachher-Fenster.
app.get('/api/model/:id/ctr-impact', (req, res) => {
  const id = req.params.id, win = Math.max(3, Math.min(90, +req.query.win || 21));
  const events = db.prepare("SELECT * FROM events WHERE design_id=? AND type IN ('thumbnail','title','tags','description') ORDER BY date").all(id);
  const ctr = o => (o && o.imp) ? +((o.v / o.imp) * 100).toFixed(2) : null;
  const impacts = events.map(ev => {
    const before = db.prepare(`SELECT SUM(impression) imp, SUM(view) v, SUM(download) dl FROM daily_metrics
      WHERE design_id=? AND date < ? AND date >= date(?, '-'||?||' day')`).get(id, ev.date, ev.date, win);
    const after = db.prepare(`SELECT SUM(impression) imp, SUM(view) v, SUM(download) dl FROM daily_metrics
      WHERE design_id=? AND date >= ? AND date < date(?, '+'||?||' day')`).get(id, ev.date, ev.date, win);
    const cb = ctr(before), ca = ctr(after);
    return { id: ev.id, date: ev.date, type: ev.type, title: ev.title,
      before: { imp: before.imp || 0, view: before.v || 0, dl: before.dl || 0, ctr: cb, impPerDay: +(((before.imp || 0) / win)).toFixed(1) },
      after: { imp: after.imp || 0, view: after.v || 0, dl: after.dl || 0, ctr: ca, impPerDay: +(((after.imp || 0) / win)).toFixed(1) },
      delta: (cb != null && ca != null) ? +(ca - cb).toFixed(2) : null };
  });
  res.json({ win, impacts });
});

// ---- Gespeicherte Ansichten / Segmente ------------------------------------
app.get('/api/views', (req, res) => res.json(db.prepare('SELECT * FROM views ORDER BY id').all().map(v => ({ ...v, config: v.config ? JSON.parse(v.config) : {} }))));
app.post('/api/views', (req, res) => {
  const { name, config } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name fehlt' });
  const r = db.prepare('INSERT INTO views(name,config,created_at) VALUES(?,?,?)').run(name, JSON.stringify(config || {}), nowIso());
  res.json(db.prepare('SELECT * FROM views WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/api/views/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM views WHERE id=?').get(req.params.id);
  const trash_id = v ? trashPut('view', v.name, addRows(newAcc(), 'views', [v])) : null;
  db.prepare('DELETE FROM views WHERE id=?').run(req.params.id); res.json({ ok: true, trash_id });
});

app.put('/api/model/:id/goals', (req, res) => {
  const { goal_download, goal_view, goal_point, group_label } = req.body || {};
  db.prepare('UPDATE models SET goal_download=?,goal_view=?,goal_point=?,group_label=? WHERE design_id=?')
    .run(goal_download || null, goal_view || null, goal_point || null, group_label || null, req.params.id);
  res.json({ ok: true });
});

// ---- Todos ----------------------------------------------------------------
app.get('/api/todos', (req, res) => {
  const where = [], args = [];
  if (req.query.design_id) { where.push('t.design_id=?'); args.push(req.query.design_id); }
  if (req.query.contact_id) { where.push('t.contact_id=?'); args.push(req.query.contact_id); }
  if (req.query.project_id) { where.push('t.project_id=?'); args.push(req.query.project_id); }
  if (req.query.done != null) { where.push('t.done=?'); args.push(req.query.done === '1' ? 1 : 0); }
  const sql = `SELECT t.*, m.title AS model_title, c.name AS contact_name, pr.title AS project_title
    FROM todos t LEFT JOIN models m ON m.design_id=t.design_id
    LEFT JOIN contacts c ON c.id=t.contact_id LEFT JOIN projects pr ON pr.id=t.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.done, t.priority DESC, (t.due_date IS NULL), t.due_date, t.id`;
  res.json(db.prepare(sql).all(...args));
});
app.post('/api/todos', (req, res) => {
  const { design_id, contact_id, project_id, title, priority, due_date } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title fehlt' });
  const r = db.prepare('INSERT INTO todos(design_id,contact_id,project_id,title,priority,due_date,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(design_id || null, contact_id || null, project_id || null, title, priority ?? 1, due_date || null, nowIso());
  res.json(db.prepare('SELECT * FROM todos WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/todos/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM todos WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'todo fehlt' });
  const b = req.body || {};
  const done = b.done != null ? (b.done ? 1 : 0) : cur.done;
  db.prepare('UPDATE todos SET title=?,done=?,priority=?,due_date=?,done_at=? WHERE id=?').run(
    b.title ?? cur.title, done, b.priority ?? cur.priority, b.due_date ?? cur.due_date,
    done && !cur.done ? nowIso() : (done ? cur.done_at : null), req.params.id);
  // Ausliefer-Aufgabe abgehakt -> Projekt in die Stufe "ausgeliefert" (nur wenn beglichen).
  if (done && !cur.done && cur.project_id && /^Ausliefern:/.test(cur.title || '')) {
    const pr = db.prepare('SELECT * FROM projects WHERE id=?').get(cur.project_id);
    const settled = pr && (!!pr.paid || pr.margin_tier === 'kostenlos' || (pr.price != null && pr.price <= 0));
    if (pr && settled && pr.stage !== 'ausgeliefert')
      db.prepare('UPDATE projects SET stage=?, close_date=COALESCE(close_date,?) WHERE id=?')
        .run('ausgeliefert', new Date().toISOString().slice(0, 10), cur.project_id);
  }
  res.json(db.prepare('SELECT * FROM todos WHERE id=?').get(req.params.id));
});
app.delete('/api/todos/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM todos WHERE id=?').get(req.params.id);
  const trash_id = t ? trashPut('todo', t.title, addRows(newAcc(), 'todos', [t])) : null;
  db.prepare('DELETE FROM todos WHERE id=?').run(req.params.id); res.json({ ok: true, trash_id });
});

// ---- Papierkorb ---------------------------------------------------------------------------
app.get('/api/trash', (req, res) => { purgeOld(); res.json(trashList()); });
app.post('/api/trash/:id/restore', (req, res) => {
  try { const r = trashRestore(+req.params.id); if (!r) return res.status(404).json({ error: 'Nicht (mehr) im Papierkorb.' }); res.json({ ok: true, ...r }); }
  catch (e) { console.log('[trash] Wiederherstellen fehlgeschlagen:', e.message); res.status(500).json({ error: 'Wiederherstellen fehlgeschlagen: ' + e.message }); }
});
app.delete('/api/trash/:id', (req, res) => res.json({ ok: trashPurge(+req.params.id) }));

// ---- Auswertung nach Gruppe/Kategorie/Tag ---------------------------------
app.get('/api/analytics/groups', (req, res) => {
  const by = ['tag', 'group', 'category'].includes(req.query.by) ? req.query.by : 'category';
  res.json({ by, rows: aggregateGroups(attachMomentum(modelsWithKpis()), by) });
});

// ---- Punkte-Oekonomie -----------------------------------------------------
app.get('/api/analytics/points', (req, res) => {
  const daily = db.prepare(`SELECT date, SUM(point_from_model+point_from_inst+point_from_ratings+point_from_others) p
    FROM daily_metrics GROUP BY date ORDER BY date`).all();
  let cum = 0; const series = daily.map(r => ({ x: r.date, y: (cum += r.p || 0), day: r.p || 0 }));
  const rate = eurRate();
  const perModel = attachMomentum(modelsWithKpis())
    .map(m => ({ design_id: m.design_id, title: m.title, point: m.point || 0, pts30: m.pts30 || 0, boost: m.boost || 0,
      earned: +(((m.point || 0) * rate)).toFixed(2), earned30: +(((m.pts30 || 0) * rate)).toFixed(2) }))
    .sort((a, b) => b.point - a.point);
  const totals = perModel.reduce((a, m) => ({ point: a.point + m.point, pts30: a.pts30 + m.pts30, boost: a.boost + m.boost }), { point: 0, pts30: 0, boost: 0 });
  totals.earned = +(totals.point * rate).toFixed(2); totals.earned30 = +(totals.pts30 * rate).toFixed(2);
  res.json({ series, perModel, totals, rate });
});

// ---- Konto-Verlauf (Portfolio über die Zeit) ------------------------------
app.get('/api/analytics/account', (req, res) => {
  const rows = db.prepare('SELECT * FROM account_snapshots ORDER BY id').all();
  res.json({ history: rows, latest: rows[rows.length - 1] || null, rate: eurRate() });
});

// ---- Pull / Login / Settings -------------------------------------
app.post('/api/pull/start', async (req, res) => res.json(await startPull('manual')));
app.get('/api/pull/status', (req, res) => res.json({
  ...pullState,
  lastRun: db.prepare('SELECT * FROM pull_runs ORDER BY id DESC LIMIT 1').get()
}));
app.post('/api/pull/cancel', async (req, res) => {
  if (!pullState.running) return res.json({ ok: false, reason: 'Es laeuft kein Pull.' });
  pushLog('Abbruch angefordert ...');
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
  public_base_url: getSetting('public_base_url', '')
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
  if (b.public_base_url != null) setSetting('public_base_url', String(b.public_base_url).trim().replace(/\/+$/, ''));
  rescheduleCron(); rescheduleWeekly();
  res.json({ ok: true });
});
// Wochen-Insight-Report als Text (für Push + Vorschau)
function weeklyText() {
  const ins = buildInsights();
  const L = [`MakerWorld Wochen-Report — ${new Date().toLocaleDateString('de-DE')}`];
  ins.forEach(i => L.push(`- ${i.title}: ${i.text}`));
  if (ins.length === 0) L.push('Noch zu wenig Daten für Insights.');
  return L.join('\n');
}
app.get('/api/insights/weekly-text', (req, res) => res.json({ text: weeklyText() }));
app.post('/api/insights/send', async (req, res) => { const text = weeklyText(); const sent = await pushNotify('MakerWorld Wochen-Report', text); res.json({ ok: true, sent, text }); });

// ---- Cron: taeglicher Pull ------------------------------------------------
let cronTask = null;
function rescheduleCron() {
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
function rescheduleWeekly() {
  if (weeklyTask) { weeklyTask.stop(); weeklyTask = null; }
  if (getSetting('weekly_enabled', '0') !== '1') return;
  const [h, m] = getSetting('weekly_time', '08:00').split(':').map(Number);
  const day = +getSetting('weekly_day', '1');
  const expr = `${m || 0} ${h || 8} * * ${day}`;
  weeklyTask = cron.schedule(expr, async () => {
    console.log('[cron] Wochen-Report', new Date().toISOString());
    try { await pushNotify('MakerWorld Wochen-Report', weeklyText()); } catch (e) { console.log(e.message); }
  });
  console.log('[cron] Wochen-Report geplant:', expr);
}

// ---- statische Dateien ----------------------------------------------------
// ---- Systemstatus (Pull, Backup, Speicher) --------------------------------
function memAvailableMb() {
  try { const m = fs.readFileSync(process.env.MEMINFO_FILE || '/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/); return m ? Math.round(+m[1] / 1024) : null; }
  catch { return null; }   // nicht Linux (Entwicklung auf dem Mac)
}
function healthData() {
  const sizeOf = f => { try { return fs.statSync(f).size; } catch { return 0; } };
  const dbFile = path.join(DATA_DIR, 'makerworld.db');
  const dbBytes = sizeOf(dbFile) + sizeOf(dbFile + '-wal');
  let diskFreeGb = null;
  try { const st = fs.statfsSync(DATA_DIR); diskFreeGb = +((st.bavail * st.bsize) / 1e9).toFixed(1); } catch {}
  const lastRun = db.prepare('SELECT id,started_at,finished_at,status,mode,models_ok,models_failed FROM pull_runs ORDER BY id DESC LIMIT 1').get() || null;
  const lastOk = db.prepare("SELECT finished_at FROM pull_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").get();
  const pullAgeH = lastOk?.finished_at ? +((Date.now() - Date.parse(lastOk.finished_at)) / 3600000).toFixed(1) : null;
  const backupDir = process.env.BACKUP_DIR || path.join(os.homedir(), 'backups', 'makerworld');
  let backup = null;
  try {
    const files = fs.readdirSync(backupDir).filter(f => /^makerworld-.*\.db\.gz$/.test(f)).sort();
    if (files.length) { const f = files[files.length - 1], st = fs.statSync(path.join(backupDir, f));
      backup = { file: f, at: st.mtime.toISOString(), ageH: +((Date.now() - st.mtimeMs) / 3600000).toFixed(1), count: files.length, bytes: st.size }; }
  } catch {}
  const memMb = memAvailableMb();
  const issues = [];
  if (lastRun?.status === 'error') issues.push({ level: 'error', text: 'Der letzte Pull ist fehlgeschlagen — Details unter „Daten & Pull".' });
  else if (lastRun?.status === 'running' && !pullState.running) issues.push({ level: 'error', text: 'Ein Pull steht auf „läuft", obwohl keiner aktiv ist (Neustart/Absturz).' });
  if (pullAgeH == null) issues.push({ level: 'warn', text: 'Noch kein erfolgreicher Pull vorhanden.' });
  else if (pullAgeH > 36) issues.push({ level: 'error', text: `Der letzte erfolgreiche Pull ist ${Math.round(pullAgeH)} Stunden her — die Zahlen sind veraltet.` });
  if (!backup) issues.push({ level: 'warn', text: 'Kein Backup gefunden.' });
  else if (backup.ageH > 36) issues.push({ level: 'warn', text: `Das letzte Backup ist ${Math.round(backup.ageH)} Stunden alt.` });
  if (diskFreeGb != null && diskFreeGb < 5) issues.push({ level: 'error', text: `Nur noch ${diskFreeGb} GB Speicherplatz frei.` });
  if (dbBytes > 1e9) issues.push({ level: 'warn', text: `Die Datenbank ist ${(dbBytes / 1e9).toFixed(1)} GB groß (erwartet: wenige MB).` });
  if (memMb != null && memMb < 300) issues.push({ level: 'warn', text: `Wenig freier Arbeitsspeicher (${memMb} MB).` });
  return { dbBytes, diskFreeGb, memAvailableMb: memMb, uptimeH: +(process.uptime() / 3600).toFixed(1), lastRun, pullAgeH, backup, pullRunning: pullState.running, issues };
}
app.get('/api/health', (req, res) => res.json(healthData()));

// ---- Heute-Dashboard (handlungsorientiert) --------------------------------
function todayData() {
  const t = new Date().toISOString().slice(0, 10);
  const models = attachMomentum(modelsWithKpis());
  const alerts = computeAlerts(models);
  const dueTodos = db.prepare(`SELECT td.*, m.title model_title, c.name contact_name, pr.title project_title
    FROM todos td LEFT JOIN models m ON m.design_id=td.design_id LEFT JOIN contacts c ON c.id=td.contact_id
    LEFT JOIN projects pr ON pr.id=td.project_id WHERE td.done=0
    ORDER BY (td.due_date IS NULL), td.due_date, td.priority DESC`).all()
    .map(x => ({ ...x, overdue: x.due_date && x.due_date <= t }));
  const openPayments = db.prepare(`SELECT p.id, p.title, p.price, p.margin_tier, c.name contact_name, c.id contact_id
    FROM projects p JOIN contacts c ON c.id=p.contact_id
    WHERE p.stage='fertig' AND p.paid=0 AND COALESCE(p.margin_tier,'') != 'kostenlos'`).all();
  const recentChanges = db.prepare(`SELECT e.*, m.title model_title FROM events e LEFT JOIN models m ON m.design_id=e.design_id
    WHERE e.created_at >= datetime('now','-3 day') ORDER BY e.id DESC LIMIT 15`).all();
  return { date: t, dueTodos, openPayments, alerts, recentChanges, issues: healthData().issues,
    counts: { due: dueTodos.filter(x => x.overdue).length, todos: dueTodos.length, payments: openPayments.length, alerts: alerts.length } };
}
app.get('/api/today', (req, res) => res.json(todayData()));

// ---- Digest + Push --------------------------------------------------------
function digestText() {
  const d = todayData();
  const L = [`MakerWorld Analytics — ${d.date.split('-').reverse().join('.')}`];
  if (d.openPayments.length) L.push(`\nOffene Zahlungen (${d.openPayments.length}): ` + d.openPayments.map(p => `${p.contact_name}: ${p.title}`).join(', '));
  const overdue = d.dueTodos.filter(x => x.overdue);
  if (overdue.length) L.push(`\nÜberfällige Aufgaben (${overdue.length}): ` + overdue.slice(0, 6).map(t => t.title).join(', '));
  if (d.alerts.length) L.push(`\nAlerts (${d.alerts.length}): ` + d.alerts.slice(0, 5).map(a => `${a.title}: ${a.text}`).join(' · '));
  if (d.recentChanges.length) L.push(`\nÄnderungen (3T): ` + d.recentChanges.slice(0, 6).map(c => `${c.model_title || ''} ${c.type}`).join(', '));
  if (L.length === 1) L.push('\nAlles ruhig — nichts zu tun.');
  return L.join('\n');
}
async function sendDigest() {
  const text = digestText();
  setSetting('last_digest', JSON.stringify({ at: nowIso(), text }));
  const url = getSetting('notify_url', '');
  if (url) { try { await fetch(url, { method: 'POST', headers: { Title: 'MakerWorld Digest', 'Content-Type': 'text/plain; charset=utf-8' }, body: text }); } catch (e) { console.log('[notify] Fehler:', e.message); } }
  return text;
}
app.get('/api/digest', (req, res) => { let last = null; try { last = JSON.parse(getSetting('last_digest', 'null')); } catch {} res.json({ current: digestText(), last }); });
app.post('/api/digest/send', async (req, res) => res.json({ ok: true, text: await sendDigest() }));

// ---- Push-Helfer (ntfy.sh / Webhook) --------------------------------------
async function pushNotify(title, body) {
  const url = getSetting('notify_url', ''); if (!url) return false;
  try { await fetch(url, { method: 'POST', headers: { Title: title, 'Content-Type': 'text/plain; charset=utf-8' }, body }); return true; }
  catch (e) { console.log('[notify]', e.message); return false; }
}

// ---- Meilenstein-Benachrichtigungen ---------------------------------------
const DL_THRESHOLDS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
const deNum = n => Number(n).toLocaleString('de-DE');
function recordMilestone(design_id, kind, threshold, title) {
  try { return db.prepare('INSERT OR IGNORE INTO milestones(design_id,kind,threshold,title,date,created_at) VALUES(?,?,?,?,?,?)')
    .run(design_id, kind, threshold, title, new Date().toISOString().slice(0, 10), nowIso()).changes > 0; }
  catch { return false; }
}
async function checkMilestones() {
  const init = getSetting('milestones_init', '0') !== '1';   // erster Lauf: still verbuchen, nicht pushen
  const msgs = [];
  const models = db.prepare(`SELECT m.design_id, m.title, s.download, s.point FROM models m
    JOIN (${latestSnapSub}) s ON s.design_id=m.design_id WHERE COALESCE(m.planned,0)=0`).all();
  for (const m of models) for (const t of DL_THRESHOLDS)
    if ((m.download || 0) >= t && recordMilestone(m.design_id, 'download', t, `${m.title}: ${t} Downloads`))
      msgs.push(`${m.title}: ${deNum(t)} Downloads erreicht`);
  // "kalt": live, >30 Tage alt, 0 Downloads in 7 Tagen, vorher aktiv
  const cold = db.prepare(`SELECT m.design_id, m.title,
      (SELECT COALESCE(SUM(download),0) FROM daily_metrics d WHERE d.design_id=m.design_id AND d.date>=date('now','-7 day')) d7,
      (SELECT COALESCE(SUM(download),0) FROM daily_metrics d WHERE d.design_id=m.design_id AND d.date<date('now','-7 day') AND d.date>=date('now','-37 day')) d30
    FROM models m WHERE COALESCE(m.planned,0)=0 AND m.publish_date<=date('now','-30 day')`).all();
  for (const c of cold) if (c.d7 === 0 && c.d30 >= 10 && recordMilestone(c.design_id, 'cold', 0, `${c.title} kalt`))
    msgs.push(`${c.title}: 0 Downloads in 7 Tagen (vorher ${c.d30} in 30T)`);
  // Gutschein-Schwellen (524 Punkte = 40 €)
  const acc = db.prepare('SELECT point FROM account_snapshots ORDER BY id DESC LIMIT 1').get();
  if (acc) { const reached = Math.floor((acc.point || 0) / VOUCHER_POINTS);
    for (let k = 1; k <= reached; k++) if (recordMilestone(null, 'voucher', k * VOUCHER_POINTS, `${k * VOUCHER_POINTS} Punkte`))
      msgs.push(`${deNum(k * VOUCHER_POINTS)} Punkte erreicht — ${k}× ${VOUCHER_EUR} € Gutschein möglich`); }
  if (init) { setSetting('milestones_init', '1'); return []; }
  if (msgs.length) await pushNotify('MakerWorld Meilenstein', msgs.join('\n'));
  return msgs;
}
app.get('/api/milestones', (req, res) => res.json(db.prepare('SELECT * FROM milestones ORDER BY id DESC LIMIT 40').all()));
app.post('/api/milestones/check', async (req, res) => res.json({ new: await checkMilestones() }));

// ---- Insights (automatische Erkenntnisse) ---------------------------------
function buildInsights() {
  const rate = eurRate();
  const models = attachForecast(attachMomentum(modelsWithKpis())).filter(m => !m.planned);
  const ins = [];
  const byDl30 = [...models].sort((a, b) => (b.dl30 || 0) - (a.dl30 || 0));
  if (byDl30[0] && byDl30[0].dl30 > 0) ins.push({ kind: 'mover', title: 'Zugpferd (30 T)',
    text: `${byDl30[0].title}: ${deNum(byDl30[0].dl30)} Downloads in 30 Tagen` + (byDl30[0].v_trend != null ? `, Views-Trend ${byDl30[0].v_trend > 0 ? '+' : ''}${byDl30[0].v_trend}%` : ''),
    design_id: byDl30[0].design_id });
  const fallers = models.filter(m => m.v_trend != null && m.v_trend < -15).sort((a, b) => a.v_trend - b.v_trend);
  if (fallers[0]) ins.push({ kind: 'faller', title: 'Verliert an Fahrt',
    text: `${fallers[0].title}: Views ${fallers[0].v_trend}% vs. Vorperiode`, design_id: fallers[0].design_id });
  // hohe Impressions, aber niedrige CTR = Titelbild/Titel-Chance
  const ctrOf = m => m.impression ? (m.view / m.impression) * 100 : null;
  const opp = models.filter(m => (m.impression || 0) > 2000 && ctrOf(m) != null).sort((a, b) => ctrOf(a) - ctrOf(b))[0];
  if (opp && ctrOf(opp) < 6) ins.push({ kind: 'ctr', title: 'CTR-Chance',
    text: `${opp.title}: ${deNum(opp.impression)} Impressionen, aber nur ${ctrOf(opp).toFixed(1)}% CTR — Titelbild/Titel testen`, design_id: opp.design_id });
  const earner = [...models].sort((a, b) => (b.earned || 0) - (a.earned || 0))[0];
  if (earner && earner.earned > 0) ins.push({ kind: 'earner', title: 'Top-Verdiener',
    text: `${earner.title}: ${earner.earned.toFixed(2)} € (gesamt)`, design_id: earner.design_id });
  // Gutschein-ETA
  const acc = db.prepare('SELECT point FROM account_snapshots ORDER BY id DESC LIMIT 1').get();
  if (acc) { const v = voucherStatus(acc.point, models.reduce((s, m) => s + (m.proj_pts30 || 0), 0) / 30);
    ins.push({ kind: 'voucher', title: 'Nächster Gutschein',
      text: `Noch ${deNum(v.remaining)} Punkte bis ${VOUCHER_EUR} €` + (v.etaDays ? ` — bei ~${v.perDay.toFixed(1)} P/Tag (Trend) in ~${v.etaDays} Tagen` : '') });
  }
  // Bester Hashtag (Durchschnitt Views je Modell, mind. 2 Modelle)
  const tags = aggregateGroups(models, 'tag').filter(t => t.key !== '—' && t.count >= 2).map(t => ({ tag: t.key, n: t.count, avg: t.view / t.count })).sort((a, b) => b.avg - a.avg);
  if (tags.length >= 2) ins.push({ kind: 'tag', title: 'Bester Hashtag',
    text: `„${tags[0].tag}" bringt im Schnitt ${deNum(Math.round(tags[0].avg))} Views/Modell (${tags[0].n}×)` });
  return ins;
}
app.get('/api/insights', (req, res) => res.json({ insights: buildInsights(), date: new Date().toISOString().slice(0, 10) }));

// ---- Änderungswirkung aggregiert (über alle Modelle) ----------------------
app.get('/api/analytics/change-impact', (req, res) => {
  const win = Math.max(3, Math.min(90, +req.query.win || 21));
  const evs = db.prepare("SELECT * FROM events WHERE type IN ('thumbnail','title','tags','description')").all();
  const ctr = o => (o && o.imp) ? (o.v / o.imp) * 100 : null;
  const agg = {};
  let measured = 0;
  for (const ev of evs) {
    const before = db.prepare(`SELECT SUM(impression) imp, SUM(view) v, SUM(download) dl FROM daily_metrics
      WHERE design_id=? AND date<? AND date>=date(?, '-'||?||' day')`).get(ev.design_id, ev.date, ev.date, win);
    const after = db.prepare(`SELECT SUM(impression) imp, SUM(view) v, SUM(download) dl FROM daily_metrics
      WHERE design_id=? AND date>=? AND date<date(?, '+'||?||' day')`).get(ev.design_id, ev.date, ev.date, win);
    const cb = ctr(before), ca = ctr(after);
    const e = agg[ev.type] || (agg[ev.type] = { type: ev.type, n: 0, ctrDelta: 0, ctrN: 0, up: 0, dlBefore: 0, dlAfter: 0 });
    e.n++;
    if (cb != null && ca != null) { e.ctrDelta += (ca - cb); e.ctrN++; if (ca > cb) e.up++; measured++; }
    e.dlBefore += before.dl || 0; e.dlAfter += after.dl || 0;
  }
  const TL = { thumbnail: 'Titelbild', title: 'Titel', tags: 'Tags', description: 'Beschreibung' };
  const rows = Object.values(agg).map(e => ({ type: e.type, label: TL[e.type] || e.type, count: e.n,
    avgCtrDelta: e.ctrN ? +(e.ctrDelta / e.ctrN).toFixed(2) : null, winRate: e.ctrN ? Math.round((e.up / e.ctrN) * 100) : null,
    dlBefore: e.dlBefore, dlAfter: e.dlAfter, dlChangePct: e.dlBefore ? Math.round(((e.dlAfter - e.dlBefore) / e.dlBefore) * 100) : null }))
    .sort((a, b) => (b.avgCtrDelta ?? -99) - (a.avgCtrDelta ?? -99));
  res.json({ win, rows, totalEvents: evs.length, measured });
});

// ---- Globale Suche --------------------------------------------------------
app.get('/api/search', (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (raw.length < 3) return res.json({ models: [], contacts: [], projects: [] });
  const q = '%' + raw.replace(/[\\%_]/g, '\\$&') + '%';   // %, _ und \ im Suchtext wie normale Zeichen behandeln
  res.json({
    models: db.prepare("SELECT design_id, title FROM models WHERE COALESCE(planned,0)=0 AND title LIKE ? ESCAPE '\\' LIMIT 8").all(q),
    contacts: db.prepare(`SELECT id, name, source FROM contacts WHERE name LIKE ? ESCAPE '\\' OR mw_handle LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' LIMIT 8`).all(q, q, q),
    projects: db.prepare(`SELECT p.id, p.title, COALESCE(c.name, 'Eigenprojekt') contact_name FROM projects p LEFT JOIN contacts c ON c.id=p.contact_id
      WHERE p.title LIKE ? ESCAPE '\\' LIMIT 8`).all(q)
  });
});

// ---- Punkte-Matrix (Reverse-Engineering des Punktesystems) ----------------
// Nutzt die Tages-Deltas (daily_metrics): MakerWorld liefert selbst die Herkunft
// der Punkte (Modell/Profil/Bewertungen/Sonstige). Daraus schaetzen wir per
// Regression durch den Ursprung die Rate "Punkte je Download" / "je Druck" und
// prognostizieren kuenftige Punkte. Wird mit mehr Tagesdaten automatisch genauer.
app.get('/api/analytics/points-matrix', (req, res) => {
  const rows = db.prepare(`SELECT design_id, date, download dl, print pr, boost bo,
      point_from_model pfm, point_from_inst pfi, point_from_ratings pfr, point_from_others pfo,
      (point_from_model+point_from_inst+point_from_ratings+point_from_others) pts
    FROM daily_metrics ORDER BY design_id, date`).all();
  const slopeOrigin = (xs, ys) => { let sxy = 0, sxx = 0; for (let i = 0; i < xs.length; i++) { sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; } return sxx ? sxy / sxx : 0; };
  const corr = (xs, ys) => { const n = xs.length; if (n < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
    return (sxx && syy) ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : null; };
  const dls = rows.map(r => r.dl), prs = rows.map(r => r.pr), pfm = rows.map(r => r.pfm), pfi = rows.map(r => r.pfi);
  const perDownload = +slopeOrigin(dls, pfm).toFixed(4);
  const perPrint = +slopeOrigin(prs, pfi).toFixed(4);
  const T = rows.reduce((a, r) => { a.pfm += r.pfm; a.pfi += r.pfi; a.pfr += r.pfr; a.pfo += r.pfo; a.pts += r.pts; a.dl += r.dl; a.pr += r.pr; return a; },
    { pfm: 0, pfi: 0, pfr: 0, pfo: 0, pts: 0, dl: 0, pr: 0 });
  // Punkte-Tage je Modell -> Abstände + Prognose (aus 30-Tage-Aktivität)
  const pointDays = {}; for (const r of rows) if (r.pts > 0) (pointDays[r.design_id] = pointDays[r.design_id] || []).push(r.date);
  const recent = {}; for (const r of db.prepare(`SELECT design_id, SUM(download) dl, SUM(print) pr FROM daily_metrics WHERE date>=date('now','-30 day') GROUP BY design_id`).all()) recent[r.design_id] = r;
  const titles = Object.fromEntries(db.prepare('SELECT design_id,title FROM models').all().map(m => [m.design_id, m.title]));
  const today = Date.now();
  const byModel = Object.entries(pointDays).map(([id, ds]) => {
    ds.sort(); const gaps = []; for (let i = 1; i < ds.length; i++) gaps.push((Date.parse(ds[i]) - Date.parse(ds[i - 1])) / 86400000);
    const avgGap = gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : null;
    const last = ds[ds.length - 1]; const daysSince = Math.round((today - Date.parse(last)) / 86400000);
    const rc = recent[id] || { dl: 0, pr: 0 };
    const pred30 = +((rc.dl * perDownload) + (rc.pr * perPrint)).toFixed(1);   // ~naechste 30 Tage bei gleicher Aktivitaet
    return { design_id: id, title: titles[id] || id, events: ds.length, avgGap, lastDate: last, daysSince, pred30 };
  }).sort((a, b) => b.pred30 - a.pred30 || a.daysSince - b.daysSince);
  const rate = eurRate();
  const predTotal = +byModel.reduce((a, m) => a + (m.pred30 || 0), 0).toFixed(1);
  res.json({
    perDownload, perPrint, eurPerPoint: rate,
    shares: { model: T.pfm, inst: T.pfi, ratings: T.pfr, others: T.pfo, total: T.pts },
    fit: { downloadCorr: corr(dls, pfm), printCorr: corr(prs, pfi), samples: rows.length },
    byModel, predTotal, predTotalEur: +(predTotal * rate).toFixed(2)
  });
});

// ---- Öffentlicher Read-only-Statuslink für ein Projekt --------------------
// (Nach außen erreichbar über den isolierten Server public.js; hier lokal fürs Testen.)
app.get('/p/:token', (req, res) => { const r = renderStatus(req.params.token); res.status(r.code).type('html').send(r.html); });
app.get('/p/:token/file', (req, res) => {
  const f = projectFileByToken(req.params.token); if (!f) return res.status(404).send('Keine Datei.');
  const abs = path.join(DATA_DIR, f.rel); if (!fs.existsSync(abs)) return res.status(404).send('Keine Datei.');
  res.setHeader('Content-Disposition', 'attachment; filename="' + f.name.replace(/["\r\n]/g, '') + '"');
  res.setHeader('Content-Type', 'model/3mf'); fs.createReadStream(abs).pipe(res);
});

app.use('/data/images', express.static(path.join(DATA_DIR, 'images')));
// Kein Caching fuer die App-Dateien, damit Updates sofort ankommen (Safari cached sonst app.js/css).
app.use('/', express.static(path.join(ROOT, 'web'), { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));

// Fehler der API als JSON (Frontend zeigt den Banner), nie Stacktraces im HTML.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooBig = err.type === 'entity.too.large', bad = err.type === 'entity.parse.failed';
  if (!tooBig && !bad) console.log('[error]', req.method, req.url, err.message);
  res.status(tooBig ? 413 : bad ? 400 : 500).json({ error: tooBig ? 'Anfrage zu groß.' : bad ? 'Ungültige Anfrage (JSON).' : 'Interner Fehler.' });
});

const PORT = process.env.PORT || 4000;
purgeOld();   // Papierkorb: Eintraege aelter als 30 Tage endgueltig entfernen
closeStaleRuns('Dienst neu gestartet');   // beim Start kann kein Pull laufen
rescheduleCron();
rescheduleWeekly();
app.listen(PORT, () => console.log(`MakerWorld-Analytics laeuft:  http://localhost:${PORT}`));
