// API-Tests gegen eine frische Demo-Datenbank. Ausfuehren:  npm test
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startApp } from './helpers.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); app.cleanup(); });

const ok = r => { assert.ok(r.status >= 200 && r.status < 300, `HTTP ${r.status}: ${r.text.slice(0, 200)}`); return r.body; };

describe('Sicherheit (ohne Passwort)', () => {
  it('erlaubt lokale/private Hostnamen', async () => {
    for (const h of ['localhost', 'raspberrypi.local', 'host.lan', 'box.fritz.box', '192.168.1.5', '10.0.0.2', '172.20.1.1', '100.101.102.103', 'mypi', 'x.tail1234.ts.net'])
      assert.equal((await app.raw('GET', '/api/settings', { Host: h + ':4000' })).status, 200, h);
  });
  it('blockt fremde Hostnamen (DNS-Rebinding)', async () => {
    for (const h of ['evil.example.com', '8.8.8.8', '192.168.1.5.evil.com', '172.32.0.1'])
      assert.equal((await app.raw('GET', '/api/settings', { Host: h })).status, 403, h);
  });
  it('blockt schreibende Anfragen mit fremder Herkunft (CSRF)', async () => {
    const body = JSON.stringify({ name: 'x' }), h = { 'content-type': 'application/json' };
    assert.equal((await app.raw('POST', '/api/views', { ...h, Origin: 'https://evil.example.com' }, body)).status, 403);
    assert.equal((await app.raw('POST', '/api/views', { ...h, Origin: 'null' }, body)).status, 403);
    assert.equal((await app.raw('DELETE', '/api/views/1', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.notEqual((await app.raw('POST', '/api/views', { ...h, Origin: app.base }, JSON.stringify({ name: 'ok', config: {} }))).status, 403);
  });
  it('setzt Sicherheits-Header und kennt keine Alt-Importe mehr', async () => {
    const r = await app.raw('GET', '/');
    assert.equal(r.headers['x-frame-options'], 'DENY'); assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.equal(r.headers['x-powered-by'], undefined);
    assert.equal((await app.api('POST', '/import', {})).status, 404); assert.equal((await app.api('POST', '/ingest', {})).status, 404);
  });
  it('begrenzt JSON-Bodies (2 MB) und liefert JSON-Fehler', async () => {
    const big = await app.api('POST', '/views', { a: 'x'.repeat(3_000_000) }); assert.equal(big.status, 413); assert.ok(big.body.error);
    const bad = await app.raw('POST', '/api/views', { 'content-type': 'application/json' }, '{kaputt'); assert.equal(bad.status, 400); assert.ok(JSON.parse(bad.text).error);
  });
});

describe('Systemstatus & Pull', () => {
  it('liefert Health mit Feldern und Hinweisen', async () => {
    const h = ok(await app.api('GET', '/health'));
    for (const k of ['dbBytes', 'diskFreeGb', 'issues', 'lastRun', 'backup']) assert.ok(k in h, k);
    assert.ok(h.dbBytes < 50e6);
  });
  it('cancel ohne laufenden Pull meldet ok:false', async () => { assert.equal(ok(await app.api('POST', '/pull/cancel')).ok, false); });
});

describe('Kalkulation (nur auf dem Server)', () => {
  it('/crm/calc stimmt bei allen Projekten mit der gespeicherten Kalkulation ueberein', async () => {
    const projs = ok(await app.api('GET', '/crm/projects')); assert.ok(projs.length > 0);
    for (const p of projs) {
      const r = ok(await app.api('POST', '/crm/calc', { project: p, parts: p.parts, items: p.items }));
      for (const k of ['material', 'cost', 'suggestion', 'price', 'profit', 'loss']) assert.ok(Math.abs((r[k] || 0) - (p.calc[k] || 0)) < 0.006, `${p.title}.${k}: ${r[k]} vs ${p.calc[k]}`);
    }
  });
  it('versteht leere Felder, Standard-Stufe, kostenlos und Exklusiv-Aufschlag', async () => {
    const s = ok(await app.api('GET', '/crm/settings')); assert.equal(s.tiers.filter(t => t.default).length, 1); assert.ok(s.default_tier);
    const a = ok(await app.api('POST', '/crm/calc', { project: { filament_g: '100', print_hours: '2', labor_hours: '', margin_tier: s.default_tier, price: '' }, parts: [{ qty: 2, unit_price: 0.5 }], items: [] }));
    assert.ok(Math.abs(a.material - (0.1 * s.filament_price_kg + 1 + 2 * s.energy_rate_h)) < 0.011); assert.equal(a.price, a.suggestion);
    const f = ok(await app.api('POST', '/crm/calc', { project: { filament_g: 100, margin_tier: 'kostenlos', price: '' } })); assert.ok(f.free && f.price === 0 && f.loss < 0);
    const e = ok(await app.api('POST', '/crm/calc', { project: { no_upload: true, no_upload_fee: 5, margin_tier: 'kostenlos' } })); assert.equal(e.exclusiveFee, 5);
  });
  it('erzwingt genau eine Standard-Stufe', async () => {
    const r = ok(await app.api('POST', '/crm/settings', { tiers: [{ name: 'A', margin: 0.1 }, { name: 'B', margin: 0.2, default: true }, { name: 'C', margin: 0.3, default: true }] }));
    assert.equal(r.tiers.filter(t => t.default).length, 1);
  });
});

describe('Projekte, Zahlung, Rechnung, Aufgaben', () => {
  let cid, pid, p2;
  before(async () => {
    cid = ok(await app.api('POST', '/contacts', { name: 'T Kunde' })).id;
    pid = ok(await app.api('POST', '/projects', { contact_id: cid, title: 'T Projekt', price: 12 })).id;
    p2 = ok(await app.api('POST', '/projects', { contact_id: cid, title: 'T Projekt 2' })).id;
  });
  it('setzt und leert paid_at', async () => {
    const get = () => app.db().prepare('SELECT paid_at FROM projects WHERE id=?').get(pid).paid_at;
    assert.equal(get(), null); ok(await app.api('PUT', `/projects/${pid}`, { paid: 1 })); assert.equal(get(), new Date().toISOString().slice(0, 10));
    ok(await app.api('PUT', `/projects/${pid}`, { paid: 0 })); assert.equal(get(), null);
  });
  it('vergibt Rechnungsnummern stabil je Projekt', async () => {
    const a = ok(await app.api('POST', `/crm/projects/${pid}/invoice-number`, {})), b = ok(await app.api('POST', `/crm/projects/${pid}/invoice-number`, {}));
    assert.deepEqual(a, b); const c = ok(await app.api('POST', `/crm/projects/${p2}/invoice-number`, {})); assert.equal(c.number, a.number + 1);
  });
  it('zeigt Bezug (Kunde/Projekt) an Aufgaben', async () => {
    ok(await app.api('POST', '/todos', { project_id: pid, contact_id: cid, title: 'T Aufgabe' }));
    assert.equal(ok(await app.api('GET', `/project/${pid}`)).todos[0].contact_name, 'T Kunde');
    assert.equal(ok(await app.api('GET', `/contact/${cid}`)).todos[0].project_title, 'T Projekt');
  });
  it('bucht Spulen beim Druck ab und beim Zuruecknehmen zurueck', async () => {
    const sp = ok(await app.api('POST', '/spools', { material: 'PLA', color: 'T', total_g: 1000, remaining_g: 500 }));
    const it = ok(await app.api('POST', `/projects/${pid}/items`, { label: 'T Pos', qty: 2, weight_g: 100, print_min: 10 })).items[0];
    assert.equal(ok(await app.api('POST', '/crm/production/print', { item_id: it.id, spool_id: sp.id })).spool.remaining_g, 400);
    assert.equal(ok(await app.api('POST', '/crm/production/unprint', { item_id: it.id })).spool.remaining_g, 500);
    assert.equal(ok(await app.api('POST', '/crm/production/unprint', { item_id: it.id })).spool, null);
  });
  it('Suche: Mindestlaenge, Wildcards, Eigenprojekte', async () => {
    assert.deepEqual(ok(await app.api('GET', '/search?q=a')), { models: [], contacts: [], projects: [] });
    const w = ok(await app.api('GET', '/search?q=%25%25%25')); assert.equal(w.models.length + w.contacts.length + w.projects.length, 0);
    const sp = ok(await app.api('POST', '/projects', { self: 1, title: 'T Eigenprojekt Suche' }));
    assert.ok(ok(await app.api('GET', '/search?q=Eigenprojekt%20Suche')).projects.some(x => x.contact_name === 'Eigenprojekt'));
    ok(await app.api('DELETE', `/projects/${sp.id}`));
  });
});

describe('Papierkorb (30 Tage, Wiederherstellen)', () => {
  it('Kunde samt Projekt, Positionen, Druckprotokoll, Aufgaben und 3mf-Datei: loeschen -> zurueck', async () => {
    const cid = ok(await app.api('POST', '/contacts', { name: 'Trash Kunde' })).id;
    const pid = ok(await app.api('POST', '/projects', { contact_id: cid, title: 'Trash Projekt', price: 20 })).id;
    const part = ok(await app.api('POST', '/parts', { name: 'Trash Teil', unit_price: 1.5 }));
    ok(await app.api('POST', `/projects/${pid}/parts`, { part_id: part.id, qty: 2 }));
    const iid = ok(await app.api('POST', `/projects/${pid}/items`, { label: 'Pos', qty: 2, weight_g: 50, print_min: 10 })).items[0].id;
    const sp = ok(await app.api('POST', '/spools', { material: 'PLA', color: 'Trash', total_g: 1000, remaining_g: 500 }));
    ok(await app.api('POST', '/crm/production/print', { item_id: iid, spool_id: sp.id }));
    ok(await app.api('POST', '/todos', { project_id: pid, contact_id: cid, title: 'Trash Aufgabe' })); ok(await app.api('POST', '/todos', { contact_id: cid, title: 'Trash Kundenaufgabe' }));
    ok(await app.api('POST', `/projects/${pid}/file`, { name: 'a.3mf', data: 'data:application/octet-stream;base64,' + Buffer.from('PK-test').toString('base64') }));
    const file = path.join(app.dataDir, 'project_files', String(pid), 'a.3mf'); assert.ok(fs.existsSync(file));
    const count = () => { const d = app.db(); const c = (t, w) => d.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${w}`).get().c;
      const r = [c('contacts', `id=${cid}`), c('projects', `id=${pid}`), c('project_parts', `project_id=${pid}`), c('project_items', `project_id=${pid}`), c('print_log', `item_id=${iid}`), c('todos', "title LIKE 'Trash %'")]; d.close(); return r; };
    assert.deepEqual(count(), [1, 1, 1, 1, 1, 2]);
    const del = ok(await app.api('DELETE', `/contacts/${cid}`)); assert.ok(del.trash_id);
    assert.deepEqual(count(), [0, 0, 0, 0, 0, 0]); assert.ok(!fs.existsSync(file));
    assert.ok(ok(await app.api('GET', '/trash')).some(t => t.id === del.trash_id && t.kind === 'contact' && t.days_left >= 29));
    assert.equal(ok(await app.api('POST', `/trash/${del.trash_id}/restore`)).ok, true);
    assert.deepEqual(count(), [1, 1, 1, 1, 1, 2]); assert.ok(fs.existsSync(file));
    assert.equal((await app.api('POST', `/trash/${del.trash_id}/restore`)).status, 404);
  });
  it('Einzelobjekte: Aufgabe, Ausgabe, Auszahlung, Bauteil, Spule, Eintrag, Segment, geplantes Modell', async () => {
    const makers = {
      todos: [async () => ok(await app.api('POST', '/todos', { title: 'T einzel' })).id, '/todos'],
      expenses: [async () => ok(await app.api('POST', '/expenses', { description: 'T', amount: 3 })).id, '/expenses'],
      payouts: [async () => ok(await app.api('POST', '/payouts', { points: 1, amount: 1 })).id, '/payouts'],
      parts: [async () => ok(await app.api('POST', '/parts', { name: 'T Teil 2' })).id, '/parts'],
      spools: [async () => ok(await app.api('POST', '/spools', { material: 'PLA', color: 'T2' })).id, '/spools'],
      events: [async () => ok(await app.api('POST', '/events', { date: '2026-01-01', title: 'T ev' })).id, '/events'],
      views: [async () => ok(await app.api('POST', '/views', { name: 'T view', config: {} })).id, '/views']
    };
    for (const [table, [make, route]] of Object.entries(makers)) {
      const id = await make(), has = () => { const d = app.db(); const n = d.prepare(`SELECT COUNT(*) c FROM ${table} WHERE id=?`).get(id).c; d.close(); return n; };
      const del = ok(await app.api('DELETE', `${route}/${id}`)); assert.ok(del.trash_id, table); assert.equal(has(), 0, table);
      ok(await app.api('POST', `/trash/${del.trash_id}/restore`)); assert.equal(has(), 1, table);
    }
    const pm = ok(await app.api('POST', '/products/plan', { title: 'T Plan Modell' })); ok(await app.api('POST', '/todos', { design_id: pm.design_id, title: 'T Plan Aufgabe' }));
    const del = ok(await app.api('DELETE', `/products/${pm.design_id}`)); assert.ok(del.trash_id);
    ok(await app.api('POST', `/trash/${del.trash_id}/restore`));
    const d = app.db(); assert.equal(d.prepare('SELECT COUNT(*) c FROM models WHERE design_id=?').get(pm.design_id).c, 1); assert.equal(d.prepare("SELECT COUNT(*) c FROM todos WHERE design_id=?").get(pm.design_id).c, 1); d.close();
  });
  it('endgueltig loeschen und Aufraeumen nach 30 Tagen', async () => {
    const t1 = ok(await app.api('DELETE', `/todos/${ok(await app.api('POST', '/todos', { title: 'T purge' })).id}`)).trash_id;
    assert.equal(ok(await app.api('DELETE', `/trash/${t1}`)).ok, true); assert.ok(!ok(await app.api('GET', '/trash')).some(t => t.id === t1));
    const t2 = ok(await app.api('DELETE', `/todos/${ok(await app.api('POST', '/todos', { title: 'T alt' })).id}`)).trash_id;
    const d = app.db(); d.prepare("UPDATE trash SET created_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(t2); d.close();
    ok(await app.api('GET', '/trash')); const d2 = app.db(); assert.equal(d2.prepare('SELECT COUNT(*) c FROM trash WHERE id=?').get(t2).c, 0); d2.close();
  });
});

describe('Auswertungen', () => {
  it('Gruppen (Kategorie/eigene Gruppe/Hashtag) ohne doppelte Schluessel; Zeitreihen im Gruppenmodus', async () => {
    for (const by of ['category', 'group', 'tag']) { const r = ok(await app.api('GET', '/analytics/groups?by=' + by)); const k = r.rows.map(x => x.key); assert.equal(k.length, new Set(k).size, by); }
    assert.ok(ok(await app.api('GET', '/timeseries?group=tag&metric=view')).series.length > 0);
  });
  it('Gutschein-ETA kommt ueberall aus derselben Berechnung', async () => {
    const t = ok(await app.api('GET', '/overview')).totals;
    const ins = ok(await app.api('GET', '/insights')).insights.find(i => i.kind === 'voucher');
    if (t.voucher_eta_days != null && ins) assert.ok(ins.text.includes(String(t.voucher_eta_days)), `${ins.text} vs ${t.voucher_eta_days}`);
  });
  it('Alerts nur ueber /today; Stillstand nur bei unwahrscheinlicher Null', async () => {
    assert.ok(!('alerts' in ok(await app.api('GET', '/overview'))));
    const m = ok(await app.api('GET', '/overview')).models.find(x => x.dl30 === 0 && x.publish_date) ;
    const d = app.db(); const row = d.prepare('SELECT design_id FROM models WHERE design_id=?').get(m ? m.design_id : null);
    if (row) { // kuenstlicher Fall: sehr viele Downloads, aber 0 in 30 Tagen -> Stillstand; wenige -> kein Stillstand
      const sid = d.prepare('SELECT MAX(id) id FROM snapshots WHERE design_id=?').get(row.design_id).id;
      d.prepare('UPDATE snapshots SET download=5000 WHERE id=?').run(sid); d.prepare("UPDATE daily_metrics SET download=0 WHERE design_id=? AND date>=date('now','-40 day')").run(row.design_id);
      assert.ok(ok(await app.api('GET', '/today')).alerts.some(a => a.type === 'stall' && a.design_id === row.design_id));
      d.prepare('UPDATE snapshots SET download=2 WHERE id=?').run(sid);
      assert.ok(!ok(await app.api('GET', '/today')).alerts.some(a => a.type === 'stall' && a.design_id === row.design_id));
    }
    d.close();
  });
  it('schlanke Endpunkte entsprechen dem Modell-Detail', async () => {
    const id = ok(await app.api('GET', '/overview')).models[0].design_id, full = ok(await app.api('GET', '/model/' + id));
    assert.deepEqual(ok(await app.api('GET', `/model/${id}/instances`)), full.instances); assert.ok(Array.isArray(ok(await app.api('GET', `/model/${id}/todos`))));
    assert.ok('earned' in (ok(await app.api('GET', `/crm/model-earned/${id}`)) || {}));
  });
  it('Finanzen: MakerWorld-Ertrag in Karte und Tabelle identisch', async () => {
    const r = ok(await app.api('GET', '/crm/revenue')); assert.equal(r.projectStats.mwFromProjects, r.projectModelsTotal); assert.ok(!('freeButEarning' in r));
  });
});
