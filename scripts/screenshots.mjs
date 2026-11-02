// Erzeugt die README-Screenshots (docs/*.png) aus der Demo-Datenbank - nie aus echten Daten.
//   npm run docs:screenshots            englische Oberflaeche (Standard)
//   node scripts/screenshots.mjs de     deutsche Oberflaeche;  weiterer Parameter = Zielordner
import path from 'node:path';
import fs from 'node:fs';
import { startApp, launchBrowser, ROOT } from '../tests/helpers.mjs';
import { fileURLToPath } from 'node:url';

const lang = process.argv[2] === 'de' ? 'de' : 'en';
const out = path.resolve(process.argv[3] || path.join(ROOT, 'docs'));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fake-Sitzung (tests/fake-session.mjs): Tag-Recherche mit Beispieldaten, ohne echte Anfragen an MakerWorld
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fake-session.mjs');
const app = await startApp({ env: { MWA_FAKE_SESSION: FAKE, PULL_MIN_RAM_MB: '1' } }); const browser = await launchBrowser();
try {
  const api = async p => (await app.api('GET', p)).body;
  const firstModel = (await api('/overview')).models.find(m => !m.planned).design_id;
  const project = (await api('/crm/projects')).find(p => !p.self) || (await api('/crm/projects'))[0];
  const own = ((await api('/crm/self-projects')) || [])[0];
  // geplantes Modell mit Tag-Recherche und Upload-Paket fuer den Assistenten-Screenshot
  const planId = (await app.api('POST', '/products/plan', { title: 'Desk Organizer' })).body.design_id;
  await app.api('PUT', `/model/${planId}/meta`, { title: 'Desk Organizer', description: 'A modular organizer for your desk with six compartments.', tags: 'desk, organizer' });
  await app.api('POST', '/tags/research', { design_id: planId }); await sleep(3500);
  await app.api('PUT', `/upload/${planId}`, { category_id: 404 });
  for (const [k, n] of [['file3mf', 'desk-organizer.3mf'], ['photo', 'print-1.png'], ['photo', 'print-2.png']]) await fetch(`${app.base}/api/upload/${planId}/file?kind=${k}&name=${n}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('demo') });
  const shots = [
    ['01-overview', { view: 'overview' }],
    ['02-model-detail', { run: i => `openModel(${JSON.stringify(i)})`, arg: firstModel, wait: 1800 }],
    ['03-finances', { view: 'revenue', wait: 1500 }],
    ['04-project', { run: i => `openProject(${i})`, arg: project?.id, wait: 1600 }],
    ['05-categories', { view: 'groups' }],
    ['06-own-projects', { run: i => `openProject(${i})`, arg: own?.id, wait: 1600 }],
    ['07-mobile', { view: 'heute', mobile: true }],
    ['09-upload-assistant', { run: i => `openPlanned(${JSON.stringify(i)})`, arg: planId, wait: 2200, scroll: 380 }],
    ['08-experiments', { view: 'report', wait: 1500, full: true }],
  ];
  for (const [name, s] of shots) {
    if (s.arg === undefined && s.run) continue;
    const ctx = await browser.newContext({ viewport: s.mobile ? { width: 390, height: 844 } : { width: 1360, height: 880 }, deviceScaleFactor: 2, isMobile: !!s.mobile });
    await ctx.addInitScript(l => { try { localStorage.setItem('lang', l); } catch {} }, lang);
    const page = await ctx.newPage();
    await page.goto(app.base + '/', { waitUntil: 'load' }); await sleep(900);
    if (s.view) await page.evaluate(v => go(v), s.view); else await page.evaluate(js => eval(js), s.run(s.arg));
    await sleep(s.wait || 1200);
    if (s.scroll) { await page.evaluate(y => { document.querySelector('#drawer .drawer-inner').scrollTop = y; }, s.scroll); await sleep(400); }
    await page.screenshot({ path: path.join(out, name + '.png'), fullPage: !!s.full });
    await ctx.close(); console.log('✓', name);
  }
} finally { await browser.close(); await app.stop(); app.cleanup(); }
