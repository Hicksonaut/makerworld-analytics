// Upload-Paket fuer geplante Modelle: alles, was MakerWorld fuer einen neuen Entwurf braucht (Dateien, Cover, Fotos, Kategorie ...),
// plus ein Assistent, der den echten MakerWorld-Editor im eingeloggten Browser ausfuellt und als ENTWURF speichert.
// Veroeffentlicht wird hier nie - das bleibt ein bewusster Klick in MakerWorld (siehe docs/makerworld-upload-analysis.md).
import express from 'express';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { db, DATA_DIR, getSetting, setSetting, nowIso } from './db.js';
import { T } from './i18n.js';
import { startMwJob } from './mwjobs.js';
import { MAX_TAGS } from './tags.js';

const app = express.Router();
export const router = app;
const require = createRequire(import.meta.url);
export const CATEGORIES = require('./mw-categories.json');
const catById = Object.fromEntries(CATEGORIES.flatMap(g => g.children.map(c => [c.id, { ...c, group: g.name }])));

db.exec(`CREATE TABLE IF NOT EXISTS upload_packs (
  design_id  TEXT PRIMARY KEY,
  category_id INTEGER,
  license    TEXT DEFAULT 'Standard Digital File License',
  private    INTEGER DEFAULT 0,        -- 1 = Sichtbarkeit "Privat" beim Veroeffentlichen vorbelegen
  files      TEXT DEFAULT '[]',        -- JSON [{kind,name,path,size}] (path relativ zu data/)
  draft_id   INTEGER, draft_url TEXT, draft_at TEXT, report TEXT,
  updated_at TEXT
);`);

const KINDS = { file3mf: { single: true }, raw: { max: 10 }, cover43: { single: true }, cover34: { single: true }, photo: { max: 16 }, picture: { max: 16 } };
const IMG = /\.(png|jpe?g|webp|gif)$/i;
const safeName = n => String(n || 'file').replace(/[^\w.\- äöüÄÖÜß()]/g, '_').slice(-80);
const packDir = id => path.join(DATA_DIR, 'upload_packs', String(id).replace(/[^\w-]/g, '_'));
const getPack = id => { let p = db.prepare('SELECT * FROM upload_packs WHERE design_id=?').get(id); if (!p) { db.prepare('INSERT INTO upload_packs(design_id,updated_at) VALUES(?,?)').run(id, nowIso()); p = db.prepare('SELECT * FROM upload_packs WHERE design_id=?').get(id); } return { ...p, files: JSON.parse(p.files || '[]') }; };
const savePack = p => db.prepare('UPDATE upload_packs SET files=?, updated_at=? WHERE design_id=?').run(JSON.stringify(p.files), nowIso(), p.design_id);
const modelOf = id => db.prepare('SELECT design_id,title,description,tags,planned FROM models WHERE design_id=?').get(id);
const tagsOf = m => { try { return JSON.parse(m.tags || '[]'); } catch { return []; } };
const plain = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Was fehlt noch? ready = Entwurf kann angelegt werden (Titel + Datei); complete = auch alles fuers Veroeffentlichen da.
export function checklist(m, pack) {
  const n = k => pack.files.filter(f => f.kind === k).length, tags = tagsOf(m).length;
  const hasFile = n('file3mf') > 0 || n('raw') > 0;
  const items = [
    { key: 'title', ok: !!m.title && m.title.length <= 50, required: true, text: T('Titel (max. 50 Zeichen)', 'Title (max. 50 characters)') },
    { key: 'file', ok: hasFile, required: true, text: T('Modelldatei (Bambu-3MF oder STL/STEP/…)', 'Model file (Bambu 3MF or STL/STEP/…)') },
    { key: 'category', ok: !!pack.category_id, required: false, text: T('Kategorie', 'Category') },
    { key: 'description', ok: plain(m.description).length >= 20, required: false, text: T('Beschreibung', 'Description') },
    { key: 'tags', ok: tags > 0, required: false, text: T(`Tags (${tags}/${MAX_TAGS})`, `Tags (${tags}/${MAX_TAGS})`) },
    { key: 'cover43', ok: n('cover43') > 0, required: false, text: T('Cover 4:3', 'Cover 4:3') },
    { key: 'photos', ok: n('photo') >= 3, required: false, text: T(`Echte Druckfotos (${n('photo')}/3, MakerWorld verlangt ≥ 3)`, `Real print photos (${n('photo')}/3, MakerWorld requires ≥ 3)`) },
  ];
  return { items, ready: items.filter(i => i.required).every(i => i.ok), complete: items.every(i => i.ok) };
}
const view = id => {
  const m = modelOf(id), p = getPack(id);
  return { model: { design_id: m.design_id, title: m.title, description: m.description, tags: tagsOf(m), planned: !!m.planned },
    pack: { category_id: p.category_id, category: catById[p.category_id]?.name || null, license: p.license, private: !!p.private, draft_id: p.draft_id, draft_url: p.draft_url, draft_at: p.draft_at,
      files: p.files.map((f, i) => ({ i, kind: f.kind, name: f.name, size: f.size })) },
    checklist: checklist(m, p) };
};
const need = (req, res) => { const m = modelOf(req.params.id); if (!m) { res.status(404).json({ error: T('Modell nicht gefunden', 'model not found') }); return null; } return m; };

app.get('/api/upload/categories', (req, res) => res.json(CATEGORIES));
app.get('/api/upload/:id', (req, res) => { if (need(req, res)) res.json(view(req.params.id)); });
app.put('/api/upload/:id', (req, res) => {
  if (!need(req, res)) return;
  const b = req.body || {}; getPack(req.params.id);
  if (b.category_id !== undefined) { const c = b.category_id === null || b.category_id === '' ? null : +b.category_id; if (c !== null && !catById[c]) return res.status(400).json({ error: T('Unbekannte Kategorie', 'unknown category') }); db.prepare('UPDATE upload_packs SET category_id=? WHERE design_id=?').run(c, req.params.id); }
  if (b.private !== undefined) db.prepare('UPDATE upload_packs SET private=? WHERE design_id=?').run(b.private ? 1 : 0, req.params.id);
  db.prepare('UPDATE upload_packs SET updated_at=? WHERE design_id=?').run(nowIso(), req.params.id);
  res.json(view(req.params.id));
});

// Datei ablegen: Rohdaten im Body, kind/name in der Query. Einzeldateien (3MF, Cover) ersetzen die alte.
app.put('/api/upload/:id/file', express.raw({ type: () => true, limit: '150mb' }), (req, res) => {
  if (!need(req, res)) return;
  const kind = String(req.query.kind || ''), spec = KINDS[kind], name = safeName(req.query.name);
  if (!spec) return res.status(400).json({ error: T('Unbekannte Dateiart', 'unknown file kind') });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: T('Datei ist leer', 'file is empty') });
  if (/^cover|photo|picture/.test(kind) && !IMG.test(name)) return res.status(400).json({ error: T('Nur Bilder (png, jpg, webp, gif)', 'images only (png, jpg, webp, gif)') });
  if (kind === 'file3mf' && !/\.3mf$/i.test(name)) return res.status(400).json({ error: T('Bambu-Studio-Datei muss auf .3mf enden', 'Bambu Studio file must end in .3mf') });
  const p = getPack(req.params.id);
  if (spec.single) for (const f of p.files.filter(f => f.kind === kind)) { try { fs.unlinkSync(path.join(DATA_DIR, f.path)); } catch {} }
  p.files = spec.single ? p.files.filter(f => f.kind !== kind) : p.files;
  if (spec.max && p.files.filter(f => f.kind === kind).length >= spec.max) return res.status(400).json({ error: T(`Höchstens ${spec.max} Dateien dieser Art`, `at most ${spec.max} files of this kind`) });
  const dir = packDir(req.params.id); fs.mkdirSync(dir, { recursive: true });
  const rel = path.relative(DATA_DIR, path.join(dir, `${kind}-${Date.now().toString(36)}-${name}`));
  fs.writeFileSync(path.join(DATA_DIR, rel), req.body);
  p.files.push({ kind, name, path: rel, size: req.body.length }); savePack(p);
  res.json(view(req.params.id));
});
app.get('/api/upload/:id/file/:i', (req, res) => {
  if (!need(req, res)) return;
  const f = getPack(req.params.id).files[+req.params.i]; if (!f) return res.status(404).end();
  const abs = path.join(DATA_DIR, f.path); if (!fs.existsSync(abs)) return res.status(404).end();
  res.setHeader('Content-Disposition', `${IMG.test(f.name) ? 'inline' : 'attachment'}; filename="${f.name.replace(/["\r\n]/g, '')}"`);
  res.sendFile(abs);
});
app.delete('/api/upload/:id/file/:i', (req, res) => {
  if (!need(req, res)) return;
  const p = getPack(req.params.id), i = +req.params.i, f = p.files[i]; if (!f) return res.status(404).json({ error: T('Datei nicht gefunden', 'file not found') });
  try { fs.unlinkSync(path.join(DATA_DIR, f.path)); } catch {}
  p.files.splice(i, 1); savePack(p); res.json(view(req.params.id));
});

// ---- Entwurf bei MakerWorld anlegen (Browser-Auftrag) --------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = 'https://makerworld.com/de';   // deutsche Oberflaeche: die Beschriftungen unten stammen aus der aufgezeichneten Analyse

// wartet, bis Uploads zu S3 abgeschlossen sind (keine offene Anfrage mehr fuer `quiet` ms)
function trackUploads(page) {
  const st = { open: 0, done: 0, last: Date.now() };
  const hit = r => /amazonaws\.com|\/my\/upload|process-files/.test(r.url());
  page.on('request', r => { if (hit(r)) { st.open++; st.last = Date.now(); } });
  const fin = r => { if (hit(r)) { st.open = Math.max(0, st.open - 1); st.done++; st.last = Date.now(); } };
  page.on('requestfinished', fin); page.on('requestfailed', fin);
  st.idle = async (quiet = 4000, max = 240000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { if (st.open === 0 && Date.now() - st.last >= quiet) return true; await sleep(500); } return false; };
  return st;
}
// naechstgelegenes Datei-Feld zu einer Ueberschrift im Editor
const inputNear = (page, text) => page.getByText(text, { exact: false }).first().locator('xpath=ancestor::*[.//input[@type="file"]][1]').locator('input[type=file]').first();

export async function createDraft(page, { model, pack, log }) {
  const abs = f => path.join(DATA_DIR, f.path), files = k => pack.files.filter(f => f.kind === k);
  const t3mf = files('file3mf')[0], raws = files('raw');
  if (!t3mf && !raws.length) throw new Error(T('Keine Modelldatei im Paket.', 'No model file in the pack.'));
  const up = trackUploads(page);
  log(T('Öffne den MakerWorld-Upload …', 'Opening the MakerWorld upload …'));
  await page.goto(BASE + '/my/models/publish?type=original', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(5000);
  await page.getByText('Alle ablehnen').first().click({ timeout: 3000 }).catch(() => {});
  const radio = page.getByText(t3mf ? 'Ja (verdienen Sie zusätzliche Punkte' : 'Ich habe STL/CAD-Dateien', { exact: false }).first();
  await radio.click({ timeout: 15000 }); await sleep(1200);
  log(T('Lade die Modelldatei hoch …', 'Uploading the model file …'));
  await page.locator('input[type=file]').first().setInputFiles(t3mf ? abs(t3mf) : raws.map(abs));
  if (!(await up.idle(5000, 300000))) throw new Error(T('Upload der Modelldatei hat zu lange gedauert.', 'Uploading the model file took too long.'));
  await page.getByRole('button', { name: 'Nächster Schritt' }).click({ timeout: 20000 });
  await page.waitForURL(/drafts\/\d+\/edit/, { timeout: 120000 });
  const draftId = +page.url().match(/drafts\/(\d+)\/edit/)[1];
  log(T(`Entwurf ${draftId} angelegt, fülle den Editor aus …`, `Draft ${draftId} created, filling in the editor …`));
  await sleep(6000);
  await page.getByText('Alle ablehnen').first().click({ timeout: 2000 }).catch(() => {});

  // verbotene Woerter (Markenrechte) merken, damit die Tag-Recherche sie kuenftig aussortiert
  const forbidden = await page.evaluate(() => window.__NEXT_DATA__?.props?.pageProps?.forbiddenWords || []).catch(() => []);
  if (forbidden.length) setSetting('mw_forbidden_words', JSON.stringify(forbidden));
  const bad = forbidden.map(w => String(w).toLowerCase());
  const blocked = t => bad.some(w => w && String(t).toLowerCase().includes(w));

  const texts = page.locator('input[type=text]'), n = await texts.count(); let ti = -1;
  for (let i = 0; i < n; i++) if ((await texts.nth(i).getAttribute('name')) === 'title') ti = i;
  if (ti < 0) throw new Error(T('Titelfeld im Editor nicht gefunden (MakerWorld hat das Formular geändert?).', 'Title field not found in the editor (did MakerWorld change the form?).'));
  await texts.nth(ti).fill(String(model.title || '').slice(0, 50));
  // Tags
  const tags = [...new Set(tagsOf(model).map(t => String(t).replace(/[,;]/g, ' ').trim()).filter(Boolean))].filter(t => !blocked(t) && t.length <= 40).slice(0, MAX_TAGS);
  const skipped = tagsOf(model).length - tags.length;
  if (skipped > 0) log(T(`${skipped} Tag(s) übersprungen (zu lang, doppelt oder auf MakerWorlds Sperrliste).`, `${skipped} tag(s) skipped (too long, duplicate or on MakerWorld's block list).`));
  const tagIn = texts.nth(ti + 2); await tagIn.click();
  for (const t of tags) { await tagIn.fill(t); await page.keyboard.press('Enter'); await sleep(120); }
  log(T(`${tags.length} Tags eingetragen.`, `${tags.length} tags entered.`));
  // Kategorie
  const cat = catById[pack.category_id];
  if (cat) {
    await texts.nth(ti + 1).click(); await sleep(1500);
    await page.getByText(cat.name, { exact: true }).last().click({ timeout: 8000 }).catch(() => log(T(`Kategorie „${cat.name}“ nicht gefunden - bitte im Entwurf wählen.`, `Category "${cat.name}" not found - please choose it in the draft.`)));
    await sleep(500);
  }
  // Beschreibung (Editor: Absaetze per Enter)
  const desc = String(model.description || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  if (desc) {
    const ed = page.locator('.ck-editor__editable').first(); await ed.click();
    const paras = desc.split(/\n+/); for (let i = 0; i < paras.length; i++) { await page.keyboard.insertText(paras[i]); if (i < paras.length - 1) await page.keyboard.press('Enter'); }
  }
  if (pack.private) await page.getByText('Privat', { exact: true }).first().click({ timeout: 5000 }).catch(() => log(T('Sichtbarkeit „Privat“ nicht gefunden.', 'Visibility "Private" not found.')));
  // Bilder (Cover werden im Dialog bestaetigt)
  const cover = async (text, f) => { if (!f) return; await inputNear(page, text).setInputFiles(abs(f)); await sleep(2500); await page.getByRole('button', { name: 'Absenden' }).click({ timeout: 15000 }); await up.idle(3000, 120000); };
  await cover('4:3 Cover', files('cover43')[0]); await cover('3:4 Cover', files('cover34')[0]);
  for (const [text, k] of [['Echte Fotos', 'photo'], ['Modellbilder', 'picture']]) {
    const fs_ = files(k).map(abs); if (!fs_.length) continue;
    await inputNear(page, text).setInputFiles(fs_); await up.idle(4000, 240000);
  }
  // MakerWorld verarbeitet hochgeladene Bilder noch asynchron (process-files). Deshalb speichern wir, lesen den Entwurf zurueck und
  // speichern erneut, bis alle erwarteten Bilder darin stehen.
  const expect = { cover: files('cover43').length > 0, coverPortrait: files('cover34').length > 0, photos: Math.min(files('photo').length, 16), pictures: Math.min(files('picture').length, 16) };
  // Kontrolle anhand der gespeicherten Nutzdaten (die Entwurfsliste von MakerWorld liefert die Bildfelder nicht mit)
  const fromPayload = req => { try { const d = req.postDataJSON(); return { title: d.title, categoryId: d.categoryId, tags: (d.tags || []).length, cover: !!d.cover, coverPortrait: !!d.coverPortrait, realPhotos: (d.realPictures || []).length, pictures: (d.designPictures || []).length }; } catch { return null; } };
  const complete = r => r && (!expect.cover || r.cover) && (!expect.coverPortrait || r.coverPortrait) && r.realPhotos >= expect.photos && r.pictures >= expect.pictures;
  let report = null;
  for (let attempt = 1; attempt <= 14; attempt++) {
    log(attempt === 1 ? T('Speichere den Entwurf …', 'Saving the draft …') : T(`Warte auf die Bildverarbeitung bei MakerWorld … (Versuch ${attempt})`, `Waiting for MakerWorld's image processing … (attempt ${attempt})`));
    const saved = page.waitForResponse(r => /my\/draft\/\d+$/.test(r.url()) && r.request().method() === 'PUT', { timeout: 60000 }).catch(() => null);
    await page.getByRole('button', { name: 'Als Entwurf speichern' }).click({ timeout: 15000 });
    const sr = await saved; await sleep(2500);
    if (!sr || !sr.ok()) throw new Error(T('MakerWorld hat das Speichern des Entwurfs nicht bestätigt.', 'MakerWorld did not confirm saving the draft.'));
    report = fromPayload(sr.request());
    if (complete(report)) break;
    await sleep(12000);
  }
  if (report) {
    log(T(`Kontrolle: Titel „${report.title}“, ${report.tags} Tags, ${report.realPhotos} Druckfotos, ${report.pictures} Modellbilder, Cover ${report.cover ? 'ja' : 'nein'}.`, `Check: title "${report.title}", ${report.tags} tags, ${report.realPhotos} print photos, ${report.pictures} model pictures, cover ${report.cover ? 'yes' : 'no'}.`));
    if (!complete(report)) log(T('Hinweis: Nicht alle Bilder sind im Entwurf angekommen - bitte im Entwurf prüfen und ggf. nachladen.', 'Note: not all images made it into the draft - please check the draft and re-add them if needed.'));
    if (cat && report.categoryId !== cat.id) log(T('Hinweis: Die Kategorie wurde nicht übernommen - bitte im Entwurf wählen.', 'Note: the category was not applied - please choose it in the draft.'));
  }
  return { draft_id: draftId, url: `${BASE}/my/models/drafts/${draftId}/edit`, report };
}

app.post('/api/upload/:id/draft', (req, res) => {
  const m = need(req, res); if (!m) return;
  if (!m.planned) return res.status(400).json({ error: T('Nur geplante Modelle lassen sich hochladen.', 'Only planned models can be uploaded.') });
  const pack = getPack(req.params.id), cl = checklist(m, pack);
  if (!cl.ready) return res.status(400).json({ error: T('Paket unvollständig: ', 'Pack incomplete: ') + cl.items.filter(i => i.required && !i.ok).map(i => i.text).join(', ') });
  const id = req.params.id;
  res.json(startMwJob('upload', async ({ page, log }) => {
    const r = await createDraft(page, { model: m, pack, log });
    db.prepare('UPDATE upload_packs SET draft_id=?, draft_url=?, draft_at=?, report=?, updated_at=? WHERE design_id=?').run(r.draft_id, r.url, nowIso(), JSON.stringify(r.report), nowIso(), id);
    return r;
  }));
});
// Entwurf bei MakerWorld wieder loeschen (z. B. Fehlversuch); das Paket bleibt erhalten.
app.post('/api/upload/:id/draft/delete', (req, res) => {
  if (!need(req, res)) return;
  const p = getPack(req.params.id); if (!p.draft_id) return res.status(400).json({ error: T('Kein Entwurf vorhanden.', 'No draft exists.') });
  const id = req.params.id, draft = p.draft_id;
  res.json(startMwJob('upload-delete', async ({ page, log }) => {
    await page.goto(BASE + '/my/models/drafts/' + draft + '/edit', { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(3500);
    const st = await page.evaluate(async d => (await fetch('/api/v1/design-service/my/draft/' + d, { method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, draft);
    if (st !== 200) throw new Error('HTTP ' + st);
    db.prepare('UPDATE upload_packs SET draft_id=NULL, draft_url=NULL, draft_at=NULL, report=NULL WHERE design_id=?').run(id);
    log(T('Entwurf bei MakerWorld gelöscht.', 'Draft deleted on MakerWorld.')); return { deleted: draft };
  }));
});
