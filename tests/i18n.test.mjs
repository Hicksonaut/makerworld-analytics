// Englische Oberflaeche vollstaendig? Zwei Pruefungen:
//  1. Quellcode: jedes deutsche Textliteral in web/js/*.js muss im Woerterbuch (TR) stehen oder von einer Regel (TR_RULES) erfasst werden.
//  2. Laufzeit: die ganze Oberflaeche wird im englischen Modus durchlaufen (alle Seiten, Drawer, Dialoge, Kundenstatusseite,
//     Rechnung); alle Texte, die t() nicht uebersetzen konnte, werden eingesammelt und auf deutsche Woerter geprueft.
// Ausfuehren:  npm run test:ui   (Liste der Funde:  MWA_I18N_LIST=1 npm run test:ui)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { startApp, launchBrowser, ROOT, ROUTES } from './helpers.mjs';
import { fileURLToPath } from 'node:url';
const FAKE_SESSION = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-session.mjs');

// ---- Heuristik: sieht ein Text deutsch aus? (Umlaute oder typische deutsche Woerter)
const DE_WORDS = ['der', 'die', 'das', 'und', 'oder', 'nicht', 'kein', 'keine', 'keiner', 'für', 'mit', 'von', 'zu', 'zum', 'zur', 'ist', 'wird', 'werden', 'noch', 'alle', 'neu', 'neue', 'neuer',
  'bitte', 'aufgabe', 'aufgaben', 'kunde', 'kunden', 'projekt', 'projekte', 'modell', 'modelle', 'tage', 'tagen', 'woche', 'monat', 'datum', 'preis', 'bezahlt', 'offen', 'löschen',
  'speichern', 'gespeichert', 'gelöscht', 'hinzufügen', 'eintrag', 'notiz', 'notizen', 'fehler', 'beim', 'nach', 'aus', 'auf', 'bei', 'im', 'ein', 'eine', 'einen', 'sind', 'oben', 'unten',
  'jetzt', 'erst', 'zurück', 'öffnen', 'schließen', 'abbrechen', 'laden', 'läuft', 'fertig', 'gesamt', 'summe', 'anzahl', 'wenn', 'dann', 'damit', 'wie', 'was', 'wer', 'wo', 'gibt', 'als', 'auch', 'nur', 'mehr', 'zeigt', 'wähle', 'wählen',
  'seit', 'dein', 'deine', 'ihr', 'ihre', 'ihrer', 'über', 'gegenüber', 'vorwoche', 'letzte', 'letzten', 'erledigt', 'angelegt', 'verknüpft', 'hochgeladen', 'veröffentlicht', 'stufe', 'phase', 'kosten', 'gewinn', 'verlust', 'rechnung', 'beleg', 'kontostand', 'konto', 'geplant', 'spalten', 'klick', 'verlauf', 'klickrate', 'punkte', 'periode', 'eigene', 'eigener', 'kategorie', 'ansicht', 'metrik', 'leeren', 'gruppieren', 'kumuliert', 'korrelation', 'drucken', 'nichts', 'trefferquote', 'titelbild', 'kontakte', 'kontakt', 'kostenlos', 'marge', 'stk', 'reicht', 'hoch', 'deutsch', 'hinweis', 'hinweise', 'keins', 'gefunden', 'anlegen', 'planen', 'empfehlen', 'suchen', 'durchsuchen', 'direkte', 'druckprofil', 'druckzeit', 'projekttitel', 'vorher', 'nachher', 'druck', 'eigenprojekt', 'folgt', 'pkt', 'anz', 'bierdeckel', 'hebel', 'änderung', 'änderungen', 'erkannt', 'automatisch', 'gramm', 'spule', 'aufgabe', 'kunde', 'verdient', 'offene', 'offenen', 'gesamt', 'empfehlungen', 'wert', 'anzeigen', 'ausblenden', 'einblenden', 'ziel', 'ziele', 'stunden', 'einzel', 'menge', 'betrag', 'kontakten', 'abgeschlossen', 'planung', 'entwurf', 'bearbeitet', 'zuletzt', 'bewertung', 'bewertungen', 'beschreibung', 'titel', 'bild', 'bilder', 'fehlt', 'unbekannt', 'wochen', 'monatlich', 'täglich', 'wöchentlich', 'einnahmen', 'ausgaben', 'gewinn', 'umsatz', 'zahlung', 'zahlungen', 'forderungen', 'mahnung', 'urteil', 'hypothese'];
const DE_RE = new RegExp(`[äöüÄÖÜß]|\\bz\\. ?B\\.|(?:^|[^\\p{L}])(?:${DE_WORDS.join('|')})(?![\\p{L}])`, 'iu');
export const looksGerman = s => DE_RE.test(s);
// Bekannte Ausnahmen: Eigennamen/Fachbegriffe, die in beiden Sprachen gleich sind
const SAME = new Set(['Deutsch', 'Filter', 'Phase', 'MakerWorld', 'Views', 'Likes', 'Boost', 'Follower', 'Tags', 'Status', 'Release', 'Momentum', 'Leads', 'CSV', 'CTR%', 'Trend', 'Board', 'Filament', 'AMS', 'PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'Standard']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = process.env.MWA_I18N_LIST === '1';

describe('Englische Oberflaeche: Quellcode', () => {
  it('jedes deutsche Textliteral hat eine Uebersetzung', () => {
    const jsDir = path.join(ROOT, 'web', 'js');
    const dictSrc = fs.readFileSync(path.join(jsDir, 'i18n-en.js'), 'utf8');
    const { TR, TR_RULES } = vm.runInNewContext(dictSrc + '\n({ TR, TR_RULES })', {});
    const covered = s => { const probe = s.replace(/\u0000/g, '1'); return TR[s] != null || SAME.has(s) || TR_RULES.some(([re]) => re.test(s) || re.test(probe)); };
    const missing = new Map();
    for (const f of fs.readdirSync(jsDir).filter(f => f.endsWith('.js') && f !== 'i18n-en.js')) {
      const src = fs.readFileSync(path.join(jsDir, f), 'utf8').split('\n');
      src.forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return;                                   // Kommentarzeilen
        for (const m of line.matchAll(/'((?:[^'\\\n]|\\.)+)'|"((?:[^"\\\n]|\\.)+)"|`((?:[^`\\\n]|\\.)+)`/g)) {
          let s = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\'/g, "'").replace(/\\n/g, '\n');
          if (m[3] != null) s = s.replace(/\$\{[^}]*\}/g, '\u0000');           // Template: Platzhalter markieren
          if (s.length < 4 || /^[\w./#:%@\-[\],()\s=>*+<?&;|\u0000]*$/.test(s) && !looksGerman(s)) continue;
          if (!looksGerman(s) || covered(s) || /^(https?:|\/|#|\.|[a-z_]+\()/.test(s)) continue;
          if (/^[a-z0-9_.:;%#(),\s\u0000-]+$/.test(s) || /^[\w\u0000.-]+$/.test(s) || /\.replace\(|\(\/|\+ Math\./.test(s)) continue;   // Bezeichner/CSS/Dateinamen
          if (/(^|\s)$|^\s|[(±]$/.test(s) && !/^[A-ZÄÖÜ].*[.!?]$/.test(s)) continue;     // Fragmente zusammengesetzter Saetze: deckt der Laufzeittest ab
          if (m[3] != null) { const parts = s.split('\u0000').map(x => x.trim()).filter(x => x.length > 3 && looksGerman(x)); if (parts.every(p => covered(p) || [...Object.keys(TR)].some(k => p.includes(k)))) continue; }
          if (/[{}]|=>|\bconst\b|\bfunction\b/.test(s)) continue;               // Code, kein Anzeigetext
          if (!missing.has(s)) missing.set(s, `${f}:${i + 1}`);
        }
      });
    }
    if (list) console.log('\n--- Quellcode: nicht uebersetzt (' + missing.size + ') ---\n' + [...missing].map(([s, w]) => `${w}  ${JSON.stringify(s)}`).join('\n'));
    assert.equal(missing.size, 0, `${missing.size} deutsche Texte ohne englische Uebersetzung (Liste: MWA_I18N_LIST=1)`);
  });
});

describe('Englische Oberflaeche: Laufzeit', () => {
  let app, browser;
  before(async () => { app = await startApp({ env: { MWA_FAKE_SESSION: FAKE_SESSION, PULL_MIN_RAM_MB: '1' } }); browser = await launchBrowser(); });
  after(async () => { await browser?.close(); await app.stop(); app.cleanup(); });

  it('alle Seiten, Drawer, Dialoge, Statusseite und Rechnung sind uebersetzt', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('lang', 'en'); } catch {} });
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(String(e))); page.on('dialog', d => d.dismiss());
    await page.goto(app.base + '/', { waitUntil: 'load' }); await sleep(900);
    const go = async (r, w = 800) => { await page.evaluate(r => go(r), r); await sleep(w); };
    const closeD = () => page.evaluate(() => closeDrawer());
    const german = new Set(), seenText = [];
    const scanText = async tag => { const t = await page.evaluate(() => document.body.innerText + '\n' + [...document.querySelectorAll('[placeholder],[title],[aria-label]')].map(e => [e.placeholder, e.title, e.getAttribute('aria-label')].filter(Boolean).join('\n')).join('\n')); seenText.push([tag, t]); };

    // Daten fuer moeglichst viele Zustaende anlegen
    const api = (m, p, b) => app.api(m, p, b).then(r => r.body);
    const cid = (await api('POST', '/contacts', { name: 'EN Customer', email: 'k@example.com' })).id;
    const pPrint = (await api('POST', '/projects', { contact_id: cid, title: 'EN Print job', price: 15, qty: 2 })).id;
    const pModel = (await api('POST', '/projects', { contact_id: cid, title: 'EN Modelling', kind: 'modell' })).id;
    const pSelf = (await api('POST', '/projects', { self: 1, title: 'EN Own project' })).id;
    await api('POST', `/projects/${pPrint}/items`, { label: 'EN Position', qty: 2, weight_g: 40, print_min: 90 });
    await api('POST', '/spools', { material: 'PLA', color: 'Schwarz', total_g: 1000, remaining_g: 100 });
    await api('POST', '/parts', { name: 'Magnet', unit_price: 0.2 });
    await api('POST', '/todos', { title: 'EN Task', due_date: '2020-01-01' }); await api('POST', '/expenses', { description: 'Filament', amount: 20 }); await api('POST', '/payouts', { points: 524, amount: 40 });
    await api('PUT', `/projects/${pPrint}`, { stage: 'fertig', paid: 0 }); await api('POST', '/products/plan', { title: 'EN Plan' });
    const token = (await api('POST', `/crm/projects/${pPrint}/share`, {})).token;
    await api('PUT', `/projects/${pModel}`, { stage: 'fertig' });
    const delT = (await api('DELETE', `/todos/${(await api('POST', '/todos', { title: 'EN geloescht' })).id}`)).trash_id; assert.ok(delT);

    // 1) alle Seiten
    for (const r of ROUTES) { await go(r, 1000); await scanText(r); }
    // 2) Hover-/Interaktionszustaende
    await go('overview', 1000); await page.click('.colpick summary'); await scanText('spaltenwahl'); await page.keyboard.press('Escape');
    await page.click('button:has-text("＋ Segment"), button:has-text("+ Segment")'); await sleep(250); await scanText('modal-segment'); await page.keyboard.press('Escape');
    await go('contacts', 800); await page.click('button:has-text("Customer"), button:has-text("Kunde"), .toolbar .btn.primary'); await sleep(250); await scanText('modal-kunde'); await page.keyboard.press('Escape');
    await go('pipeline', 900); await page.click('button:has-text("Plan model"), button:has-text("Modell planen")'); await sleep(250); await scanText('modal-modell'); await page.keyboard.press('Escape');
    // 3) Drawer
    const modelId = await page.evaluate(() => STATE.overview.models[0].design_id);
    // Tag-Assistent (Fake-Recherche) und Upload-Paket
    const waitJob = async () => { for (let i = 0; i < 100; i++) { const j = (await app.api('GET', '/mw/job')).body; if (j && !j.running && j.finishedAt) return j; await sleep(200); } };
    await app.api('POST', '/tags/research', { design_id: modelId, title: 'Desk Organizer' }); await waitJob();
    const planId0 = (await app.api('GET', '/overview')).body.planned?.[0]?.design_id;
    if (planId0) {
      await app.api('POST', '/tags/research', { design_id: planId0, title: 'Desk Organizer' }); await waitJob();
      await app.api('PUT', `/upload/${planId0}`, { category_id: 404, private: true });
      for (const [kind, name] of [['file3mf', 'a.3mf'], ['photo', 'p1.png'], ['cover43', 'c.png']]) await fetch(`${app.base}/api/upload/${planId0}/file?kind=${kind}&name=${name}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('x'.repeat(500)) });
    }
    await page.evaluate(i => openModel(i), modelId); await sleep(1600); await scanText('modell-drawer');
    for (const chip of await page.locator('#drawer .chip').all()) await chip.click().catch(() => {});
    await scanText('modell-drawer-chips'); await closeD();
    const planned = await page.evaluate(() => (STATE.overview.planned || [])[0]?.design_id);
    if (planned) { await page.evaluate(i => openPlanned(i), planned); await sleep(1200); await scanText('geplant-drawer'); await closeD(); }
    await page.evaluate(i => openContact(i), cid); await sleep(1300); await scanText('kunde-drawer'); await closeD();
    for (const [name, id] of [['projekt-druck', pPrint], ['projekt-modell', pModel], ['projekt-eigen', pSelf]]) { await page.evaluate(i => openProject(i), id); await sleep(1500); await scanText(name); await closeD(); }
    await page.evaluate(() => openGroup('category', STATE.overview.models[0].category || '—')); await sleep(1300); await scanText('gruppe-drawer'); await closeD();
    // 4) Rechnung (neues Fenster) und Kundenstatusseite
    await api('POST', '/crm/settings', { seller: { name: 'EN Absender', address: 'Strasse 1', email: 's@example.com', iban: 'DE00', taxnote: 'Kleinunternehmer' } });
    const popupP = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null);
    await page.evaluate(i => openInvoice(i), pPrint); const popup = await popupP;
    if (popup) { await popup.waitForLoadState('load'); await sleep(300); seenText.push(['rechnung', await popup.evaluate(() => document.body.innerText)]); await popup.close(); }
    // 4b) Rechnungsarchiv, Mahnung, Steuer-Export, Experimente
    { const d = app.db(); d.prepare("UPDATE invoices SET due_date='2020-01-01', date='2019-12-18' WHERE project_id=?").run(pPrint); d.close(); }
    const popupR = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null);
    await page.evaluate(i => openReminder(i), pPrint); const popupR2 = await popupR;
    if (popupR2) { await popupR2.waitForLoadState('load'); await sleep(300); seenText.push(['mahnung', await popupR2.evaluate(() => document.body.innerText)]); await popupR2.close(); }
    const dAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    await api('POST', '/events', { design_id: modelId, date: dAgo(45), type: 'title', title: 'EN Title test', hypothesis: 'EN hypothesis', eval_days: 14 });
    await api('POST', '/events', { design_id: modelId, date: dAgo(2), type: 'thumbnail', title: 'EN Cover test', hypothesis: 'EN running', eval_days: 14 });
    for (const r of ['revenue', 'heute', 'report']) { await go(r, 1200); await scanText(r + '-neu'); }
    await page.evaluate(i => openModel(i), modelId); await sleep(1500); await scanText('modell-drawer-experimente'); await closeD();
    const status = await ctx.newPage(); await status.goto(`${app.base}/p/${token}`); await sleep(300); seenText.push(['statusseite(en)', await status.evaluate(() => document.body.innerText)]); await status.close();
    await api('POST', '/settings', { lang: 'en' }); const st2 = await ctx.newPage(); await st2.goto(`${app.base}/p/${token}`); await sleep(300); seenText.push(['statusseite(setting=en)', await st2.evaluate(() => document.body.innerText)]); await st2.close();
    // 5) Toast-Texte und Fehler (Server-Texte kommen schon uebersetzt)
    const missing = await page.evaluate(() => [...(window.__missingT || [])]);
    for (const s of missing) if (!SAME.has(s) && looksGerman(s)) german.add(s);
    for (const [tag, text] of seenText) for (const line of text.split('\n').map(x => x.trim()).filter(Boolean)) { if (line.length > 3 && !SAME.has(line) && looksGerman(line) && !/^\d/.test(line)) german.add(`[${tag}] ${line}`); }
    if (list) console.log('\n--- Laufzeit: deutsche Reste (' + german.size + ') ---\n' + [...german].sort().join('\n') + '\n--- alle von t() nicht uebersetzten Texte (' + missing.length + ') ---\n' + missing.filter(s => !looksGerman(s)).join('\n'));
    assert.deepEqual(errors, []);
    assert.equal(german.size, 0, `${german.size} deutsche Reste im englischen Modus (Liste: MWA_I18N_LIST=1)`);
    await ctx.close();
  });
});
