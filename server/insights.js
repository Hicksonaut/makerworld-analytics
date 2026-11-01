// Alerts, Wochen-Insights, Heute-Dashboard, Digest + Push, Meilensteine.
import express from 'express';
import { db, getSetting, setSetting, nowIso } from './db.js';
import { T, num, dateLocal } from './i18n.js';
import { latestSnapSub, modelsWithKpis, attachMomentum, attachForecast, VOUCHER_POINTS, VOUCHER_EUR, voucherStatus, aggregateGroups, eurRate } from './kpi.js';
import { healthData } from './health.js';
import { recentVerdicts } from './experiments.js';
import { overdueInvoices } from './invoices.js';

const app = express.Router();
export const router = app;

// ---- Alerts (aus Momentum + Zielen) ---------------------------------------
function computeAlerts(models) {
  const out = [];
  for (const m of models) {
    const age = m.publish_date ? Math.round((Date.now() - Date.parse(m.publish_date)) / 86400000) : 0;
    if (m.v_trend != null && m.v_trend >= 60 && m.v7 >= 80)
      out.push({ type: 'hot', design_id: m.design_id, title: m.title, text: T(`läuft heiß: Views +${m.v_trend}% ggü. Vorwoche`, `heating up: views +${m.v_trend}% vs. previous week`) });
    if (m.v_trend != null && m.v_trend <= -40 && m.v30 >= 200)
      out.push({ type: 'cool', design_id: m.design_id, title: m.title, text: T(`kühlt ab: Views ${m.v_trend}% ggü. Vorwoche`, `cooling down: views ${m.v_trend}% vs. previous week`) });
    // Stillstand: 0 Downloads in 30 Tagen, obwohl das Modell sonst regelmaessig geladen wird. Statt fester Schwelle
    // zaehlt die Erwartung aus dem Lebensdurchschnitt: Alarm nur, wenn eine Null dabei unwahrscheinlich ist
    // (Poisson: P(0) = e^-erwartet < 10 % <=> erwartet >= 2,3 Downloads je 30 Tage). Sonst ist die Null normales Rauschen.
    const expected30 = age > 0 ? ((m.download || 0) / age) * 30 : 0;
    if (age > 60 && m.dl30 === 0 && expected30 >= 2.3)
      out.push({ type: 'stall', design_id: m.design_id, title: m.title, text: T(`keine Downloads in 30 Tagen (üblich: ~${expected30.toFixed(1).replace('.', ',')} je 30 Tage)`, `no downloads in 30 days (usually ~${expected30.toFixed(1)} per 30 days)`) });
    if (m.goal_download && m.download != null) {
      const p = m.download / m.goal_download;
      if (p >= 1) out.push({ type: 'goal', design_id: m.design_id, title: m.title, text: T(`Ziel erreicht: ${m.download}/${m.goal_download} Downloads`, `goal reached: ${m.download}/${m.goal_download} downloads`) });
      else if (p >= 0.8) out.push({ type: 'goal_near', design_id: m.design_id, title: m.title, text: T(`nah am Ziel: ${m.download}/${m.goal_download} Downloads (${Math.round(p*100)}%)`, `close to goal: ${m.download}/${m.goal_download} downloads (${Math.round(p*100)}%)`) });
    }
  }
  const rank = { hot: 0, goal: 1, cool: 2, stall: 3, goal_near: 4 };
  return out.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));
}


// Wochen-Insight-Report als Text (für Push + Vorschau)
export function weeklyText() {
  const ins = buildInsights();
  const L = [T('MakerWorld Wochen-Report', 'MakerWorld weekly report') + ` — ${dateLocal()}`];
  ins.forEach(i => L.push(`- ${i.title}: ${i.text}`));
  if (ins.length === 0) L.push(T('Noch zu wenig Daten für Insights.', 'Not enough data for insights yet.'));
  return L.join('\n');
}
app.get('/api/insights/weekly-text', (req, res) => res.json({ text: weeklyText() }));
app.post('/api/insights/send', async (req, res) => { const text = weeklyText(); const sent = await pushNotify(T('MakerWorld Wochen-Report', 'MakerWorld weekly report'), text); res.json({ ok: true, sent, text }); });


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
  const overdueInv = overdueInvoices();
  return { date: t, dueTodos, openPayments, overdueInvoices: overdueInv, alerts, recentChanges, issues: healthData().issues,
    counts: { due: dueTodos.filter(x => x.overdue).length, todos: dueTodos.length, payments: openPayments.length, alerts: alerts.length, overdueInvoices: overdueInv.length } };
}
app.get('/api/today', (req, res) => res.json(todayData()));

// ---- Digest + Push --------------------------------------------------------
const eventTypeLabel = t => ({ thumbnail: T('Titelbild', 'cover image'), title: T('Titel', 'title'), description: T('Beschreibung', 'description'), tags: 'Tags', price: T('Preis', 'price'), files: T('Dateien', 'files') }[t] || t);
function digestText() {
  const d = todayData();
  const L = [`MakerWorld Analytics — ${dateLocal(new Date(d.date))}`];
  if (d.openPayments.length) L.push(`\n${T('Offene Zahlungen', 'Open payments')} (${d.openPayments.length}): ` + d.openPayments.map(p => `${p.contact_name}: ${p.title}`).join(', '));
  if (d.overdueInvoices.length) L.push(`\n${T('Überfällige Rechnungen', 'Overdue invoices')} (${d.overdueInvoices.length}): ` + d.overdueInvoices.slice(0, 5).map(i => `RE-${i.no} ${i.customer} ${i.total.toFixed(2)} € (${i.overdue_days} ${T('T', 'd')})`).join(', '));
  const overdue = d.dueTodos.filter(x => x.overdue);
  if (overdue.length) L.push(`\n${T('Überfällige Aufgaben', 'Overdue tasks')} (${overdue.length}): ` + overdue.slice(0, 6).map(t => t.title).join(', '));
  if (d.alerts.length) L.push(`\n${T('Alerts', 'Alerts')} (${d.alerts.length}): ` + d.alerts.slice(0, 5).map(a => `${a.title}: ${a.text}`).join(' · '));
  if (d.recentChanges.length) L.push(`\n${T('Änderungen (3 T)', 'Changes (3 d)')}: ` + d.recentChanges.slice(0, 6).map(c => `${c.model_title || ''} ${eventTypeLabel(c.type)}`).join(', '));
  if (L.length === 1) L.push('\n' + T('Alles ruhig — nichts zu tun.', 'All quiet — nothing to do.'));
  return L.join('\n');
}
export async function sendDigest() {
  const text = digestText();
  setSetting('last_digest', JSON.stringify({ at: nowIso(), text }));
  const url = getSetting('notify_url', '');
  if (url) { try { await fetch(url, { method: 'POST', headers: { Title: T('MakerWorld Digest', 'MakerWorld digest'), 'Content-Type': 'text/plain; charset=utf-8' }, body: text }); } catch (e) { console.log('[notify] Fehler:', e.message); } }
  return text;
}
app.get('/api/digest', (req, res) => { let last = null; try { last = JSON.parse(getSetting('last_digest', 'null')); } catch {} res.json({ current: digestText(), last }); });
app.post('/api/digest/send', async (req, res) => res.json({ ok: true, text: await sendDigest() }));

// ---- Push-Helfer (ntfy.sh / Webhook) --------------------------------------
export async function pushNotify(title, body) {
  const url = getSetting('notify_url', ''); if (!url) return false;
  try { await fetch(url, { method: 'POST', headers: { Title: title, 'Content-Type': 'text/plain; charset=utf-8' }, body }); return true; }
  catch (e) { console.log('[notify]', e.message); return false; }
}

// ---- Meilenstein-Benachrichtigungen ---------------------------------------
const DL_THRESHOLDS = [100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
const deNum = n => num(n);   // Zahlenformat nach Sprache
function recordMilestone(design_id, kind, threshold, title) {
  try { return db.prepare('INSERT OR IGNORE INTO milestones(design_id,kind,threshold,title,date,created_at) VALUES(?,?,?,?,?,?)')
    .run(design_id, kind, threshold, title, new Date().toISOString().slice(0, 10), nowIso()).changes > 0; }
  catch { return false; }
}
export async function checkMilestones() {
  const init = getSetting('milestones_init', '0') !== '1';   // erster Lauf: still verbuchen, nicht pushen
  const msgs = [];
  const models = db.prepare(`SELECT m.design_id, m.title, s.download, s.point FROM models m
    JOIN (${latestSnapSub}) s ON s.design_id=m.design_id WHERE COALESCE(m.planned,0)=0`).all();
  for (const m of models) for (const t of DL_THRESHOLDS)
    if ((m.download || 0) >= t && recordMilestone(m.design_id, 'download', t, `${m.title}: ${t} Downloads`))
      msgs.push(T(`${m.title}: ${deNum(t)} Downloads erreicht`, `${m.title}: ${deNum(t)} downloads reached`));
  // "kalt": live, >30 Tage alt, 0 Downloads in 7 Tagen, vorher aktiv
  const cold = db.prepare(`SELECT m.design_id, m.title,
      (SELECT COALESCE(SUM(download),0) FROM daily_metrics d WHERE d.design_id=m.design_id AND d.date>=date('now','-7 day')) d7,
      (SELECT COALESCE(SUM(download),0) FROM daily_metrics d WHERE d.design_id=m.design_id AND d.date<date('now','-7 day') AND d.date>=date('now','-37 day')) d30
    FROM models m WHERE COALESCE(m.planned,0)=0 AND m.publish_date<=date('now','-30 day')`).all();
  for (const c of cold) if (c.d7 === 0 && c.d30 >= 10 && recordMilestone(c.design_id, 'cold', 0, `${c.title} kalt`))
    msgs.push(T(`${c.title}: 0 Downloads in 7 Tagen (vorher ${c.d30} in 30 T)`, `${c.title}: 0 downloads in 7 days (before: ${c.d30} in 30 d)`));
  // Gutschein-Schwellen (524 Punkte = 40 €)
  const acc = db.prepare('SELECT point FROM account_snapshots ORDER BY id DESC LIMIT 1').get();
  if (acc) { const reached = Math.floor((acc.point || 0) / VOUCHER_POINTS);
    for (let k = 1; k <= reached; k++) if (recordMilestone(null, 'voucher', k * VOUCHER_POINTS, `${k * VOUCHER_POINTS} Punkte`))
      msgs.push(T(`${deNum(k * VOUCHER_POINTS)} Punkte erreicht — ${k}× ${VOUCHER_EUR} € Gutschein möglich`, `${deNum(k * VOUCHER_POINTS)} points reached — ${k}× ${VOUCHER_EUR} € voucher available`)); }
  if (init) { setSetting('milestones_init', '1'); return []; }
  if (msgs.length) await pushNotify(T('MakerWorld Meilenstein', 'MakerWorld milestone'), msgs.join('\n'));
  return msgs;
}
app.get('/api/milestones', (req, res) => res.json(db.prepare('SELECT ms.*, m.title AS model_title FROM milestones ms LEFT JOIN models m ON m.design_id=ms.design_id ORDER BY ms.id DESC LIMIT 40').all()
  .map(r => ({ ...r, title: r.kind === 'download' ? T(`${r.model_title || ''}: ${r.threshold} Downloads`, `${r.model_title || ''}: ${r.threshold} downloads`)
    : r.kind === 'voucher' ? T(`${r.threshold} Punkte`, `${r.threshold} points`) : r.kind === 'cold' ? T(`${r.model_title || ''} kalt`, `${r.model_title || ''} gone cold`) : r.title }))));
app.post('/api/milestones/check', async (req, res) => res.json({ new: await checkMilestones() }));

// ---- Insights (automatische Erkenntnisse) ---------------------------------
function buildInsights() {
  const rate = eurRate();
  const models = attachForecast(attachMomentum(modelsWithKpis())).filter(m => !m.planned);
  const ins = [];
  const byDl30 = [...models].sort((a, b) => (b.dl30 || 0) - (a.dl30 || 0));
  if (byDl30[0] && byDl30[0].dl30 > 0) ins.push({ kind: 'mover', title: T('Zugpferd (30 T)', 'Workhorse (30 d)'),
    text: T(`${byDl30[0].title}: ${deNum(byDl30[0].dl30)} Downloads in 30 Tagen`, `${byDl30[0].title}: ${deNum(byDl30[0].dl30)} downloads in 30 days`) + (byDl30[0].v_trend != null ? T(`, Views-Trend ${byDl30[0].v_trend > 0 ? '+' : ''}${byDl30[0].v_trend}%`, `, views trend ${byDl30[0].v_trend > 0 ? '+' : ''}${byDl30[0].v_trend}%`) : ''),
    design_id: byDl30[0].design_id });
  const fallers = models.filter(m => m.v_trend != null && m.v_trend < -15).sort((a, b) => a.v_trend - b.v_trend);
  if (fallers[0]) ins.push({ kind: 'faller', title: T('Verliert an Fahrt', 'Losing momentum'),
    text: T(`${fallers[0].title}: Views ${fallers[0].v_trend}% vs. Vorperiode`, `${fallers[0].title}: views ${fallers[0].v_trend}% vs. previous period`), design_id: fallers[0].design_id });
  // hohe Impressions, aber niedrige CTR = Titelbild/Titel-Chance
  const ctrOf = m => m.impression ? (m.view / m.impression) * 100 : null;
  const opp = models.filter(m => (m.impression || 0) > 2000 && ctrOf(m) != null).sort((a, b) => ctrOf(a) - ctrOf(b))[0];
  if (opp && ctrOf(opp) < 6) ins.push({ kind: 'ctr', title: T('CTR-Chance', 'CTR opportunity'),
    text: T(`${opp.title}: ${deNum(opp.impression)} Impressionen, aber nur ${ctrOf(opp).toFixed(1)}% CTR — Titelbild/Titel testen`, `${opp.title}: ${deNum(opp.impression)} impressions but only ${ctrOf(opp).toFixed(1)}% CTR — test cover image/title`), design_id: opp.design_id });
  const earner = [...models].sort((a, b) => (b.earned || 0) - (a.earned || 0))[0];
  if (earner && earner.earned > 0) ins.push({ kind: 'earner', title: T('Top-Verdiener', 'Top earner'),
    text: T(`${earner.title}: ${earner.earned.toFixed(2)} € (gesamt)`, `${earner.title}: ${earner.earned.toFixed(2)} € (total)`), design_id: earner.design_id });
  // Gutschein-ETA
  const acc = db.prepare('SELECT point FROM account_snapshots ORDER BY id DESC LIMIT 1').get();
  if (acc) { const v = voucherStatus(acc.point, models.reduce((s, m) => s + (m.proj_pts30 || 0), 0) / 30);
    ins.push({ kind: 'voucher', title: T('Nächster Gutschein', 'Next voucher'),
      text: T(`Noch ${deNum(v.remaining)} Punkte bis ${VOUCHER_EUR} €` + (v.etaDays ? ` — bei ~${v.perDay.toFixed(1)} P/Tag (Trend) in ~${v.etaDays} Tagen` : ''), `${deNum(v.remaining)} points to go until ${VOUCHER_EUR} €` + (v.etaDays ? ` — at ~${v.perDay.toFixed(1)} pts/day (trend) in ~${v.etaDays} days` : '')) });
  }
  // Bester Hashtag (Durchschnitt Views je Modell, mind. 2 Modelle)
  const tags = aggregateGroups(models, 'tag').filter(t => t.key !== '—' && t.count >= 2).map(t => ({ tag: t.key, n: t.count, avg: t.view / t.count })).sort((a, b) => b.avg - a.avg);
  if (tags.length >= 2) ins.push({ kind: 'tag', title: T('Bester Hashtag', 'Best hashtag'),
    text: T(`„${tags[0].tag}" bringt im Schnitt ${deNum(Math.round(tags[0].avg))} Views/Modell (${tags[0].n}×)`, `"${tags[0].tag}" brings ${deNum(Math.round(tags[0].avg))} views per model on average (${tags[0].n}×)`) });
  // Frisch ausgewertete Experimente (selbst formulierte Hypothesen)
  for (const x of recentVerdicts()) ins.push({ kind: 'experiment', title: T('Experiment ausgewertet', 'Experiment evaluated'), design_id: x.design_id,
    text: x.status === 'done'
      ? T(`${x.model_title}: ${x.typeText} — ${x.verdictText} (CTR ${x.before.ctr}% → ${x.after.ctr}%)`, `${x.model_title}: ${x.typeText} — ${x.verdictText} (CTR ${x.before.ctr}% → ${x.after.ctr}%)`)
      : T(`${x.model_title}: ${x.typeText} — zu wenige Daten für ein Urteil`, `${x.model_title}: ${x.typeText} — too little data for a verdict`) });
  return ins;
}
app.get('/api/insights', (req, res) => res.json({ insights: buildInsights(), date: new Date().toISOString().slice(0, 10) }));
