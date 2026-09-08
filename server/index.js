// Express-Server: REST-API + statisches Frontend + Tages-Scheduler.
import express from 'express';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import { db, DATA_DIR, getSetting, setSetting, nowIso } from './db.js';
import { importExport } from './importer.js';
import { writeModel, startRun, finishRun } from './ingest.js';
import { crm } from './crm.js';
import { renderStatus, projectFileByToken } from './publicPage.js';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const app = express();
app.use(express.json({ limit: '80mb' }));
app.use(express.urlencoded({ limit: '80mb', extended: true }));
app.use('/api', crm);

// ---- Pull-Status (eine Instanz gleichzeitig) ------------------------------
const pullState = { running: false, mode: null, startedAt: null, log: [], lastResult: null };
function pushLog(m) { pullState.log.push(m); if (pullState.log.length > 500) pullState.log.shift(); }

async function startPull(mode) {
  if (pullState.running) return { started: false, reason: 'Ein Pull laeuft bereits.' };
  pullState.running = true; pullState.mode = mode; pullState.startedAt = nowIso(); pullState.log = [];
  pushLog(`Pull gestartet (${mode}) ...`);
  (async () => {
    try {
      const { runPull } = await import('./scraper.js');   // lazy: Server startet auch ohne Playwright
      const res = await runPull({ mode, onLog: pushLog });
      pullState.lastResult = { ok: true, ...res, at: nowIso() };
      try { await checkMilestones(); } catch (e) { pushLog('Meilenstein-Check: ' + e.message); }
      try { await sendDigest('pull'); } catch {}   // Digest/Push nach erfolgreichem Pull
    } catch (e) {
      pushLog('Fehler: ' + e.message);
      pullState.lastResult = { ok: false, error: e.message, at: nowIso() };
    } finally { pullState.running = false; }
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
           s.point, s.boost, s.ctr_pct, s.rating_avg, s.rating_count, s.like_count, s.collect_count,
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

const DEFAULT_RATE = 40 / 524;   // 524 Punkte = 40 EUR-Gutschein
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
  const perDayPts = totals.proj_pts30 / 30;
  const remain = Math.max(0, 524 - (walletPts % 524));
  totals.voucher_remaining = Math.round(remain);
  totals.voucher_eta_days = perDayPts > 0 ? Math.ceil(remain / perDayPts) : null;
  totals.wallet_point = account?.point ?? null;
  totals.wallet_eur = account?.wallet_eur ?? null;
  const lastPull = db.prepare('SELECT * FROM pull_runs ORDER BY id DESC LIMIT 1').get();
  const openTodos = db.prepare('SELECT COUNT(*) c FROM todos WHERE done=0').get().c;
  const planned = db.prepare('SELECT * FROM models WHERE planned=1 ORDER BY rowid DESC').all();
  res.json({
    handle: getSetting('handle', '@you'),
    models, totals, account, count: models.length, lastPull, openTodos, planned, alerts: computeAlerts(models),
    settings: {
      schedule_time: getSetting('schedule_time', '03:00'),
      schedule_enabled: getSetting('schedule_enabled', '0') === '1',
      start_date: getSetting('start_date', '2023-01-01'),
      eur_per_point: eurRate()
    }
  });
});

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
  const todos = db.prepare('SELECT * FROM todos WHERE design_id=? ORDER BY done, priority DESC, id').all(id);
  const instances = db.prepare('SELECT * FROM instances WHERE design_id=? ORDER BY is_default DESC, download_count DESC').all(id)
    .map(x => ({ ...x, rating_avg: x.rating_count ? +(x.rating_score_total / x.rating_count).toFixed(2) : null,
      print_min: x.prediction ? Math.round(x.prediction / 60) : null }));
  const crmOrders = db.prepare(`SELECT o.*, (o.qty*o.unit_price) amount, c.name contact_name, c.id contact_id
    FROM orders o JOIN contacts c ON c.id=o.contact_id WHERE o.design_id=? ORDER BY o.order_date DESC`).all(id);
  const crmProjects = db.prepare(`SELECT p.id, p.title, p.stage, p.price, c.name contact_name, c.id contact_id
    FROM projects p JOIN contacts c ON c.id=p.contact_id WHERE p.design_id=? ORDER BY p.id DESC`).all(id);
  res.json({ model: { ...model, tags: model.tags ? JSON.parse(model.tags) : [] }, snaps, daily, traffic, events, images, todos, instances, crmOrders, crmProjects });
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
    const all = db.prepare('SELECT design_id, category, group_label, tags FROM models').all();
    const map = {};
    for (const m of all) {
      let keys;
      if (group === 'tag') keys = m.tags ? JSON.parse(m.tags) : [];
      else keys = [(group === 'group' ? m.group_label : m.category) || '—'];
      for (const k of (keys.length ? keys : ['—'])) (map[k] = map[k] || []).push(m.design_id);
    }
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
  db.prepare('DELETE FROM events WHERE id=?').run(req.params.id);
  res.json({ ok: true });
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
    if (age > 60 && m.dl30 === 0 && (m.download || 0) > 0)
      out.push({ type: 'stall', design_id: m.design_id, title: m.title, text: 'keine Downloads in 30 Tagen' });
    if (m.goal_download && m.download != null) {
      const p = m.download / m.goal_download;
      if (p >= 1) out.push({ type: 'goal', design_id: m.design_id, title: m.title, text: `Ziel erreicht: ${m.download}/${m.goal_download} DL` });
      else if (p >= 0.8) out.push({ type: 'goal_near', design_id: m.design_id, title: m.title, text: `nah am Ziel: ${m.download}/${m.goal_download} DL (${Math.round(p*100)}%)` });
    }
  }
  const rank = { hot: 0, goal: 1, cool: 2, stall: 3, goal_near: 4 };
  return out.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));
}
app.get('/api/analytics/alerts', (req, res) => res.json(computeAlerts(attachMomentum(modelsWithKpis()))));

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

// Titel / Beschreibung / Tags bearbeiten (v.a. fuer geplante Produkte —
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

// ---- Geplante Produkte (noch nicht auf MakerWorld) ------------------------
app.post('/api/products/plan', (req, res) => {
  const { title, status, group_label, notes } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Titel fehlt' });
  const id = 'plan_' + Date.now().toString(36);
  db.prepare(`INSERT INTO models(design_id,title,status,group_label,notes,planned,created_at,updated_at)
              VALUES(?,?,?,?,?,1,?,?)`)
    .run(id, title.trim(), ['idee','arbeit'].includes(status) ? status : 'idee', group_label || null, notes || null, nowIso(), nowIso());
  res.json(db.prepare('SELECT * FROM models WHERE design_id=?').get(id));
});
// nur geplante Produkte loeschbar (schuetzt echte Daten)
app.delete('/api/products/:id', (req, res) => {
  const m = db.prepare('SELECT planned FROM models WHERE design_id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'nicht gefunden' });
  if (!m.planned) return res.status(400).json({ error: 'nur geplante Produkte löschbar' });
  db.transaction(() => {
    db.prepare('DELETE FROM todos WHERE design_id=?').run(req.params.id);
    db.prepare('DELETE FROM events WHERE design_id=?').run(req.params.id);
    db.prepare('DELETE FROM models WHERE design_id=?').run(req.params.id);
  })();
  res.json({ ok: true });
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
app.delete('/api/views/:id', (req, res) => { db.prepare('DELETE FROM views WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---- Portfolio-Prognose (Basis: letzte 30 Tage) ---------------------------
app.get('/api/analytics/forecast', (req, res) => {
  const rate = eurRate();
  const models = attachMomentum(modelsWithKpis());
  const dl30 = models.reduce((s, m) => s + (m.dl30 || 0), 0);
  const v30 = models.reduce((s, m) => s + (m.v30 || 0), 0);
  const pts30 = models.reduce((s, m) => s + (m.pts30 || 0), 0);
  const proj = base => ({ d30: Math.round(base), d90: Math.round(base * 3) });
  res.json({ basis: 'letzte 30 Tage', downloads: proj(dl30), views: proj(v30), points: proj(pts30),
    euro: { d30: +((pts30) * rate).toFixed(2), d90: +((pts30 * 3) * rate).toFixed(2) } });
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
  res.json(db.prepare('SELECT * FROM todos WHERE id=?').get(req.params.id));
});
app.delete('/api/todos/:id', (req, res) => { db.prepare('DELETE FROM todos WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---- Auswertung nach Gruppe/Kategorie/Tag ---------------------------------
app.get('/api/analytics/groups', (req, res) => {
  const by = String(req.query.by || 'category');
  const models = attachMomentum(modelsWithKpis());
  const buckets = {};
  const add = (key, m) => {
    key = key || '—';
    const b = buckets[key] || (buckets[key] = { key, count: 0, view: 0, impression: 0, download: 0, print: 0, collect: 0, like: 0, point: 0, boost: 0, dl30: 0, v30: 0 });
    b.count++; for (const k of ['view','impression','download','print','collect','like','point','boost','dl30','v30']) b[k] += (m[k] || 0);
  };
  for (const m of models) {
    if (by === 'tag') { const tags = m.tags ? JSON.parse(m.tags) : []; if (!tags.length) add('—', m); else for (const t of tags) add(t, m); }
    else add(by === 'group' ? m.group_label : m.category, m);
  }
  const rows = Object.values(buckets).map(b => ({ ...b, ctr: b.impression ? +((b.view / b.impression) * 100).toFixed(2) : null }))
    .sort((a, b) => b.download - a.download);
  res.json({ by, rows });
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

// ---- Browser-Ingest (Daten aus dem eingeloggten Tab via Formular-POST) -----
let lastIngest = null;
async function ingestPayload(payload, mode) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const capturedAt = nowIso();
  const { runId } = startRun(mode);
  let ok = 0, failed = 0; const lines = [];
  if (payload?.handle) setSetting('handle', payload.handle.startsWith('@') ? payload.handle : '@' + payload.handle);
  for (const m of models) {
    try { const r = await writeModel({ id: String(m.id), pp: m.pp, detail: m.detail || {}, capturedAt }); ok++;
      lines.push(`${r.title} — ${r.days} Tage, ${r.tags} Tags, ${r.images} Bilder`); }
    catch (e) { failed++; lines.push(`FEHLER ${m.id}: ${e.message}`); }
  }
  finishRun(runId, { ok, failed, log: lines.join('\n'), status: 'ok' });
  lastIngest = { at: capturedAt, ok, failed };
  return { ok, failed, count: models.length };
}

// erlaubt (per CSP form-action) den POST aus dem MakerWorld-Tab
app.post('/api/ingest', async (req, res) => {
  const isForm = typeof req.body?.payload === 'string';
  let payload;
  try { payload = isForm ? JSON.parse(req.body.payload) : req.body; }
  catch { return res.status(400).send('payload nicht lesbar'); }
  try {
    const r = await ingestPayload(payload, isForm ? 'browser' : 'api');
    if (isForm) {
      // Dank Formular-Navigation ist der Tab jetzt auf localhost – zurück zum Dashboard.
      return res.send(`<!doctype html><meta charset=utf-8>
        <title>Import ok</title>
        <style>body{font:16px system-ui;background:#0e1116;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}
        .c{text-align:center}.b{background:#0b8457;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;margin-top:16px}</style>
        <div class=c><h1>✓ ${r.ok} Modelle importiert</h1>
        <p>${r.failed ? r.failed + ' übersprungen. ' : ''}Du kannst das MakerWorld-Tab wieder schließen.</p>
        <a class=b href="/">Zum Dashboard →</a></div>`);
    }
    res.json({ ok: true, ...r });
  } catch (e) {
    if (isForm) return res.status(500).send('Fehler: ' + e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/ingest/status', (req, res) => res.json({ lastIngest,
  lastRun: db.prepare('SELECT * FROM pull_runs ORDER BY id DESC LIMIT 1').get() }));

// ---- Pull / Login / Import / Settings -------------------------------------
app.post('/api/pull/start', async (req, res) => res.json(await startPull('manual')));
app.get('/api/pull/status', (req, res) => res.json({
  ...pullState,
  lastRun: db.prepare('SELECT * FROM pull_runs ORDER BY id DESC LIMIT 1').get()
}));

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

app.post('/api/import', (req, res) => {
  try { res.json({ ok: true, ...importExport(req.body?.dir || undefined) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

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
  return { date: t, dueTodos, openPayments, alerts, recentChanges,
    counts: { due: dueTodos.filter(x => x.overdue).length, todos: dueTodos.length, payments: openPayments.length, alerts: alerts.length } };
}
app.get('/api/today', (req, res) => res.json(todayData()));

// ---- Digest + Push --------------------------------------------------------
function digestText() {
  const d = todayData();
  const L = [`MakerWorld Analytics — ${d.date}`];
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
  if (acc) { const reached = Math.floor((acc.point || 0) / 524);
    for (let k = 1; k <= reached; k++) if (recordMilestone(null, 'voucher', k * 524, `${k * 524} Punkte`))
      msgs.push(`${deNum(k * 524)} Punkte erreicht — ${k}× 40 € Gutschein möglich`); }
  if (init) { setSetting('milestones_init', '1'); return []; }
  if (msgs.length) await pushNotify('MakerWorld Meilenstein', msgs.join('\n'));
  return msgs;
}
app.get('/api/milestones', (req, res) => res.json(db.prepare('SELECT * FROM milestones ORDER BY id DESC LIMIT 40').all()));
app.post('/api/milestones/check', async (req, res) => res.json({ new: await checkMilestones() }));

// ---- Insights (automatische Erkenntnisse) ---------------------------------
function buildInsights() {
  const rate = eurRate();
  const models = attachMomentum(modelsWithKpis()).filter(m => !m.planned);
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
    text: `${earner.title}: ${earner.earned.toFixed(2)} € (Lifetime)`, design_id: earner.design_id });
  // Gutschein-ETA
  const acc = db.prepare('SELECT point FROM account_snapshots ORDER BY id DESC LIMIT 1').get();
  const pts30 = models.reduce((s, m) => s + (m.pts30 || 0), 0);
  if (acc) { const toNext = 524 - ((acc.point || 0) % 524); const perDay = pts30 / 30;
    const eta = perDay > 0 ? Math.ceil(toNext / perDay) : null;
    ins.push({ kind: 'voucher', title: 'Nächster Gutschein',
      text: `Noch ${deNum(Math.round(toNext))} Punkte bis 40 €` + (eta ? ` — bei ${perDay.toFixed(1)} P/Tag in ~${eta} Tagen` : '') });
  }
  // Tag-Tipp
  const tagMap = {};
  for (const m of models) { const tags = m.tags ? JSON.parse(m.tags) : [];
    for (const tg of tags) { const e = tagMap[tg] || (tagMap[tg] = { tag: tg, n: 0, v: 0 }); e.n++; e.v += m.view || 0; } }
  const tags = Object.values(tagMap).filter(t => t.n >= 2).map(t => ({ ...t, avg: t.v / t.n })).sort((a, b) => b.avg - a.avg);
  if (tags.length >= 2) ins.push({ kind: 'tag', title: 'Stärkster Tag',
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
  const q = '%' + String(req.query.q || '').trim() + '%';
  if (q.length < 3) return res.json({ models: [], contacts: [], projects: [] });
  res.json({
    models: db.prepare("SELECT design_id, title FROM models WHERE COALESCE(planned,0)=0 AND title LIKE ? LIMIT 8").all(q),
    contacts: db.prepare('SELECT id, name, source FROM contacts WHERE name LIKE ? OR mw_handle LIKE ? OR email LIKE ? LIMIT 8').all(q, q, q),
    projects: db.prepare(`SELECT p.id, p.title, c.name contact_name FROM projects p JOIN contacts c ON c.id=p.contact_id
      WHERE p.title LIKE ? LIMIT 8`).all(q)
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

// ---- Tag-Empfehlungen (welche Tags bringen Reichweite) --------------------
app.get('/api/analytics/tag-perf', (req, res) => {
  const rows = attachMomentum(modelsWithKpis());
  const map = {};
  for (const m of rows) { const tags = m.tags ? JSON.parse(m.tags) : [];
    for (const tg of tags) { const e = map[tg] || (map[tg] = { tag: tg, models: 0, views: 0, downloads: 0, points: 0 });
      e.models++; e.views += m.view || 0; e.downloads += m.download || 0; e.points += m.point || 0; } }
  const list = Object.values(map).map(e => ({ ...e, viewsPerModel: Math.round(e.views / e.models), dlPerModel: +(e.downloads / e.models).toFixed(1) }))
    .sort((a, b) => b.viewsPerModel - a.viewsPerModel);
  res.json({ tags: list, modelCount: rows.length });
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

const PORT = process.env.PORT || 4000;
rescheduleCron();
rescheduleWeekly();
app.listen(PORT, () => console.log(`MakerWorld-Analytics laeuft:  http://localhost:${PORT}`));
