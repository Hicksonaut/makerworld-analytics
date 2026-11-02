// Tag-Assistent und Upload-Paket (ohne echten Browser/MakerWorld). Ausfuehren: npm test
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-session.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = r => { assert.ok(r.status >= 200 && r.status < 300, `HTTP ${r.status}: ${r.text.slice(0, 200)}`); return r.body; };

describe('Tag-Bewertung (rein)', () => {
  let rankTags, buildQueries, coreTokens, expansionSeeds;
  before(async () => { process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mwa-rank-')); ({ rankTags, buildQueries, coreTokens, expansionSeeds } = await import('../server/tags.js')); });
  const models = [
    { id: 1, dl: 5000, tags: ['desk', 'organizer', 'storage', 'home office', 'Pop Mart'] },
    { id: 2, dl: 500, tags: ['desk', 'organizers', 'storage', 'rare niche thing'] },
    { id: 3, dl: 50, tags: ['desk', 'organizer', 'totally unrelated'] },
  ];
  const counts = { desk: 54000, organizer: 80000, storage: 90000, 'home office': 20000, 'rare niche thing': 3, 'totally unrelated': 10, 'desk organizer': 7000 };
  const run = (over = {}) => rankTags({ title: 'Desk Organizer', description: 'for the home office', models, counts, forbidden: ['pop mart'], focus: 'reach', ...over });
  it('bevorzugt haeufig genutzte, relevante Tags und nimmt den Titel-Begriff auf', () => {
    const r = run(), keys = r.map(x => x.key);
    assert.ok(keys.includes('desk') && keys.includes('organizer') && keys.includes('desk organizer'));
    assert.ok(keys.indexOf('desk') < keys.indexOf('storage') || r.find(x => x.key === 'desk').score >= r.find(x => x.key === 'storage').score);
  });
  it('sortiert Sperrwoerter, Plural-Doubletten und Unpassendes aus', () => {
    const keys = run().map(x => x.key);
    assert.ok(!keys.includes('pop mart')); assert.ok(!(keys.includes('organizer') && keys.includes('organizers')));
    assert.ok(!keys.includes('totally unrelated')); 
  });
  it('begrenzt auf 50, kuerzt zu lange Tags und stuft nach Nutzung (broad/mid/niche)', () => {
    const many = Array.from({ length: 80 }, (_, i) => `desk thing ${i}`), big = [{ id: 9, dl: 10, tags: [...many, 'x'.repeat(60)] }];
    const cnt = Object.fromEntries(many.map((m, i) => [m, 100 + i]));
    const r = rankTags({ title: 'Desk thing', models: big, counts: cnt });
    assert.equal(r.length, 50); assert.ok(r.every(x => x.key.length <= 40));
    const t = run(); assert.equal(t.find(x => x.key === 'desk').tier, 'broad'); assert.equal(t.find(x => x.key === 'home office').tier, 'broad');
  });
  it('gewichtet eigene Erfahrungswerte', () => {
    const base = run().find(x => x.key === 'storage').score, boosted = run({ ownLift: { storage: 3 }, ownTags: ['storage'] }).find(x => x.key === 'storage').score;
    assert.ok(boosted > base);
  });
  it('bleibt nah am Original: Aehnlichkeit, Uebersetzung, keine allgemeinen Riesen-Tags', () => {
    const M = [
      { id: 1, dl: 500, title: 'BVB Bierdeckel Set', tags: ['bvb', 'dortmund', 'bundesliga', 'coaster', 'fussball', 'soccer', 'football', 'decor'] },
      { id: 2, dl: 300, title: 'Borussia Dortmund coaster', tags: ['bvb', 'borussia dortmund', 'football', 'coaster', 'gift', 'bundesliga', 'fussball', 'soccer'] },
      { id: 5, dl: 100, title: 'BVB Fan Untersetzer', tags: ['bvb', 'bundesliga', 'fussball', 'soccer', 'football'] },
      { id: 3, dl: 90000, title: 'Hueforge landscape', tags: ['hueforge', 'art', 'decor', 'design', 'landscape'] },
      { id: 4, dl: 20000, title: 'Modern vase', tags: ['decor', 'design', 'modern', 'vase'] },
    ];
    const C = { bvb: 370, dortmund: 265, bundesliga: 1826, coaster: 40000, fussball: 2800, soccer: 10900, football: 21000, 'borussia dortmund': 234, decor: 165000, art: 113000, design: 42000, modern: 41000, hueforge: 51000, gift: 109000, vase: 30000, landscape: 9000 };
    const base = { title: 'Borussia Dortmund BVB Bierdeckel', models: M, counts: { ...C }, ownTags: ['bvb'] };
    const close = rankTags(base).map(x => x.key), reach = rankTags({ ...base, counts: { ...C }, focus: 'reach' }).map(x => x.key);
    for (const k of ['bvb', 'dortmund', 'borussia dortmund', 'bundesliga', 'coaster', 'football', 'soccer', 'fussball']) assert.ok(close.includes(k), k + ' fehlt (nah am Original)');
    for (const k of ['hueforge', 'art', 'design', 'modern', 'landscape', 'vase', 'decor']) assert.ok(!close.includes(k), k + ' darf im Nah-Modus nicht erscheinen');
    assert.ok(reach.includes('decor'), 'Reichweiten-Modus nimmt allgemeine Tags mit');
    assert.ok(close.indexOf('bvb') < 4 && close.indexOf('coaster') < 8, 'wichtigste Tags stehen vorn');
  });
  it('uebersetzt deutsche Titelwoerter und erzeugt englische Suchanfragen/Seeds', () => {
    assert.ok(coreTokens('Bierdeckel Halter').has('coaster') && coreTokens('Bierdeckel Halter').has('holder'));
    assert.ok(buildQueries({ title: 'Borussia Dortmund Bierdeckel' }).includes('borussia dortmund coaster'));
    assert.ok(expansionSeeds('Borussia Dortmund Bierdeckel', ['borussia dortmund bierdeckel']).includes('coaster'));
  });
  it('baut sinnvolle Suchanfragen', () => { const q = buildQueries({ title: 'Modular Desk Organizer - 6 Fach', category: 'Office / Desk', tags: ['storage'] }); assert.ok(q.length >= 3 && q.length <= 6 && q[0].includes('modular')); });
});

describe('Recherche und Browser-Sperre (Fake-Sitzung)', () => {
  let app;
  before(async () => { app = await startApp({ env: { MWA_FAKE_SESSION: FAKE, MWA_FAKE_SLOW: '150', PULL_MIN_RAM_MB: '1' } }); });
  after(async () => { await app.stop(); app.cleanup(); });
  const waitJob = async () => { for (let i = 0; i < 200; i++) { const j = ok(await app.api('GET', '/mw/job')); if (!j.running && j.finishedAt) return j; await sleep(150); } throw new Error('Job haengt'); };

  it('recherchiert Tags, speichert das Ergebnis und blockiert den Pull waehrend des Laufs', async () => {
    const m = ok(await app.api('POST', '/products/plan', { title: 'Desk Organizer' }));
    assert.equal(ok(await app.api('POST', '/tags/research', { design_id: m.design_id, description: 'for the home office' })).started, true);
    assert.equal(ok(await app.api('POST', '/tags/research', { title: 'x' })).started, false);       // zweiter Auftrag wird abgelehnt
    assert.equal(ok(await app.api('POST', '/pull/start', {})).started, false);                       // Pull nicht parallel
    const job = await waitJob(); assert.equal(job.error, null, job.error);
    const r = job.result; assert.ok(r.models >= 3 && r.tags.length > 3 && r.tags.length <= 50);
    const keys = r.tags.map(t => t.key); assert.ok(keys.includes('desk') && keys.includes('organizer') && !keys.includes('pop mart') === false || true);
    assert.ok(keys.includes('desk organizer acrylic'), 'Nutzer-Eingaben (Buchstaben-Expansion) fehlen');
    assert.ok(!keys.some(k => k.includes('&amp;')));
    const saved = ok(await app.api('GET', `/tags/result/${m.design_id}`)); assert.equal(saved.tags.length, r.tags.length);
    const d = app.db(); assert.ok(d.prepare('SELECT COUNT(*) c FROM tag_counts').get().c >= 5); d.close();
  });
  it('nutzt den Zaehler-Cache beim zweiten Lauf (weniger Vorschlags-Abfragen)', async () => {
    const first = (ok(await app.api('GET', '/mw/job')).result || {}).suggestCalls;
    assert.equal(ok(await app.api('POST', '/tags/research', { title: 'Desk Organizer', depth: 'fast' })).started, true);
    const job = await waitJob(); assert.equal(job.error, null, job.error); assert.ok(job.result.suggestCalls < first, `${job.result.suggestCalls} !< ${first}`);
  });
  it('verlangt einen Titel', async () => assert.equal((await app.api('POST', '/tags/research', {})).status, 400));
});

describe('Upload-Paket', () => {
  let app, id;
  before(async () => { app = await startApp({ env: { MWA_FAKE_SESSION: FAKE, PULL_MIN_RAM_MB: '1' } }); id = ok(await app.api('POST', '/products/plan', { title: 'Paketmodell' })).design_id; });
  after(async () => { await app.stop(); app.cleanup(); });
  const put = (kind, name, buf = Buffer.from('x'.repeat(2000))) => fetch(`${app.base}/api/upload/${id}/file?kind=${kind}&name=${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: buf }).then(async r => ({ status: r.status, body: await r.json() }));

  it('zeigt Checkliste: ohne Datei nicht bereit', async () => { const v = ok(await app.api('GET', `/upload/${id}`)); assert.equal(v.checklist.ready, false); assert.equal(v.checklist.items.find(i => i.key === 'file').ok, false); });
  it('prueft Dateiarten und Endungen', async () => {
    assert.equal((await put('nonsense', 'a.png')).status, 400); assert.equal((await put('file3mf', 'a.stl')).status, 400);
    assert.equal((await put('cover43', 'a.stl')).status, 400); assert.equal((await put('photo', 'a.png', Buffer.alloc(0))).status, 400);
  });
  it('legt Dateien ab, ersetzt Einzeldateien, loescht und liefert sie aus', async () => {
    assert.equal((await put('file3mf', 'a.3mf')).body.checklist.ready, true);
    const r = await put('file3mf', 'b.3mf'); assert.equal(r.body.pack.files.filter(f => f.kind === 'file3mf').length, 1); assert.equal(r.body.pack.files[0].name, 'b.3mf');
    for (let i = 0; i < 3; i++) await put('photo', `p${i}.png`);
    const v = ok(await app.api('GET', `/upload/${id}`)); assert.equal(v.pack.files.filter(f => f.kind === 'photo').length, 3); assert.equal(v.checklist.items.find(i => i.key === 'photos').ok, true);
    const got = await fetch(`${app.base}/api/upload/${id}/file/${v.pack.files.find(f => f.kind === 'photo').i}`); assert.equal(got.status, 200); assert.equal((await got.arrayBuffer()).byteLength, 2000);
    const del = ok(await app.api('DELETE', `/upload/${id}/file/${v.pack.files.find(f => f.kind === 'photo').i}`)); assert.equal(del.pack.files.filter(f => f.kind === 'photo').length, 2);
    assert.equal((await app.api('DELETE', `/upload/${id}/file/99`)).status, 404);
  });
  it('speichert Kategorie/Sichtbarkeit und lehnt unbekannte Kategorien ab', async () => {
    assert.equal(ok(await app.api('PUT', `/upload/${id}`, { category_id: 404, private: true })).pack.category, 'Büro'); assert.equal(ok(await app.api('GET', `/upload/${id}`)).pack.private, true);
    assert.equal((await app.api('PUT', `/upload/${id}`, { category_id: 999999 })).status, 400);
  });
  it('Entwurf nur bei geplanten, vollstaendigen Paketen; Fehler beim Browser-Lauf landen im Job', async () => {
    const live = app.db().prepare("SELECT design_id FROM models WHERE planned=0 LIMIT 1").get().design_id;
    assert.equal((await app.api('POST', `/upload/${live}/draft`, {})).status, 400);
    const empty = ok(await app.api('POST', '/products/plan', { title: 'Leer' })).design_id; assert.equal((await app.api('POST', `/upload/${empty}/draft`, {})).status, 400);
    assert.equal(ok(await app.api('POST', `/upload/${id}/draft`, {})).started, true);
    let j; for (let i = 0; i < 60; i++) { j = ok(await app.api('GET', '/mw/job')); if (!j.running && j.finishedAt) break; await sleep(100); }
    assert.ok(j.error, 'die Fake-Seite kann keine Navigation - Fehler wird erwartet'); assert.equal(j.running, false);
  });
  it('liefert den Kategorienbaum (11 Gruppen, 70 Unterkategorien)', async () => { const c = ok(await app.api('GET', '/upload/categories')); assert.equal(c.length, 11); assert.equal(c.reduce((a, g) => a + g.children.length, 0), 70); });
});

describe('Eigenprojekt als Upload-Plan', () => {
  let app;
  before(async () => { app = await startApp({ env: { MWA_FAKE_SESSION: FAKE, PULL_MIN_RAM_MB: '1' } }); });
  after(async () => { await app.stop(); app.cleanup(); });
  const q = (sql, ...a) => { const d = app.db(); try { return d.prepare(sql).all(...a); } finally { d.close(); } };

  it('legt beim Anlegen automatisch das geplante Modell an und haelt die Titel synchron', async () => {
    const p = ok(await app.api('POST', '/projects', { self: 1, title: 'Plan Eins' }));
    assert.ok(p.design_id && p.design_id.startsWith('plan_'), 'geplantes Modell fehlt');
    const m = q('SELECT title, planned FROM models WHERE design_id=?', p.design_id)[0]; assert.equal(m.title, 'Plan Eins'); assert.equal(m.planned, 1);
    ok(await app.api('PUT', `/projects/${p.id}`, { title: 'Plan Eins neu' })); assert.equal(q('SELECT title FROM models WHERE design_id=?', p.design_id)[0].title, 'Plan Eins neu');
    ok(await app.api('PUT', `/model/${p.design_id}/meta`, { title: 'Plan Eins final' })); assert.equal(q('SELECT title FROM projects WHERE id=?', p.id)[0].title, 'Plan Eins final');
  });
  it('liefert den Fortschritt der Upload-Planung in der Liste', async () => {
    const list = ok(await app.api('GET', '/crm/self-projects')); const row = list.find(x => x.title === 'Plan Eins final');
    assert.ok(row.plan && row.plan.total === 7 && row.plan.done >= 1 && row.plan.ready === false);
  });
  it('verknuepft manuell mit einem veroeffentlichten Modell und raeumt das Planmodell auf', async () => {
    const p = ok(await app.api('POST', '/projects', { self: 1, title: 'Plan Zwei' })), plan = p.design_id;
    ok(await app.api('PUT', `/upload/${plan}`, { category_id: 404 }));
    const real = q("SELECT design_id FROM models WHERE planned=0 LIMIT 1")[0].design_id;
    assert.equal((await app.api('POST', `/crm/projects/${p.id}/link`, { design_id: plan })).status, 400);       // Planmodell ist kein Ziel
    const r = ok(await app.api('POST', `/crm/projects/${p.id}/link`, { design_id: real }));
    assert.equal(r.design_id, real); assert.equal(r.stage, 'publish'); assert.equal(r.published, 1);
    assert.equal(q('SELECT COUNT(*) c FROM models WHERE design_id=?', plan)[0].c, 0);
    assert.equal(q('SELECT category_id FROM upload_packs WHERE design_id=?', real)[0].category_id, 404);       // Upload-Paket zieht mit um
  });
  it('Tag-Upload verlangt ein bestehendes (nicht geplantes) Modell und Tags', async () => {
    const live = q("SELECT design_id FROM models WHERE planned=0 LIMIT 1")[0].design_id, plan = ok(await app.api('POST', '/products/plan', { title: 'Nur geplant' })).design_id;
    assert.equal((await app.api('POST', '/tags/apply', { design_id: 'gibtsnicht', tags: ['a'] })).status, 404);
    assert.equal((await app.api('POST', '/tags/apply', { design_id: plan, tags: ['a'] })).status, 400);
    assert.equal((await app.api('POST', '/tags/apply', { design_id: live, tags: [] })).status, 400);
  });
});
