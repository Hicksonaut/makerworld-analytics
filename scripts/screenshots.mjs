// Erzeugt die README-Screenshots (docs/*.png) aus der Demo-Datenbank - nie aus echten Daten.
//   npm run docs:screenshots            englische Oberflaeche (Standard)
//   node scripts/screenshots.mjs de     deutsche Oberflaeche;  weiterer Parameter = Zielordner
import path from 'node:path';
import fs from 'node:fs';
import { startApp, launchBrowser, ROOT } from '../tests/helpers.mjs';

const lang = process.argv[2] === 'de' ? 'de' : 'en';
const out = path.resolve(process.argv[3] || path.join(ROOT, 'docs'));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const app = await startApp(); const browser = await launchBrowser();
try {
  const api = async p => (await app.api('GET', p)).body;
  const firstModel = (await api('/overview')).models.find(m => !m.planned).design_id;
  const project = (await api('/crm/projects')).find(p => !p.self) || (await api('/crm/projects'))[0];
  const own = ((await api('/crm/self-projects')) || [])[0];
  const shots = [
    ['01-overview', { view: 'overview' }],
    ['02-model-detail', { run: i => `openModel(${JSON.stringify(i)})`, arg: firstModel, wait: 1800 }],
    ['03-finances', { view: 'revenue', wait: 1500 }],
    ['04-project', { run: i => `openProject(${i})`, arg: project?.id, wait: 1600 }],
    ['05-categories', { view: 'groups' }],
    ['06-own-projects', { run: i => `openProject(${i})`, arg: own?.id, wait: 1600 }],
    ['07-mobile', { view: 'heute', mobile: true }],
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
    await page.screenshot({ path: path.join(out, name + '.png'), fullPage: !!s.full });
    await ctx.close(); console.log('✓', name);
  }
} finally { await browser.close(); await app.stop(); app.cleanup(); }
