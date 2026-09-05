// CRM: Kontakte, Projekte, Bestellungen + Umsatz-Auswertung. Eigener Router.
import express from 'express';
import { db, nowIso, getSetting, setSetting } from './db.js';

export const crm = express.Router();

// ---- Kalkulation (3D-Druck-Kosten) ----------------------------------------
const TIER_DEFAULT = [{ name: 'Standard', margin: 0.6 }, { name: 'Freunde', margin: 0.2 }];
export function calcSettings() {
  const tiers = (() => { try { return JSON.parse(getSetting('calc_tiers', JSON.stringify(TIER_DEFAULT))); } catch { return TIER_DEFAULT; } })();
  return {
    filament_price_kg: +getSetting('calc_filament_kg', '14'),
    energy_rate_h: +getSetting('calc_energy_h', '0.2'),
    labor_rate_h: +getSetting('calc_labor_h', '0'),
    round_to: +getSetting('calc_round', '0.5'),
    tiers
  };
}
const roundUp = (x, step) => step > 0 ? +(Math.ceil(x / step) * step).toFixed(2) : +x.toFixed(2);
// project = Zeile aus projects, parts = [{qty, unit_price}], s = calcSettings(),
// items = Druckpositionen [{qty, weight_g, print_min}]. Sind Positionen vorhanden,
// werden Filament + Druckzeit daraus summiert (mehrere Modelle/Profile je Projekt).
export function computeProject(p, parts, s, items = []) {
  const hasItems = Array.isArray(items) && items.length > 0;
  const filamentG = hasItems ? items.reduce((a, it) => a + (+it.qty || 0) * (+it.weight_g || 0), 0) : (+p.filament_g || 0);
  const printH = hasItems ? items.reduce((a, it) => a + (+it.qty || 0) * (+it.print_min || 0), 0) / 60 : (+p.print_hours || 0);
  const filament = filamentG / 1000 * s.filament_price_kg;
  const partsSum = parts.reduce((a, pp) => a + (pp.qty || 0) * (pp.unit_price || 0), 0);
  const energy = printH * s.energy_rate_h;
  const material = +(filament + partsSum + energy).toFixed(2);   // Sachkosten (out-of-pocket)
  const labor = +((p.labor_hours || 0) * s.labor_rate_h).toFixed(2);
  const cost = +(material + labor).toFixed(2);                   // Selbstkosten
  const free = p.margin_tier === 'kostenlos';
  const tier = s.tiers.find(t => t.name === p.margin_tier);
  const margin = tier ? tier.margin : (s.tiers[0]?.margin ?? 0.6);
  const suggestion = free ? 0 : roundUp(cost * (1 + margin), s.round_to);
  const price = p.price != null ? p.price : suggestion;         // Einnahme
  const profit = +(price - cost).toFixed(2);                    // Gewinn (nach Arbeit)
  const contribution = +(price - material).toFixed(2);          // Deckungsbeitrag (ggü. Sachkosten)
  const loss = price <= 0 ? +(-material).toFixed(2) : 0;        // Verlust bei kostenlos = Materialkosten
  return { filament: +filament.toFixed(2), partsSum: +partsSum.toFixed(2), energy: +energy.toFixed(2),
    material, labor, cost, margin, free, suggestion, price, profit, contribution, loss,
    filamentG: +filamentG.toFixed(1), printH: +printH.toFixed(2), hasItems };
}
// MakerWorld-Ertrag des verknuepften Modells (Lifetime Punkte -> EUR + Downloads).
function modelEarned(design_id) {
  if (!design_id) return null;
  const snap = db.prepare(`SELECT s.point, s.download, s.view FROM snapshots s
    JOIN (SELECT design_id, MAX(id) m FROM snapshots GROUP BY design_id) t ON t.design_id=s.design_id AND t.m=s.id
    WHERE s.design_id=?`).get(design_id);
  if (!snap) return null;
  const rate = +getSetting('eur_per_point', String(40 / 524));
  return { point: snap.point || 0, download: snap.download || 0, view: snap.view || 0, earned: +(((snap.point || 0) * rate)).toFixed(2) };
}
// Auto-Aufgabe: fertig + noch nicht bezahlt -> "Zahlung einfordern".
// bezahlt gesetzt -> offene Zahlungs-Aufgaben erledigen.
function syncPaymentTodo(p) {
  const open = db.prepare("SELECT id FROM todos WHERE project_id=? AND done=0 AND title LIKE 'Zahlung einfordern%'").all(p.id);
  const free = p.margin_tier === 'kostenlos' || (p.price != null && p.price <= 0);
  if (p.paid || free) {
    // bezahlt ODER kostenlos -> keine/keine offene Zahlungs-Aufgabe noetig
    for (const t of open) db.prepare('UPDATE todos SET done=1, done_at=? WHERE id=?').run(nowIso(), t.id);
  } else if (p.stage === 'fertig' && !open.length) {
    db.prepare('INSERT INTO todos(contact_id,project_id,title,priority,created_at) VALUES(?,?,?,?,?)')
      .run(p.contact_id, p.id, 'Zahlung einfordern: ' + (p.title || 'Projekt'), 2, nowIso());
  }
}
function projectWithCalc(p, s) {
  const parts = db.prepare(`SELECT pp.id, pp.qty, pt.name, pt.unit, pt.unit_price, pt.category
    FROM project_parts pp JOIN parts pt ON pt.id=pp.part_id WHERE pp.project_id=?`).all(p.id);
  const items = db.prepare(`SELECT i.*, m.title AS model_title FROM project_items i
    LEFT JOIN models m ON m.design_id=i.design_id WHERE i.project_id=? ORDER BY i.sort, i.id`).all(p.id);
  const calc = computeProject(p, parts, s, items);
  const mw = modelEarned(p.design_id);
  // Gesamtbilanz = Direkteinnahme - Materialkosten + MakerWorld-Verdienst
  calc.mwEarned = mw ? mw.earned : 0;
  calc.totalResult = +((calc.price - calc.material) + calc.mwEarned).toFixed(2);
  return { ...p, parts, items, calc, mw };
}
const parseTags = c => ({ ...c, tags: c.tags ? JSON.parse(c.tags) : [] });
const tagsJson = t => Array.isArray(t) ? (t.length ? JSON.stringify(t) : null)
  : (t ? JSON.stringify(String(t).split(',').map(x => x.trim()).filter(Boolean)) : null);

// ---- Kontakte -------------------------------------------------------------
crm.get('/contacts', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM projects p WHERE p.contact_id=c.id) project_count,
      (SELECT COUNT(*) FROM orders o WHERE o.contact_id=c.id) order_count,
      (SELECT COALESCE(SUM(qty*unit_price),0) FROM orders o WHERE o.contact_id=c.id) order_total,
      (SELECT COALESCE(SUM(qty*unit_price),0) FROM orders o WHERE o.contact_id=c.id AND o.status='bezahlt') revenue_paid,
      (SELECT MAX(order_date) FROM orders o WHERE o.contact_id=c.id) last_order
    FROM contacts c ORDER BY c.updated_at DESC, c.id DESC`).all();
  res.json(rows.map(parseTags));
});
crm.get('/contact/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'unbekannt' });
  const s = calcSettings();
  const projects = db.prepare(`SELECT p.*, m.title AS model_title FROM projects p
    LEFT JOIN models m ON m.design_id=p.design_id WHERE p.contact_id=? ORDER BY p.id DESC`).all(req.params.id)
    .map(p => projectWithCalc(p, s));
  const todos = db.prepare('SELECT * FROM todos WHERE contact_id=? ORDER BY done, priority DESC, id').all(req.params.id);
  res.json({ contact: parseTags(c), projects, todos });
});
crm.post('/contacts', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'Name fehlt' });
  const r = db.prepare(`INSERT INTO contacts(name,source,mw_handle,email,phone,tags,notes,stage,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(b.name.trim(), b.source || 'manuell', b.mw_handle || null, b.email || null,
    b.phone || null, tagsJson(b.tags), b.notes || null, b.stage || 'neu', nowIso(), nowIso());
  res.json(parseTags(db.prepare('SELECT * FROM contacts WHERE id=?').get(r.lastInsertRowid)));
});
crm.put('/contacts/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'unbekannt' });
  const b = req.body || {};
  db.prepare(`UPDATE contacts SET name=?,source=?,mw_handle=?,email=?,phone=?,tags=?,notes=?,stage=?,updated_at=? WHERE id=?`)
    .run(b.name ?? cur.name, b.source ?? cur.source, b.mw_handle ?? cur.mw_handle, b.email ?? cur.email,
      b.phone ?? cur.phone, b.tags !== undefined ? tagsJson(b.tags) : cur.tags, b.notes ?? cur.notes,
      b.stage ?? cur.stage, nowIso(), req.params.id);
  res.json(parseTags(db.prepare('SELECT * FROM contacts WHERE id=?').get(req.params.id)));
});
crm.delete('/contacts/:id', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM orders WHERE contact_id=?').run(req.params.id);
    db.prepare('DELETE FROM projects WHERE contact_id=?').run(req.params.id);
    db.prepare('DELETE FROM contacts WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

// ---- Projekte -------------------------------------------------------------
crm.post('/projects', (req, res) => {
  const b = req.body || {};
  if (!b.contact_id || !b.title) return res.status(400).json({ error: 'contact_id/title fehlt' });
  const r = db.prepare(`INSERT INTO projects(contact_id,title,description,design_id,stage,status,due_date,
      filament_g,print_hours,labor_hours,margin_tier,price,paid,qty,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.contact_id, b.title, b.description || null, b.design_id || null,
    b.stage || 'anfrage', b.status || 'offen', b.due_date || null,
    b.filament_g || null, b.print_hours || null, b.labor_hours || null, b.margin_tier || null, b.price ?? null,
    b.paid ? 1 : 0, b.qty || 1, nowIso());
  const np = db.prepare('SELECT * FROM projects WHERE id=?').get(r.lastInsertRowid);
  syncPaymentTodo(np);
  res.json(projectWithCalc(np, calcSettings()));
});
crm.put('/projects/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'unbekannt' });
  const b = req.body || {};
  const g = (k, d) => b[k] !== undefined ? b[k] : d;
  db.prepare(`UPDATE projects SET title=?,description=?,design_id=?,stage=?,status=?,due_date=?,
      filament_g=?,print_hours=?,labor_hours=?,margin_tier=?,price=?,paid=?,qty=?,published=? WHERE id=?`)
    .run(g('title', cur.title), g('description', cur.description), g('design_id', cur.design_id),
      g('stage', cur.stage), g('status', cur.status), g('due_date', cur.due_date),
      g('filament_g', cur.filament_g), g('print_hours', cur.print_hours), g('labor_hours', cur.labor_hours),
      g('margin_tier', cur.margin_tier), g('price', cur.price),
      b.paid !== undefined ? (b.paid ? 1 : 0) : cur.paid, g('qty', cur.qty),
      b.published !== undefined ? (b.published ? 1 : 0) : cur.published, req.params.id);
  const upd = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  syncPaymentTodo(upd);
  res.json(projectWithCalc(upd, calcSettings()));
});
crm.delete('/projects/:id', (req, res) => {
  db.prepare('DELETE FROM project_parts WHERE project_id=?').run(req.params.id);
  db.prepare('DELETE FROM project_items WHERE project_id=?').run(req.params.id);
  db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id); res.json({ ok: true });
});
crm.get('/project/:id', (req, res) => {
  const p = db.prepare(`SELECT p.*, m.title model_title, c.name contact_name FROM projects p
    LEFT JOIN models m ON m.design_id=p.design_id JOIN contacts c ON c.id=p.contact_id WHERE p.id=?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unbekannt' });
  const out = projectWithCalc(p, calcSettings());
  out.todos = db.prepare('SELECT * FROM todos WHERE project_id=? ORDER BY done, priority DESC, id').all(req.params.id);
  res.json(out);
});
// Teile in Projekt hinzufuegen/aendern/entfernen
crm.post('/projects/:id/parts', (req, res) => {
  const { part_id, qty } = req.body || {};
  if (!part_id) return res.status(400).json({ error: 'part_id fehlt' });
  db.prepare('INSERT INTO project_parts(project_id,part_id,qty) VALUES(?,?,?)').run(req.params.id, part_id, qty || 1);
  res.json(projectWithCalc(db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id), calcSettings()));
});
crm.put('/project-parts/:id', (req, res) => {
  db.prepare('UPDATE project_parts SET qty=? WHERE id=?').run(req.body?.qty ?? 1, req.params.id);
  const pp = db.prepare('SELECT project_id FROM project_parts WHERE id=?').get(req.params.id);
  res.json(pp ? projectWithCalc(db.prepare('SELECT * FROM projects WHERE id=?').get(pp.project_id), calcSettings()) : { ok: true });
});
crm.delete('/project-parts/:id', (req, res) => {
  const pp = db.prepare('SELECT project_id FROM project_parts WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM project_parts WHERE id=?').run(req.params.id);
  res.json(pp ? projectWithCalc(db.prepare('SELECT * FROM projects WHERE id=?').get(pp.project_id), calcSettings()) : { ok: true });
});

// ---- Druckpositionen (mehrere Modelle/Profile je Projekt) -----------------
const withCalc = pid => projectWithCalc(db.prepare('SELECT * FROM projects WHERE id=?').get(pid), calcSettings());
crm.post('/projects/:id/items', (req, res) => {
  const b = req.body || {};
  const sort = (db.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM project_items WHERE project_id=?').get(req.params.id) || {}).s || 1;
  db.prepare(`INSERT INTO project_items(project_id,design_id,instance_id,label,qty,weight_g,print_min,sort)
    VALUES(?,?,?,?,?,?,?,?)`).run(req.params.id, b.design_id || null, b.instance_id || null, b.label || null,
    b.qty || 1, b.weight_g != null ? +b.weight_g : null, b.print_min != null ? +b.print_min : null, sort);
  res.json(withCalc(req.params.id));
});
crm.put('/project-items/:iid', (req, res) => {
  const cur = db.prepare('SELECT * FROM project_items WHERE id=?').get(req.params.iid);
  if (!cur) return res.status(404).json({ error: 'unbekannt' });
  const b = req.body || {}; const g = (k, d) => b[k] !== undefined ? b[k] : d;
  db.prepare(`UPDATE project_items SET design_id=?,instance_id=?,label=?,qty=?,weight_g=?,print_min=? WHERE id=?`)
    .run(g('design_id', cur.design_id), g('instance_id', cur.instance_id), g('label', cur.label),
      g('qty', cur.qty), b.weight_g !== undefined ? (b.weight_g == null ? null : +b.weight_g) : cur.weight_g,
      b.print_min !== undefined ? (b.print_min == null ? null : +b.print_min) : cur.print_min, req.params.iid);
  res.json(withCalc(cur.project_id));
});
crm.delete('/project-items/:iid', (req, res) => {
  const cur = db.prepare('SELECT project_id FROM project_items WHERE id=?').get(req.params.iid);
  db.prepare('DELETE FROM project_items WHERE id=?').run(req.params.iid);
  res.json(cur ? withCalc(cur.project_id) : { ok: true });
});

// Alle Projekte (fuer die Projekt-Pipeline) inkl. Kunde + Kalkulation
crm.get('/crm/projects', (req, res) => {
  const s = calcSettings();
  const rows = db.prepare(`SELECT p.*, c.name contact_name, c.source contact_source, m.title model_title
    FROM projects p JOIN contacts c ON c.id=p.contact_id LEFT JOIN models m ON m.design_id=p.design_id
    ORDER BY p.id DESC`).all().map(p => projectWithCalc(p, s));
  res.json(rows);
});

// ---- Teile-Katalog ("SAP") ------------------------------------------------
crm.get('/parts', (req, res) => res.json(db.prepare('SELECT * FROM parts ORDER BY category, name').all()));
crm.post('/parts', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name fehlt' });
  const r = db.prepare('INSERT INTO parts(name,category,unit,unit_price,notes,created_at) VALUES(?,?,?,?,?,?)')
    .run(b.name, b.category || 'sonstiges', b.unit || 'Stk', b.unit_price || 0, b.notes || null, nowIso());
  res.json(db.prepare('SELECT * FROM parts WHERE id=?').get(r.lastInsertRowid));
});
crm.put('/parts/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM parts WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'unbekannt' });
  const b = req.body || {};
  db.prepare('UPDATE parts SET name=?,category=?,unit=?,unit_price=?,notes=? WHERE id=?')
    .run(b.name ?? cur.name, b.category ?? cur.category, b.unit ?? cur.unit, b.unit_price ?? cur.unit_price, b.notes ?? cur.notes, req.params.id);
  res.json(db.prepare('SELECT * FROM parts WHERE id=?').get(req.params.id));
});
crm.delete('/parts/:id', (req, res) => { db.prepare('DELETE FROM parts WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---- Kalkulations-Einstellungen (global) ----------------------------------
const sellerInfo = () => { try { return JSON.parse(getSetting('invoice_seller', '{}')); } catch { return {}; } };
crm.get('/crm/settings', (req, res) => res.json({ ...calcSettings(), seller: sellerInfo(), invoice_next: +getSetting('invoice_next', '1') }));
crm.post('/crm/settings', (req, res) => {
  const b = req.body || {};
  if (b.filament_price_kg != null) setSetting('calc_filament_kg', String(+b.filament_price_kg));
  if (b.energy_rate_h != null) setSetting('calc_energy_h', String(+b.energy_rate_h));
  if (b.labor_rate_h != null) setSetting('calc_labor_h', String(+b.labor_rate_h));
  if (b.round_to != null) setSetting('calc_round', String(+b.round_to));
  if (Array.isArray(b.tiers)) setSetting('calc_tiers', JSON.stringify(b.tiers.filter(t => t.name)));
  if (b.seller && typeof b.seller === 'object') setSetting('invoice_seller', JSON.stringify(b.seller));
  res.json({ ...calcSettings(), seller: sellerInfo(), invoice_next: +getSetting('invoice_next', '1') });
});
// naechste Rechnungsnummer ziehen (hochzaehlen)
crm.post('/crm/invoice-number', (req, res) => {
  const n = +getSetting('invoice_next', '1'); setSetting('invoice_next', String(n + 1));
  res.json({ number: n });
});

// ---- Betriebsausgaben --------------------------------------------------------
crm.get('/expenses', (req, res) => res.json(db.prepare('SELECT * FROM expenses ORDER BY date DESC, id DESC').all()));
crm.post('/expenses', (req, res) => {
  const b = req.body || {};
  const r = db.prepare('INSERT INTO expenses(date,category,description,amount,created_at) VALUES(?,?,?,?,?)')
    .run(b.date || new Date().toISOString().slice(0, 10), b.category || 'sonstiges', b.description || null, +b.amount || 0, nowIso());
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(r.lastInsertRowid));
});
crm.put('/expenses/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id); if (!c) return res.status(404).json({ error: 'x' });
  const b = req.body || {};
  db.prepare('UPDATE expenses SET date=?,category=?,description=?,amount=? WHERE id=?')
    .run(b.date ?? c.date, b.category ?? c.category, b.description ?? c.description, b.amount != null ? +b.amount : c.amount, req.params.id);
  res.json(db.prepare('SELECT * FROM expenses WHERE id=?').get(req.params.id));
});
crm.delete('/expenses/:id', (req, res) => { db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---- Punkte-Auszahlungen -----------------------------------------------------
crm.get('/payouts', (req, res) => res.json(db.prepare('SELECT * FROM payouts ORDER BY date DESC, id DESC').all()));
crm.post('/payouts', (req, res) => {
  const b = req.body || {};
  const r = db.prepare('INSERT INTO payouts(date,points,amount,note,created_at) VALUES(?,?,?,?,?)')
    .run(b.date || new Date().toISOString().slice(0, 10), +b.points || 0, +b.amount || 0, b.note || null, nowIso());
  res.json(db.prepare('SELECT * FROM payouts WHERE id=?').get(r.lastInsertRowid));
});
crm.delete('/payouts/:id', (req, res) => { db.prepare('DELETE FROM payouts WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---- Gewinn & Verlust (P&L) --------------------------------------------------
crm.get('/crm/pnl', (req, res) => {
  const s = calcSettings();
  const projInc = db.prepare("SELECT COALESCE(due_date,created_at) d, price FROM projects WHERE paid=1 AND price>0").all();
  const payouts = db.prepare('SELECT date d, amount FROM payouts').all();
  const expenses = db.prepare('SELECT date d, amount, category FROM expenses').all();
  const monthKey = x => (x || '').slice(0, 7);
  const M = {};
  const bucket = k => M[k] || (M[k] = { m: k, income: 0, payout: 0, expense: 0 });
  projInc.forEach(r => { const b = bucket(monthKey(r.d)); b.income += r.price || 0; });
  payouts.forEach(r => { const b = bucket(monthKey(r.d)); b.payout += r.amount || 0; });
  expenses.forEach(r => { const b = bucket(monthKey(r.d)); b.expense += r.amount || 0; });
  const monthly = Object.values(M).filter(x => x.m).sort((a, b) => a.m.localeCompare(b.m))
    .map(x => ({ ...x, net: +(x.income + x.payout - x.expense).toFixed(2), income: +x.income.toFixed(2), payout: +x.payout.toFixed(2), expense: +x.expense.toFixed(2) }));
  const sum = k => +monthly.reduce((a, x) => a + x[k], 0).toFixed(2);
  const totals = { income: sum('income'), payout: sum('payout'), expense: sum('expense'), net: sum('net') };
  const expByCat = Object.entries(expenses.reduce((a, e) => { a[e.category || 'sonstiges'] = (a[e.category || 'sonstiges'] || 0) + (e.amount || 0); return a; }, {}))
    .map(([category, sum]) => ({ category, sum: +sum.toFixed(2) })).sort((a, b) => b.sum - a.sum);
  // offener (noch nicht ausgezahlter) Punktestand
  const acc = db.prepare('SELECT point FROM account_snapshots ORDER BY id DESC LIMIT 1').get();
  const walletEur = acc ? +(((acc.point || 0) * (+getSetting('eur_per_point', String(40 / 524))))).toFixed(2) : 0;
  res.json({ monthly, totals, expByCat, walletOpenEur: walletEur });
});

// ---- Bestellungen ---------------------------------------------------------
crm.post('/orders', (req, res) => {
  const b = req.body || {};
  if (!b.contact_id) return res.status(400).json({ error: 'contact_id fehlt' });
  const r = db.prepare(`INSERT INTO orders(contact_id,project_id,design_id,title,qty,unit_price,status,order_date,notes,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(b.contact_id, b.project_id || null, b.design_id || null, b.title || null,
    b.qty || 1, b.unit_price || 0, b.status || 'angefragt', b.order_date || new Date().toISOString().slice(0, 10), b.notes || null, nowIso());
  res.json(db.prepare('SELECT *, (qty*unit_price) amount FROM orders WHERE id=?').get(r.lastInsertRowid));
});
crm.put('/orders/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'unbekannt' });
  const b = req.body || {};
  db.prepare('UPDATE orders SET project_id=?,design_id=?,title=?,qty=?,unit_price=?,status=?,order_date=?,notes=? WHERE id=?')
    .run(b.project_id ?? cur.project_id, b.design_id ?? cur.design_id, b.title ?? cur.title, b.qty ?? cur.qty,
      b.unit_price ?? cur.unit_price, b.status ?? cur.status, b.order_date ?? cur.order_date, b.notes ?? cur.notes, req.params.id);
  res.json(db.prepare('SELECT *, (qty*unit_price) amount FROM orders WHERE id=?').get(req.params.id));
});
crm.delete('/orders/:id', (req, res) => { db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ---- Umsatz-Auswertung (projektbasiert) -----------------------------------
crm.get('/crm/revenue', (req, res) => {
  const s = calcSettings();
  const allProj = db.prepare(`SELECT p.*, c.name contact_name, c.source contact_source, m.title model_title FROM projects p
    JOIN contacts c ON c.id=p.contact_id LEFT JOIN models m ON m.design_id=p.design_id`).all().map(p => projectWithCalc(p, s));
  const active = allProj.filter(p => p.stage !== 'abgebrochen');
  // Direkteinnahmen: bezahlt vs offen
  const paid = +active.filter(p => p.paid).reduce((a, p) => a + (p.calc.price || 0), 0).toFixed(2);
  const open = +active.filter(p => !p.paid && p.calc.price > 0).reduce((a, p) => a + (p.calc.price || 0), 0).toFixed(2);
  const total = +(paid + open).toFixed(2);
  const monthly = (() => { const m = {}; active.filter(p => p.paid).forEach(p => { const k = (p.due_date || p.created_at || '').slice(0, 7); if (k) m[k] = (m[k] || 0) + (p.calc.price || 0); });
    return Object.entries(m).sort().map(([mm, sum]) => ({ m: mm, sum: +sum.toFixed(2) })); })();
  const agg = (keyFn) => { const o = {}; active.forEach(p => { const k = keyFn(p); if (k == null) return;
    const e = o[k] || (o[k] = { sum: 0, paid: 0, cnt: 0 }); e.sum += p.calc.price || 0; e.paid += p.paid ? (p.calc.price || 0) : 0; e.cnt++; }); return o; };
  const bySource = Object.entries(agg(p => p.contact_source || '—')).map(([source, v]) => ({ source, sum: +v.sum.toFixed(2), cnt: v.cnt })).sort((a, b) => b.sum - a.sum);
  const byContactMap = {}; active.forEach(p => { const e = byContactMap[p.contact_id] || (byContactMap[p.contact_id] = { id: p.contact_id, name: p.contact_name, sum: 0, paid: 0, cnt: 0 });
    e.sum += p.calc.price || 0; e.paid += p.paid ? (p.calc.price || 0) : 0; e.cnt++; });
  const byContact = Object.values(byContactMap).map(v => ({ ...v, sum: +v.sum.toFixed(2), paid: +v.paid.toFixed(2) })).sort((a, b) => b.sum - a.sum);
  const byModelMap = {}; active.filter(p => p.design_id).forEach(p => { const e = byModelMap[p.design_id] || (byModelMap[p.design_id] = { design_id: p.design_id, title: p.model_title, sum: 0, cnt: 0, custs: new Set() });
    e.sum += p.calc.price || 0; e.cnt++; e.custs.add(p.contact_id); });
  const byModel = Object.values(byModelMap).map(v => ({ design_id: v.design_id, title: v.title, sum: +v.sum.toFixed(2), cnt: v.cnt, customers: v.custs.size })).sort((a, b) => b.sum - a.sum);

  const projectStats = allProj.reduce((a, p) => { const c = p.calc; return {
    material: a.material + c.material, cost: a.cost + c.cost,
    revenue: a.revenue + (p.paid ? (c.price || 0) : 0), profit: a.profit + (p.paid ? c.profit : 0),
    loss: a.loss + c.loss, freeCount: a.freeCount + (c.free || c.price <= 0 ? 1 : 0), count: a.count + 1 };
  }, { material: 0, cost: 0, revenue: 0, profit: 0, loss: 0, freeCount: 0, count: 0 });
  const seen = new Set(); let mwFromProjects = 0;
  allProj.forEach(p => { if (p.design_id && !seen.has(p.design_id)) { seen.add(p.design_id); mwFromProjects += p.calc.mwEarned || 0; } });
  for (const k of ['material','cost','revenue','profit','loss']) projectStats[k] = +projectStats[k].toFixed(2);
  projectStats.mwFromProjects = +mwFromProjects.toFixed(2);
  projectStats.grandTotal = +(projectStats.revenue - projectStats.material + mwFromProjects).toFixed(2);
  const freeButEarning = allProj.filter(p => (p.calc.free || p.calc.price <= 0) && (p.calc.mwEarned || 0) > 0)
    .map(p => ({ id: p.id, title: p.title, contact_name: p.contact_name, model_title: p.model_title, design_id: p.design_id, mwEarned: p.calc.mwEarned, material: p.calc.material, net: +((p.calc.mwEarned || 0) - p.calc.material).toFixed(2) }))
    .sort((a, b) => b.mwEarned - a.mwEarned);

  // Projekte, deren (privat entstandenes) Modell auf MakerWorld Geld/Credits macht.
  // Union aus primaerem Modell + Modellen der Druckpositionen; nur echte Modelle.
  const realModel = db.prepare("SELECT title, COALESCE(planned,0) planned FROM models WHERE design_id=?");
  const itemDesigns = db.prepare("SELECT DISTINCT design_id FROM project_items WHERE project_id=? AND design_id IS NOT NULL");
  const projectModels = [];
  active.forEach(p => {
    const ids = new Set(); if (p.design_id) ids.add(p.design_id);
    itemDesigns.all(p.id).forEach(r => ids.add(r.design_id));
    ids.forEach(did => {
      const m = realModel.get(did); if (!m || m.planned) return;
      const e = modelEarned(did); if (!e) return;
      const isPrimary = did === p.design_id;
      const invest = isPrimary ? p.calc.material : 0;   // Material nur einmal (Primaermodell) gegenrechnen
      projectModels.push({ project_id: p.id, title: p.title, contact_name: p.contact_name,
        design_id: did, model_title: m.title, downloads: e.download, points: e.point, mwEarned: e.earned,
        material: +invest.toFixed(2), net: +(e.earned - invest).toFixed(2),
        free: !!(p.calc.free || p.calc.price <= 0), paid: !!p.paid, price: p.calc.price || 0 });
    });
  });
  projectModels.sort((a, b) => b.mwEarned - a.mwEarned);
  const projectModelsTotal = +projectModels.reduce((a, r) => a + r.mwEarned, 0).toFixed(2);

  res.json({ total, paid, open, monthly, bySource, byContact, byModel, projectStats, freeButEarning,
    projectModels, projectModelsTotal,
    contacts: db.prepare('SELECT COUNT(*) c FROM contacts').get().c,
    openLeads: db.prepare("SELECT COUNT(*) c FROM contacts WHERE stage NOT IN ('gewonnen','verloren')").get().c });
});

// Modell-Vorschlaege fuer ein Projekt (Titel-Aehnlichkeit)
crm.get('/crm/model-suggestions', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().split(/[^a-z0-9äöü]+/).filter(w => w.length > 2);
  const models = db.prepare("SELECT design_id, title FROM models WHERE COALESCE(planned,0)=0").all();
  const scored = models.map(m => { const t = (m.title || '').toLowerCase(); const score = q.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0);
    return { ...m, score }; }).filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  res.json(scored);
});
// Projekt als "auf MakerWorld veroeffentlicht" markieren; ohne Modell -> geplantes Produkt anlegen
crm.post('/crm/projects/:id/publish', (req, res) => {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'unbekannt' });
  let design_id = p.design_id;
  if (!design_id) {
    const pid = 'plan_' + Date.now().toString(36);
    db.prepare(`INSERT INTO models(design_id,title,status,planned,created_at,updated_at) VALUES(?,?,?,1,?,?)`)
      .run(pid, p.title, 'idee', nowIso(), nowIso());
    design_id = pid;
  }
  db.prepare('UPDATE projects SET published=1, design_id=? WHERE id=?').run(design_id, req.params.id);
  res.json(projectWithCalc(db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id), calcSettings()));
});

// Auftraege/Projekte zu einem Modell (Modell <-> Kunde-Verknuepfung)
crm.get('/crm/model/:design_id', (req, res) => {
  const orders = db.prepare(`SELECT o.*, (o.qty*o.unit_price) amount, c.name contact_name FROM orders o
    JOIN contacts c ON c.id=o.contact_id WHERE o.design_id=? ORDER BY o.order_date DESC`).all(req.params.design_id);
  const projects = db.prepare(`SELECT p.*, c.name contact_name FROM projects p
    JOIN contacts c ON c.id=p.contact_id WHERE p.design_id=? ORDER BY p.id DESC`).all(req.params.design_id);
  res.json({ orders, projects });
});
