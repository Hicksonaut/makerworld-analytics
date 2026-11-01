// Tests fuer Experimente (Hypothese -> Urteil), Rechnungsarchiv/Mahnwesen und Steuer-Export. Ausfuehren: npm test
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); app.cleanup(); });
const ok = r => { assert.ok(r.status >= 200 && r.status < 300, `HTTP ${r.status}: ${r.text.slice(0, 200)}`); return r.body; };
const iso = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

describe('Experimente', () => {
  const ids = {};
  before(() => {
    // Je Modell 14 Tage vor und 14 Tage nach einer Aenderung (Aenderung vor 30 Tagen): imp/Tag, Views vorher/nachher
    const d = app.db(); const ins = d.prepare('INSERT INTO daily_metrics(design_id,date,impression,view,download) VALUES(?,?,?,?,?)');
    const mk = (id, impB, vB, impA, vA) => { for (let k = 1; k <= 14; k++) { ins.run(id, iso(30 + k), impB, vB, 1); ins.run(id, iso(30 - k + 1), impA, vA, 2); } };
    mk('x-helped', 1000, 30, 1000, 50); mk('x-neutral', 1000, 40, 1000, 41); mk('x-hurt', 1000, 50, 1000, 30); mk('x-nodata', 10, 1, 10, 3);
    d.close();
  });
  const add = async (design_id, over = {}) => ok(await app.api('POST', '/events', { design_id, date: iso(30), type: 'thumbnail', title: 'Test ' + design_id, hypothesis: 'H ' + design_id, eval_days: 14, ...over }));

  it('urteilt per z-Test: geholfen / neutral / schadet / zu wenig Daten', async () => {
    for (const k of ['helped', 'neutral', 'hurt', 'nodata']) ids[k] = (await add('x-' + k)).id;
    const items = ok(await app.api('GET', '/experiments')).items;
    const by = k => items.find(i => i.id === ids[k]);
    assert.equal(by('helped').verdict, 'helped'); assert.equal(by('neutral').verdict, 'neutral'); assert.equal(by('hurt').verdict, 'hurt');
    assert.equal(by('nodata').status, 'nodata');
    assert.ok(by('helped').z > 1.645 && by('hurt').z < -1.645);
    assert.equal(by('helped').before.ctr, 3); assert.equal(by('helped').after.ctr, 5);
  });
  it('laufende Experimente haben keinen Urteilsspruch, nur Restlaufzeit', async () => {
    const e = await add('x-helped', { date: iso(3), title: 'laeuft' });
    const x = ok(await app.api('GET', '/experiments?design_id=x-helped')).items.find(i => i.id === e.id);
    assert.equal(x.status, 'running'); assert.equal(x.verdict, null); assert.ok(x.daysLeft > 0 && x.daysLeft <= 12);
  });
  it('markiert gleichzeitige weitere Aenderungen als Stoerfaktor', async () => {
    const e = await add('x-helped', { date: iso(34), title: 'davor' });
    const items = ok(await app.api('GET', '/experiments?design_id=x-helped')).items;
    assert.equal(items.find(i => i.id === ids.helped).confounded, true);
    assert.ok(items.find(i => i.id === e.id));
  });
  it('Lernbilanz fasst je Aenderungstyp zusammen', async () => {
    const s = ok(await app.api('GET', '/experiments')).summary.find(x => x.type === 'thumbnail');
    assert.ok(s.n >= 4 && s.helped >= 1 && s.hurt >= 1);
  });
  it('wertet beim Check nur Hypothesen-Experimente aus und merkt sich das Urteil einmalig', async () => {
    const first = ok(await app.api('POST', '/experiments/check')).new; assert.ok(first.length >= 3);
    assert.equal(ok(await app.api('POST', '/experiments/check')).new.length, 0);
    const d = app.db(); const row = d.prepare('SELECT verdict, evaluated_at FROM events WHERE id=?').get(ids.helped); d.close();
    assert.equal(row.verdict, 'helped'); assert.ok(row.evaluated_at);
  });
  it('Hypothese aendern setzt das Urteil zurueck; Insights nennen frisch ausgewertete Tests', async () => {
    const ins = ok(await app.api('GET', '/insights')).insights.filter(i => i.kind === 'experiment'); assert.ok(ins.length >= 1);
    ok(await app.api('PUT', `/events/${ids.helped}`, { hypothesis: 'neue Hypothese' }));
    const d = app.db(); const row = d.prepare('SELECT hypothesis, verdict FROM events WHERE id=?').get(ids.helped); d.close();
    assert.equal(row.hypothesis, 'neue Hypothese'); assert.equal(row.verdict, null);
  });
});

describe('Rechnungsarchiv, Mahnwesen, Steuer-Export', () => {
  let pid;
  before(async () => {
    const c = ok(await app.api('POST', '/contacts', { name: 'Archiv Kunde' }));
    pid = ok(await app.api('POST', '/projects', { contact_id: c.id, title: 'Archivprojekt', price: 25, qty: 1 })).id;
  });
  it('speichert die Rechnung als unveraenderlichen Schnappschuss mit stabiler Nummer', async () => {
    const n1 = ok(await app.api('POST', `/crm/projects/${pid}/invoice-number`, {})).number;
    ok(await app.api('POST', `/crm/projects/${pid}/invoice`, { html: '<html><body>Rechnung A</body></html>', total: 25, customer: 'Archiv Kunde', title: 'Archivprojekt' }));
    assert.equal(ok(await app.api('POST', `/crm/projects/${pid}/invoice-number`, {})).number, n1);
    const st = ok(await app.api('GET', `/crm/projects/${pid}/invoice`)); assert.match(st.html, /Rechnung A/); assert.equal(st.no, n1);
    const row = ok(await app.api('GET', '/crm/invoices')).items.find(i => i.project_id === pid);
    assert.equal(row.total, 25); assert.equal(row.status, 'open'); assert.equal(row.archived, true);
    assert.equal(row.due_date > row.date, true);
  });
  it('verweigert ungueltige Schnappschuesse', async () => {
    assert.equal((await app.api('POST', `/crm/projects/${pid}/invoice`, { html: 'x' })).status, 400);
    assert.equal((await app.api('POST', '/crm/projects/999999/invoice', { html: '<html>................</html>' })).status, 404);
  });
  it('Mahnstufen zaehlen hoch, ueberfaellige Rechnungen erscheinen in Heute + Digest, Bezahltes nicht', async () => {
    const d = app.db(); d.prepare("UPDATE invoices SET due_date=? WHERE project_id=?").run(iso(10), pid); d.close();
    const row = ok(await app.api('GET', '/crm/invoices')).items.find(i => i.project_id === pid);
    assert.equal(row.status, 'overdue'); assert.equal(row.overdue_days, 10);
    assert.equal(ok(await app.api('POST', `/crm/projects/${pid}/remind`, {})).level, 1);
    const r2 = ok(await app.api('POST', `/crm/projects/${pid}/remind`, {})); assert.equal(r2.level, 2); assert.ok(r2.pay_by > iso(0));
    const today = ok(await app.api('GET', '/today')); assert.equal(today.overdueInvoices.some(i => i.project_id === pid), true);
    assert.match(ok(await app.api('POST', '/digest/send', {})).text, /RE-\d+/);
    ok(await app.api('PUT', `/projects/${pid}`, { paid: 1 }));
    assert.equal((await app.api('POST', `/crm/projects/${pid}/remind`, {})).status, 400);
    assert.equal(ok(await app.api('GET', '/today')).overdueInvoices.some(i => i.project_id === pid), false);
  });
  it('EUER summiert wie die Gewinn-und-Verlust-Seite und exportiert CSV', async () => {
    const y = new Date().getFullYear();
    ok(await app.api('POST', '/expenses', { date: `${y}-03-05`, category: 'filament', description: 'PLA "Weiss"; 2 kg', amount: 40 }));
    ok(await app.api('POST', '/payouts', { date: `${y}-04-01`, points: 524, amount: 40, note: 'Gutschein' }));
    const e = ok(await app.api('GET', `/crm/euer?year=${y}`));
    const pnl = ok(await app.api('GET', '/crm/pnl'));
    const pnlYear = k => +pnl.monthly.filter(m => m.m.startsWith(String(y))).reduce((a, m) => a + m[k], 0).toFixed(2);
    assert.equal(e.income, +(pnlYear('income') + pnlYear('payout')).toFixed(2)); assert.equal(e.expense, pnlYear('expense'));
    assert.equal(e.profit, +(e.income - e.expense).toFixed(2)); assert.ok(e.lines.some(l => l.ref.startsWith('RE-')));
    const csv = await app.api('GET', `/crm/euer.csv?year=${y}`);
    assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.headers.get('content-disposition'), new RegExp(`EUER_${y}\\.csv`));
    assert.ok((await app.raw('GET', `/api/crm/euer.csv?year=${y}`, { host: 'localhost' })).text.startsWith('﻿'));   // BOM fuer Excel (fetch entfernt ihn) assert.match(csv.text, /"PLA ""Weiss""; 2 kg"/); assert.match(csv.text, /;-40,00\r\n/);
    const en = await app.api('GET', `/crm/euer.csv?year=${y}`, undefined, { 'x-lang': 'en' }); assert.match(en.text, /;-40\.00\r\n/); assert.match(en.text, /Total income/);
  });
});
