// Oberflaechen-Tests (Playwright) gegen die Demo-Daten: Navigation, mobil, Tastatur/Barrierefreiheit,
// Rueckgaengig/Papierkorb, Eingabedialoge, Spaltenauswahl, Kalkulation, Fehlerbanner.   Ausfuehren: npm run test:ui
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, launchBrowser, ROUTES } from './helpers.mjs';

const SECTION_TABS = { modelle: 4, auswertung: 2, kunden: 2, projekte: 2, entwuerfe: 2, materialkalk: 2 };

let app, browser;
before(async () => { app = await startApp(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await app.stop(); app.cleanup(); });

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 880 }, ...opts });
  const page = await ctx.newPage(); const errors = [], dialogs = [];
  page.on('pageerror', e => errors.push(String(e))); page.on('dialog', d => { dialogs.push(d.type()); d.dismiss(); });
  page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(app.base + '/', { waitUntil: 'load' }); await page.waitForTimeout(800);
  return { ctx, page, errors, dialogs };
}
const view = async (page, route, wait = 900) => { await page.evaluate(r => go(r), route); await page.waitForTimeout(wait); };

describe('Navigation', () => {
  it('10 Bereiche, Tabs je Bereich, alle 18 Seiten laden ohne Fehler', async () => {
    const { ctx, page, errors } = await newPage();
    const links = await page.evaluate(() => [...document.querySelectorAll('nav a')].map(a => a.dataset.section)); assert.equal(links.length, 10);
    for (const [sec, n] of Object.entries(SECTION_TABS)) {
      await page.click(`nav a[data-section="${sec}"]`); await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.tabbar .tab').length), n, sec);
      assert.equal(await page.evaluate(() => document.querySelector('nav a.active')?.dataset.section), sec);
    }
    for (const r of ROUTES) { await view(page, r, 600); assert.ok((await page.evaluate(() => document.querySelector('#view h1')?.textContent || '')).length > 0, r); }
    assert.deepEqual(errors, []); await ctx.close();
  });
  it('alte Adressen, Bereichsnamen, Tab-Gedaechtnis, Pfeiltasten und Zurueck-Taste', async () => {
    const { ctx, page, errors } = await newPage();
    const where = () => page.evaluate(() => `${document.querySelector('nav a.active')?.dataset.section}/${document.querySelector('.tab.on')?.textContent}`);
    for (const [hash, exp] of [['momentum', 'modelle/Momentum'], ['leads', 'kunden/Leads'], ['druckplan', 'projekte/Druckplan'], ['selbst', 'entwuerfe/Eigenprojekte'], ['material', 'materialkalk/Filament-Lager']]) {
      await page.goto(app.base + '/#' + hash); await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(700); assert.equal(await where(), exp, hash);
    }
    await view(page, 'compare'); await page.click('nav a[data-section="kunden"]'); await page.waitForTimeout(500); await page.click('nav a[data-section="modelle"]'); await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => document.querySelector('.tab.on')?.textContent), 'Vergleich');
    await page.focus('.tab.on'); await page.keyboard.press('ArrowRight'); await page.waitForTimeout(700); assert.equal(await page.evaluate(() => document.querySelector('.tab.on')?.textContent), 'Kategorien');
    await view(page, 'contacts'); await page.goBack(); await page.waitForTimeout(800); assert.equal(await page.evaluate(() => document.querySelector('nav a.active')?.dataset.section), 'modelle');
    assert.deepEqual(errors, []); await ctx.close();
  });
});

describe('Mobil (375 px)', () => {
  it('kein Ueberlauf, Menue oeffnet/schliesst, Drawer vollbreit', async () => {
    const { ctx, page, errors } = await newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('sidebar')).visibility), 'hidden');
    await page.click('#navToggle'); await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.getElementById('navToggle').getAttribute('aria-expanded')), 'true');
    await page.click('nav a[data-section="modelle"]'); await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => document.getElementById('sidebar').classList.contains('open')), false);
    for (const r of ROUTES) { await view(page, r, 450); const o = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, v: innerWidth })); assert.ok(o.w <= o.v + 1, `${r}: ${o.w}>${o.v}`); }
    await page.evaluate(() => openModel(STATE.overview.models[0].design_id)); await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => Math.round(document.querySelector('.drawer-inner').getBoundingClientRect().width)), 375);
    assert.deepEqual(errors, []); await ctx.close();
  });
});

describe('Tastatur & Barrierefreiheit', () => {
  it('Zeile per Enter oeffnen, Fokusfalle, Esc, Fokus zurueck; nichts Klickbares ohne Fokus', async () => {
    const { ctx, page } = await newPage();
    await view(page, 'overview', 1100);
    await page.focus('#view tbody tr'); await page.keyboard.press('Enter'); await page.waitForTimeout(1200);
    assert.ok(await page.evaluate(() => !document.getElementById('drawer').classList.contains('hidden') && document.getElementById('drawer').contains(document.activeElement)));
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.getElementById('drawer').contains(document.activeElement)), 'Fokus verlaesst den Dialog');
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.getElementById('drawer').classList.contains('hidden') && document.activeElement.tagName === 'TR'));
    for (const r of ['heute', 'overview', 'contacts', 'leads', 'projekte', 'pipeline', 'revenue', 'todos', 'points']) {
      await view(page, r, 700);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('#view *')].filter(e => e.onclick && !['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(e.tagName) && e.tabIndex < 0).length), 0, r);
    }
    await ctx.close();
  });
  it('alle Felder und Diagramme auf allen Seiten und in allen Drawern beschriftet', async () => {
    const { ctx, page } = await newPage();
    const unl = () => page.evaluate(() => ({ f: [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(f => !f.getAttribute('aria-label') && !(f.labels && f.labels.length) && !f.closest('label')).map(f => f.outerHTML.slice(0, 80)),
      c: [...document.querySelectorAll('canvas')].filter(c => !c.getAttribute('aria-label')).length }));
    for (const r of ROUTES) { await view(page, r, 900); const u = await unl(); assert.deepEqual(u.f, [], r); assert.equal(u.c, 0, r); }
    for (const [name, js] of [['model', 'openModel(STATE.overview.models[0].design_id)'], ['project', "(async()=>{const l=await api('/crm/projects'); openProject(l[0].id)})()"], ['contact', "(async()=>{const l=await api('/contacts'); openContact(l[0].id)})()"]]) {
      await page.evaluate(js); await page.waitForTimeout(1500); const u = await unl(); assert.deepEqual(u.f, [], name);
      assert.equal(await page.evaluate(() => document.querySelector('#drawer .drawer-inner').getAttribute('role')), 'dialog'); await page.evaluate(() => closeDrawer());
    }
    await ctx.close();
  });
});

describe('Bedienung', () => {
  it('Spaltenauswahl: Standard/Alle, gemerkt, schliesst bei Klick daneben', async () => {
    const { ctx, page } = await newPage(); await view(page, 'overview', 1100);
    const heads = () => page.evaluate(() => [...document.querySelectorAll('#view thead th')].map(t => t.textContent.replace(/[▾▴]/g, '').trim()));
    const std = (await heads()).length; assert.equal(std, 12);
    await page.click('.colpick summary'); await page.click('.colpick-box button:has-text("Alle")'); assert.equal((await heads()).length, 18);
    assert.ok(await page.evaluate(() => document.querySelector('.colpick').open), 'Auswahl schliesst sich nach "Alle"');
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(900); await view(page, 'overview', 900); assert.equal((await heads()).length, 18, 'nicht gemerkt');
    await page.click('.colpick summary'); await page.click('.colpick-box button:has-text("Standard")'); assert.equal((await heads()).length, 12);
    await page.mouse.click(1000, 22); assert.ok(await page.evaluate(() => !document.querySelector('.colpick').open)); await ctx.close();
  });
  it('Loeschen mit Rueckgaengig, Papierkorb-Liste, Eingabedialoge statt Browser-Dialogen', async () => {
    const { ctx, page, dialogs, errors } = await newPage();
    await page.evaluate(() => jpost('/todos', { title: 'UI Aufgabe' })); await view(page, 'todos', 1000);
    const n = () => page.evaluate(() => [...document.querySelectorAll('#view .todolist li .t')].filter(x => x.textContent.includes('UI Aufgabe')).length);
    assert.equal(await n(), 1); await page.click('#view li:has-text("UI Aufgabe") button:has-text("✕")'); await page.waitForTimeout(800); assert.equal(await n(), 0);
    assert.match(await page.evaluate(() => document.querySelector('.toast.undo')?.innerText || ''), /Rückgängig/);
    await page.locator('.toast.undo button').last().click(); await page.waitForTimeout(1000); assert.equal(await n(), 1);
    // Modal: neuer Kunde
    await view(page, 'contacts', 900); await page.click('button:has-text("＋ Kunde")'); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.querySelector('.modal')?.getAttribute('role')), 'dialog'); assert.ok(await page.evaluate(() => document.activeElement.tagName === 'INPUT'));
    await page.keyboard.press('Escape'); assert.ok(await page.evaluate(() => !document.querySelector('.modal')));
    await page.click('button:has-text("＋ Kunde")'); await page.keyboard.type('UI Kunde'); await page.keyboard.press('Enter'); await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => document.querySelector('#drawer .dh h1')?.textContent), 'UI Kunde');
    await page.click('#drawer button:has-text("Kunde löschen")'); await page.waitForTimeout(1000);
    assert.ok(!(await page.evaluate(() => document.querySelector('#view').innerText.includes('UI Kunde'))));
    await page.locator('.toast.undo button').last().click(); await page.waitForTimeout(1200);
    assert.ok(await page.evaluate(() => document.querySelector('#view').innerText.includes('UI Kunde')));
    // Papierkorb-Karte: Aufgabe loeschen, in Daten & Pull wiederherstellen
    await view(page, 'todos', 900); await page.click('#view li:has-text("UI Aufgabe") button:has-text("✕")'); await page.waitForTimeout(600);
    await view(page, 'data', 1500);
    assert.match(await page.evaluate(() => [...document.querySelectorAll('#view .card .hd')].map(h => h.textContent).find(t => /Papierkorb/.test(t))), /Papierkorb \(1\)/);
    await page.click('#view .card:has(.hd:has-text("Papierkorb")) button:has-text("Wiederherstellen")'); await page.waitForTimeout(1200);
    assert.match(await page.evaluate(() => [...document.querySelectorAll('#view .card .hd')].map(h => h.textContent).find(t => /Papierkorb/.test(t))), /Papierkorb \(0\)/);
    assert.deepEqual(dialogs, [], 'Browser-Dialog aufgetaucht'); assert.deepEqual(errors, []); await ctx.close();
  });
  it('Projekt-Drawer: Live-Kalkulation kommt vom Server', async () => {
    const { ctx, page } = await newPage();
    await page.evaluate(async () => { const l = await api('/crm/projects'); openProject((l.find(p => p.kind === 'modell_print' && !p.self) || l[0]).id); }); await page.waitForTimeout(1500);
    const tiles = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#drawer .dbody > .stats .stat')].map(s => [s.querySelector('.l').textContent.trim(), s.querySelector('.v').textContent.trim()])));
    await page.fill('#drawer input[placeholder="Vorschlag"]', '12.5'); await page.waitForTimeout(700); assert.match((await tiles())['Preis'], /12,50/);
    await page.selectOption('#drawer select:has(option[value="kostenlos"])', 'kostenlos'); await page.waitForTimeout(700);
    assert.ok('Verlust' in await tiles(), 'kostenlos zeigt Verlust-Kachel'); await ctx.close();
  });
  it('Finanzen: Filter "nur Gratis-Projekte"; Kategorien: sortierbare Tabelle und Drilldown', async () => {
    const { ctx, page } = await newPage(); await view(page, 'revenue', 1500);
    const card = page.locator('.card:has(.hd:has-text("Projekte → MakerWorld-Ertrag"))');
    if (await card.count()) { const all = await card.locator('tbody tr').count(); await card.locator('input[type=checkbox]').click(); assert.ok(await card.locator('tbody tr').count() <= all); }
    await view(page, 'groups', 1300); await page.click('#view table thead th:nth-child(3)'); await page.waitForTimeout(300);
    assert.match(await page.evaluate(() => document.querySelector('#view table thead th:nth-child(3)').textContent), /[▾▴]/);
    await page.click('#view table tbody tr'); await page.waitForTimeout(1300); assert.ok(await page.evaluate(() => !document.getElementById('drawer').classList.contains('hidden'))); await ctx.close();
  });
  it('Fehlerbanner bei Netzausfall und Serverfehler; 4xx mit JSON bleibt ohne Banner', async () => {
    const { ctx, page } = await newPage();
    const banner = () => page.evaluate(() => { const b = document.getElementById('errBanner'); return b && !b.hidden ? b.textContent : null; });
    await page.route('**/api/today', r => r.abort()); await page.evaluate(() => go('heute')).catch(() => {}); await page.waitForTimeout(600); assert.match(await banner(), /nicht erreichbar/); await page.unroute('**/api/today');
    await page.evaluate(() => { document.getElementById('errBanner').hidden = true; });
    await page.route('**/api/contacts', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })); await page.evaluate(() => go('contacts')).catch(() => {}); await page.waitForTimeout(600); assert.match(await banner(), /500.*boom/); await page.unroute('**/api/contacts');
    await page.evaluate(() => { document.getElementById('errBanner').hidden = true; });
    assert.deepEqual(await page.evaluate(() => api('/projects/999999', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })), { error: 'unbekannt' }); assert.equal(await banner(), null); await ctx.close();
  });
  it('softRefresh: laufende Eingabe, Scroll-Position und offener Drawer bleiben erhalten', async () => {
    const { ctx, page } = await newPage(); await view(page, 'todos', 1000);
    await page.fill('#view input[placeholder="Neue Aufgabe …"]', 'nicht verlieren'); await page.evaluate(() => softRefresh()); await page.waitForTimeout(600);
    assert.equal(await page.inputValue('#view input[placeholder="Neue Aufgabe …"]'), 'nicht verlieren');
    await view(page, 'overview', 1100); await page.evaluate(() => { document.activeElement.blur(); document.querySelector('main').scrollTop = 300; window.scrollTo(0, 300); }); await page.waitForTimeout(200);
    const y0 = await page.evaluate(() => Math.max(scrollY, document.querySelector('main').scrollTop)); await page.evaluate(() => softRefresh()); await page.waitForTimeout(1300);
    assert.ok(Math.abs(y0 - await page.evaluate(() => Math.max(scrollY, document.querySelector('main').scrollTop))) < 5);
    await page.evaluate(() => openModel(STATE.overview.models[0].design_id)); await page.waitForTimeout(1200); await page.evaluate(() => { document.querySelector('#view').dataset.mark = 'keep'; });
    await page.evaluate(() => softRefresh()); await page.waitForTimeout(500); assert.equal(await page.evaluate(() => document.querySelector('#view').dataset.mark), 'keep'); await ctx.close();
  });
});
