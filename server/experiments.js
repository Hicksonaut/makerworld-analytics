// Experimente: jede Aenderung an Titelbild/Titel/Tags/Beschreibung wird als Vorher/Nachher-Test ausgewertet.
// Urteil per Zwei-Anteile-z-Test auf die CTR (Aufrufe je Impression), einseitig 95 %: "hat geholfen" / "neutral" / "schadet".
import express from 'express';
import { db, nowIso } from './db.js';
import { T } from './i18n.js';

const app = express.Router();
export const router = app;

export const EXP_TYPES = ['thumbnail', 'title', 'tags', 'description'];
const DEFAULT_DAYS = 14, MIN_IMP = 300, Z_CRIT = 1.645;
const DAY = 86400000;
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const todayIso = () => new Date().toISOString().slice(0, 10);

const sums = db.prepare('SELECT SUM(impression) imp, SUM(view) v, SUM(download) dl FROM daily_metrics WHERE design_id=? AND date>=? AND date<?');
const pack = (o, win) => ({ imp: o.imp || 0, view: o.v || 0, dl: o.dl || 0, ctr: o.imp ? +((o.v / o.imp) * 100).toFixed(2) : null, dlPerDay: +((o.dl || 0) / win).toFixed(2) });

// Wertet eine Aenderung aus. status: running (Fenster noch offen) | nodata (zu wenige Impressionen) | done.
export function evaluateEvent(ev, today = todayIso()) {
  const win = ev.eval_days || DEFAULT_DAYS;
  const end = addDays(ev.date, win);
  const out = { id: ev.id, design_id: ev.design_id, date: ev.date, type: ev.type, title: ev.title, label: ev.title === 'automatisch erkannt' ? (ev.note || ev.title) : ev.title, hypothesis: ev.hypothesis || '', eval_days: win,
    ends: end, status: 'running', daysLeft: 0, verdict: null, before: null, after: null, ctrDeltaPct: null, z: null, confounded: false };
  const b = pack(sums.get(ev.design_id, addDays(ev.date, -win), ev.date), win), a = pack(sums.get(ev.design_id, ev.date, end), win);
  out.before = b; out.after = a;
  // Das Nachher-Fenster ist erst vollstaendig, wenn auch der letzte Tag gepullt wurde (= ein Tag nach Ende).
  const left = Math.ceil((Date.parse(addDays(end, 1) + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY);
  if (left > 0) { out.daysLeft = left; return out; }
  out.confounded = db.prepare(`SELECT COUNT(*) c FROM events WHERE design_id=? AND id<>? AND type IN ('thumbnail','title','tags','description') AND date>=? AND date<?`)
    .get(ev.design_id, ev.id, addDays(ev.date, -win), end).c > 0;
  if (b.imp < MIN_IMP || a.imp < MIN_IMP || b.ctr == null || a.ctr == null) { out.status = 'nodata'; return out; }
  const p1 = b.view / b.imp, p2 = a.view / a.imp, p = (b.view + a.view) / (b.imp + a.imp);
  const se = Math.sqrt(p * (1 - p) * (1 / b.imp + 1 / a.imp));
  out.z = se ? +((p2 - p1) / se).toFixed(2) : 0;
  out.ctrDeltaPct = p1 ? +(((p2 - p1) / p1) * 100).toFixed(1) : null;
  out.status = 'done';
  out.verdict = out.z >= Z_CRIT ? 'helped' : out.z <= -Z_CRIT ? 'hurt' : 'neutral';
  return out;
}

const verdictText = v => ({ helped: T('hat geholfen', 'helped'), neutral: T('neutral', 'neutral'), hurt: T('schadet', 'hurt') }[v] || v);
const typeText = t => ({ thumbnail: T('Titelbild', 'cover image'), title: T('Titel', 'title'), tags: T('Tags', 'tags'), description: T('Beschreibung', 'description') }[t] || t);

export function listExperiments(designId) {
  const q = `SELECT e.*, m.title AS model_title FROM events e LEFT JOIN models m ON m.design_id=e.design_id
    WHERE e.type IN ('thumbnail','title','tags','description') AND e.design_id IS NOT NULL ${designId ? 'AND e.design_id=?' : ''} ORDER BY e.date DESC, e.id DESC`;
  const rows = designId ? db.prepare(q).all(designId) : db.prepare(q).all();
  return rows.map(r => ({ ...evaluateEvent(r), model_title: r.model_title || r.design_id }));
}

// Lernbilanz je Aenderungstyp: wie oft hat welcher Hebel geholfen?
export function summarize(items) {
  const by = {};
  for (const i of items) {
    const e = by[i.type] || (by[i.type] = { type: i.type, label: typeText(i.type), n: 0, helped: 0, neutral: 0, hurt: 0, nodata: 0, running: 0 });
    e.n++; if (i.status === 'done') e[i.verdict]++; else e[i.status]++;
  }
  return Object.values(by).sort((a, b) => b.helped - a.helped);
}

app.get('/api/experiments', (req, res) => {
  const items = listExperiments(req.query.design_id || null);
  res.json({ items, summary: summarize(items), min_impressions: MIN_IMP, default_days: DEFAULT_DAYS });
});

// Merkt Ergebnisse ausgewerteter Hypothesen-Experimente und meldet sie (einmalig). notify(title, body) -> Push.
export async function checkExperiments(notify) {
  const rows = db.prepare(`SELECT e.*, m.title AS model_title FROM events e LEFT JOIN models m ON m.design_id=e.design_id
    WHERE e.type IN ('thumbnail','title','tags','description') AND e.design_id IS NOT NULL AND e.evaluated_at IS NULL`).all();
  const msgs = [];
  for (const r of rows) {
    const x = evaluateEvent(r); if (x.status === 'running') continue;
    db.prepare('UPDATE events SET verdict=?, evaluated_at=? WHERE id=?').run(x.status === 'done' ? x.verdict : 'nodata', nowIso(), r.id);
    if (!(r.hypothesis || '').trim()) continue;      // nur selbst formulierte Hypothesen melden, automatisch erkannte Aenderungen bleiben still
    const what = `${r.model_title || r.design_id}: ${typeText(r.type)}`;
    msgs.push(x.status === 'done'
      ? T(`${what} — ${verdictText(x.verdict)} (CTR ${x.before.ctr}% → ${x.after.ctr}%). Hypothese: ${r.hypothesis}`, `${what} — ${verdictText(x.verdict)} (CTR ${x.before.ctr}% → ${x.after.ctr}%). Hypothesis: ${r.hypothesis}`)
      : T(`${what} — zu wenige Impressionen für ein Urteil. Hypothese: ${r.hypothesis}`, `${what} — too few impressions for a verdict. Hypothesis: ${r.hypothesis}`));
  }
  if (msgs.length && notify) { try { await notify(T('Experiment ausgewertet', 'Experiment evaluated'), msgs.join('\n')); } catch {} }
  return msgs;
}
app.post('/api/experiments/check', async (req, res) => res.json({ new: await checkExperiments(null) }));

// Fuer die Insights: in den letzten 7 Tagen ausgewertete Experimente
export function recentVerdicts() {
  return db.prepare(`SELECT e.*, m.title AS model_title FROM events e LEFT JOIN models m ON m.design_id=e.design_id
    WHERE e.evaluated_at >= ? AND e.hypothesis IS NOT NULL AND e.hypothesis<>'' ORDER BY e.evaluated_at DESC LIMIT 5`).all(new Date(Date.now() - 7 * DAY).toISOString())
    .map(r => ({ ...evaluateEvent(r), model_title: r.model_title || r.design_id, verdictText: verdictText(r.verdict), typeText: typeText(r.type) }));
}
