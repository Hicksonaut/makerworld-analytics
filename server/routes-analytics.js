// Auswertungen: Gruppen, Punkte, Konto, Aenderungswirkung, Suche, Punkte-Matrix.
import express from 'express';
import { db } from './db.js';
import { T } from './i18n.js';
import { modelsWithKpis, attachMomentum, aggregateGroups, eurRate } from './kpi.js';

const app = express.Router();
export const router = app;

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
  const TL = { thumbnail: T('Titelbild', 'Cover image'), title: T('Titel', 'Title'), tags: 'Tags', description: T('Beschreibung', 'Description') };
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
