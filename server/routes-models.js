// Modelle: Uebersicht, Detail, Verlauf, Ereignisse, Notizen/Ziele/Gruppe, geplante Modelle, Ansichten, Todos, Papierkorb.
import express from 'express';
import { db, getSetting, nowIso } from './db.js';
import { T } from './i18n.js';
import { trashPut, trashRestore, trashPurge, trashList, purgeOld, newAcc, addRows, rowsOf } from './trash.js';
import { isAutoDeliver } from './crm.js';
import { modelsWithKpis, attachMomentum, attachForecast, voucherStatus, groupKeysOf, eurRate } from './kpi.js';

const app = express.Router();
export const router = app;


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
  if (!model) return res.status(404).json({ error: T('unbekanntes Modell', 'unknown model') });
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
  const crmProjects = db.prepare(`SELECT p.id, p.title, p.stage, p.price, p.self, COALESCE(c.name, 'Eigenprojekt') contact_name, c.id contact_id
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
const evalDays = v => { v = +v; return Number.isFinite(v) && v >= 7 && v <= 60 ? Math.round(v) : null; };
app.get('/api/events', (req, res) => {
  const rows = req.query.design_id
    ? db.prepare('SELECT * FROM events WHERE design_id=? ORDER BY date DESC, id DESC').all(req.query.design_id)
    : db.prepare('SELECT * FROM events ORDER BY date DESC, id DESC').all();
  res.json(rows);
});
app.post('/api/events', (req, res) => {
  const { design_id, date, type, title, note, hypothesis, eval_days } = req.body || {};
  if (!date) return res.status(400).json({ error: T('Datum fehlt', 'date missing') });
  const r = db.prepare(`INSERT INTO events(design_id,date,type,title,note,hypothesis,eval_days,created_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(design_id || null, date, type || 'other', title || '', note || '', String(hypothesis || '').trim() || null, evalDays(eval_days), nowIso());
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/events/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: T('Nicht gefunden', 'Not found') });
  const b = req.body || {}, has = k => b[k] !== undefined;
  // Hypothese/Frist aendern setzt das Urteil zurueck, damit das Experiment neu ausgewertet und gemeldet wird.
  const reset = has('hypothesis') || has('eval_days') || has('date');
  db.prepare('UPDATE events SET date=?,type=?,title=?,note=?,hypothesis=?,eval_days=?,verdict=?,evaluated_at=? WHERE id=?')
    .run(has('date') ? b.date : old.date, has('type') ? b.type : old.type, has('title') ? b.title : old.title, has('note') ? b.note : old.note,
      has('hypothesis') ? (String(b.hypothesis || '').trim() || null) : old.hypothesis, has('eval_days') ? evalDays(b.eval_days) : old.eval_days,
      reset ? null : old.verdict, reset ? null : old.evaluated_at, req.params.id);
  res.json(db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id));
});
app.delete('/api/events/:id', (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  const trash_id = ev ? trashPut('event', ev.title || ev.type || 'Änderung', addRows(newAcc(), 'events', [ev])) : null;
  db.prepare('DELETE FROM events WHERE id=?').run(req.params.id);
  res.json({ ok: true, trash_id });
});

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
  if (!cur) return res.status(404).json({ error: T('nicht gefunden', 'not found') });
  let tagsJson = cur.tags, tagCount = cur.tag_count;
  if (tags !== undefined) {
    const arr = Array.isArray(tags) ? tags : String(tags).split(',').map(t => t.trim()).filter(Boolean);
    tagsJson = arr.length ? JSON.stringify(arr) : null; tagCount = arr.length;
  }
  db.prepare('UPDATE models SET title=?, description=?, tags=?, tag_count=?, updated_at=? WHERE design_id=?')
    .run(title != null ? title : cur.title, description != null ? description : cur.description, tagsJson, tagCount, nowIso(), req.params.id);
  if (title != null && cur.planned && title !== cur.title) db.prepare('UPDATE projects SET title=? WHERE design_id=? AND self=1').run(title, req.params.id);   // Eigenprojekt traegt denselben Titel
  res.json({ ok: true });
});

// ---- Geplante Modelle (noch nicht auf MakerWorld) ------------------------
app.post('/api/products/plan', (req, res) => {
  const { title, status, group_label, notes } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: T('Titel fehlt', 'title missing') });
  const id = 'plan_' + Date.now().toString(36);
  db.prepare(`INSERT INTO models(design_id,title,status,group_label,notes,planned,created_at,updated_at)
              VALUES(?,?,?,?,?,1,?,?)`)
    .run(id, title.trim(), ['idee','arbeit'].includes(status) ? status : 'idee', group_label || null, notes || null, nowIso(), nowIso());
  res.json(db.prepare('SELECT * FROM models WHERE design_id=?').get(id));
});
// nur geplante Modelle loeschbar (schuetzt echte Daten)
app.delete('/api/products/:id', (req, res) => {
  const m = db.prepare('SELECT planned FROM models WHERE design_id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: T('nicht gefunden', 'not found') });
  if (!m.planned) return res.status(400).json({ error: T('nur geplante Modelle löschbar', 'only planned models can be deleted') });
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
  if (!name) return res.status(400).json({ error: T('Name fehlt', 'name missing') });
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
  if (!title) return res.status(400).json({ error: T('Titel fehlt', 'title missing') });
  const r = db.prepare('INSERT INTO todos(design_id,contact_id,project_id,title,priority,due_date,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(design_id || null, contact_id || null, project_id || null, title, priority ?? 1, due_date || null, nowIso());
  res.json(db.prepare('SELECT * FROM todos WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/todos/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM todos WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: T('Aufgabe nicht gefunden', 'task not found') });
  const b = req.body || {};
  const done = b.done != null ? (b.done ? 1 : 0) : cur.done;
  db.prepare('UPDATE todos SET title=?,done=?,priority=?,due_date=?,done_at=? WHERE id=?').run(
    b.title ?? cur.title, done, b.priority ?? cur.priority, b.due_date ?? cur.due_date,
    done && !cur.done ? nowIso() : (done ? cur.done_at : null), req.params.id);
  // Ausliefer-Aufgabe abgehakt -> Projekt in die Stufe "ausgeliefert" (nur wenn beglichen).
  if (done && !cur.done && cur.project_id && isAutoDeliver(cur.title)) {
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
  try { const r = trashRestore(+req.params.id); if (!r) return res.status(404).json({ error: T('Nicht (mehr) im Papierkorb.', 'Not (or no longer) in the trash.') }); res.json({ ok: true, ...r }); }
  catch (e) { console.log('[trash] Wiederherstellen fehlgeschlagen:', e.message); res.status(500).json({ error: T('Wiederherstellen fehlgeschlagen: ', 'Restore failed: ') + e.message }); }
});
app.delete('/api/trash/:id', (req, res) => res.json({ ok: trashPurge(+req.params.id) }));

