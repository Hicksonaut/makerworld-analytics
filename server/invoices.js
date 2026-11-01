// Rechnungsarchiv, Mahnwesen und Steuer-Export (Einnahmenueberschussrechnung als CSV).
import express from 'express';
import { db, getSetting, nowIso } from './db.js';
import { T, lang } from './i18n.js';
import { projectWithCalc, calcSettings } from './crm.js';

const app = express.Router();
export const router = app;

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const termDays = () => Math.max(0, +getSetting('invoice_terms_days', '14') || 0);
const r2 = x => +(+x || 0).toFixed(2);

// Eine Zeile je Rechnung (aus Schnappschuss, sonst aus dem Projekt nachgetragen).
function rows() {
  const t = todayIso();
  const projs = db.prepare(`SELECT p.*, c.name contact_name FROM projects p LEFT JOIN contacts c ON c.id=p.contact_id WHERE p.invoice_no IS NOT NULL`).all();
  const snaps = Object.fromEntries(db.prepare('SELECT id, project_id, no, date, due_date, customer, title, total, reminder_level, last_reminder_at, html IS NOT NULL has_html FROM invoices').all().map(r => [r.project_id, r]));
  const s = calcSettings();
  return projs.map(p => {
    const sn = snaps[p.id];
    const date = sn?.date || p.invoice_date || (p.created_at || '').slice(0, 10);
    const total = sn ? sn.total : r2(projectWithCalc(p, s).calc.price);
    const due = sn?.due_date || addDays(date, termDays());
    const paid = !!p.paid, overdueDays = !paid && due < t ? Math.round((Date.parse(t) - Date.parse(due)) / 86400000) : 0;
    return { project_id: p.id, no: p.invoice_no, date, due_date: due, customer: sn?.customer || p.contact_name || '', title: sn?.title || p.title, total: r2(total),
      paid, paid_at: p.paid_at || null, status: paid ? 'paid' : overdueDays ? 'overdue' : 'open', overdue_days: overdueDays,
      reminder_level: sn?.reminder_level || 0, last_reminder_at: sn?.last_reminder_at || null, archived: !!sn?.has_html };
  }).sort((a, b) => b.no - a.no);
}
export const overdueInvoices = () => rows().filter(r => r.status === 'overdue' && r.total > 0);

app.get('/api/crm/invoices', (req, res) => {
  let list = rows();
  if (req.query.year) list = list.filter(r => String(r.date).startsWith(String(req.query.year)));
  res.json({ items: list, terms_days: termDays(), years: [...new Set(rows().map(r => String(r.date).slice(0, 4)))].sort().reverse(),
    open_total: r2(list.filter(r => !r.paid).reduce((a, r) => a + r.total, 0)), overdue_total: r2(list.filter(r => r.status === 'overdue').reduce((a, r) => a + r.total, 0)) });
});

// Schnappschuss der erzeugten Rechnung ablegen (erste Erstellung) bzw. bewusst neu erzeugen.
app.post('/api/crm/projects/:id/invoice', (req, res) => {
  const p = db.prepare('SELECT id, invoice_no, invoice_date FROM projects WHERE id=?').get(req.params.id);
  if (!p || !p.invoice_no) return res.status(404).json({ error: T('Rechnungsnummer fehlt', 'invoice number missing') });
  const b = req.body || {}; if (typeof b.html !== 'string' || b.html.length < 20 || b.html.length > 500000) return res.status(400).json({ error: T('HTML fehlt', 'html missing') });
  const date = p.invoice_date || todayIso();
  const prev = db.prepare('SELECT id FROM invoices WHERE project_id=?').get(p.id);
  if (prev) db.prepare('UPDATE invoices SET html=?, total=?, customer=?, title=? WHERE id=?').run(b.html, r2(b.total), String(b.customer || ''), String(b.title || ''), prev.id);
  else db.prepare('INSERT INTO invoices(project_id,no,date,due_date,customer,title,total,html,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(p.id, p.invoice_no, date, addDays(date, termDays()), String(b.customer || ''), String(b.title || ''), r2(b.total), b.html, nowIso());
  res.json({ ok: true });
});
app.get('/api/crm/projects/:id/invoice', (req, res) => {
  const r = db.prepare('SELECT html, no, date, due_date, total, customer, title, reminder_level FROM invoices WHERE project_id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: T('Keine gespeicherte Rechnung', 'no stored invoice') });
  res.json(r);
});
// Mahnstufe erhoehen; die Mahnung selbst erzeugt der Browser (Layout wie die Rechnung).
app.post('/api/crm/projects/:id/remind', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE project_id=?').get(req.params.id);
  const base = rows().find(r => r.project_id === +req.params.id);
  if (!base) return res.status(404).json({ error: T('Keine Rechnung', 'no invoice') });
  if (base.paid) return res.status(400).json({ error: T('Bereits bezahlt', 'already paid') });
  const level = (inv?.reminder_level || 0) + 1;
  if (inv) db.prepare('UPDATE invoices SET reminder_level=?, last_reminder_at=? WHERE id=?').run(level, nowIso(), inv.id);
  else db.prepare('INSERT INTO invoices(project_id,no,date,due_date,customer,title,total,reminder_level,last_reminder_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(base.project_id, base.no, base.date, base.due_date, base.customer, base.title, base.total, level, nowIso(), nowIso());
  res.json({ level, pay_by: addDays(todayIso(), 7), invoice: base });
});

// ---- Steuer-Export (Einnahmenueberschussrechnung, Zuflussprinzip) --------------------------------------------
// Einnahmen = bezahlte Projekte (am Zahlungsdatum) + MakerWorld-Auszahlungen; Ausgaben = erfasste Betriebsausgaben.
// Dieselben Quellen und Regeln wie /crm/pnl, damit beide Seiten identische Summen zeigen.
export function euer(year) {
  const y = String(year);
  const inc = db.prepare(`SELECT p.title, p.price amount, p.invoice_no, c.name customer, COALESCE(p.paid_at,p.due_date,substr(p.created_at,1,10)) d
    FROM projects p LEFT JOIN contacts c ON c.id=p.contact_id WHERE p.paid=1 AND p.price>0`).all().filter(r => (r.d || '').startsWith(y))
    .map(r => ({ date: r.d, kind: 'income', category: T('Projekteinnahmen', 'Project income'), text: [r.title, r.customer].filter(Boolean).join(' · '), ref: r.invoice_no ? 'RE-' + r.invoice_no : '', amount: r2(r.amount) }));
  const pay = db.prepare('SELECT date d, amount, note FROM payouts').all().filter(r => (r.d || '').startsWith(y))
    .map(r => ({ date: r.d, kind: 'income', category: T('MakerWorld-Auszahlung', 'MakerWorld payout'), text: r.note || T('Punkte-Einlösung', 'Points redemption'), ref: '', amount: r2(r.amount) }));
  const catName = c => ({ filament: T('Filament', 'Filament'), drucker: T('Drucker', 'Printer'), zubehoer: T('Zubehör', 'Accessories'), versand: T('Versand', 'Shipping'), sonstiges: T('Sonstiges', 'Other') }[c] || c || T('Sonstiges', 'Other'));
  const exp = db.prepare('SELECT date d, amount, category, description FROM expenses').all().filter(r => (r.d || '').startsWith(y))
    .map(r => ({ date: r.d, kind: 'expense', category: catName(r.category), text: r.description || '', ref: '', amount: r2(r.amount) }));
  const lines = [...inc, ...pay, ...exp].sort((a, b) => a.date.localeCompare(b.date));
  const sum = k => r2(lines.filter(l => l.kind === k).reduce((a, l) => a + l.amount, 0));
  const group = k => Object.entries(lines.filter(l => l.kind === k).reduce((a, l) => (a[l.category] = (a[l.category] || 0) + l.amount, a), {})).map(([category, s]) => ({ category, sum: r2(s) })).sort((a, b) => b.sum - a.sum);
  const income = sum('income'), expense = sum('expense');
  const openRec = rows().filter(r => !r.paid && String(r.date).startsWith(y)).reduce((a, r) => a + r.total, 0);
  return { year: +y, income, expense, profit: r2(income - expense), incomeByCategory: group('income'), expenseByCategory: group('expense'), lines, open_receivables: r2(openRec) };
}
app.get('/api/crm/euer', (req, res) => res.json(euer(req.query.year || new Date().getFullYear())));
app.get('/api/crm/euer.csv', (req, res) => {
  const e = euer(req.query.year || new Date().getFullYear()), de = lang() === 'de';
  const fmt = n => (de ? n.toFixed(2).replace('.', ',') : n.toFixed(2));
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const dt = iso => de ? iso.split('-').reverse().join('.') : iso;
  const out = [[T('Datum', 'Date'), T('Art', 'Type'), T('Kategorie', 'Category'), T('Beschreibung', 'Description'), T('Beleg', 'Reference'), T('Betrag EUR', 'Amount EUR')].map(q).join(';')];
  for (const l of e.lines) out.push([dt(l.date), l.kind === 'income' ? T('Einnahme', 'Income') : T('Ausgabe', 'Expense'), l.category, l.text, l.ref, fmt(l.kind === 'income' ? l.amount : -l.amount)].map(q).join(';'));
  out.push('', [q(T('Summe Einnahmen', 'Total income')), '', '', '', '', fmt(e.income)].join(';'), [q(T('Summe Ausgaben', 'Total expenses')), '', '', '', '', fmt(-e.expense)].join(';'),
    [q(T('Gewinn / Verlust', 'Profit / loss')), '', '', '', '', fmt(e.profit)].join(';'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="EUER_${e.year}.csv"`);
  res.send('﻿' + out.join('\r\n') + '\r\n');
});
