// Playwright-Scraper: einmal einloggen (persistentes Profil), danach headless.
// Zieht pro Modell die Analytics-API + die Detailseite (Beschreibung, Tags,
// Bewertungen, Bilder) und schreibt alles in die DB.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { db, DATA_DIR, IMAGES_DIR, nowIso, getSetting } from './db.js';
import { writeModel, writeAccount } from './ingest.js';

const PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');
fs.mkdirSync(PROFILE_DIR, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = s => String(s || '').replace(/\//g, '-');   // 2026/09/02 -> 2026-09-02

// ---------------------------------------------------------------------------
// Browser starten. headless=false fuer den Login, sonst headless.
// channel:'chrome' = das echte installierte Google Chrome (nicht "Chrome for
// Testing"), sonst funktionieren Apple-ID-Passkeys/iCloud-Keychain nicht.
// Faellt auf das gebuendelte Chromium zurueck, falls Chrome fehlt.
async function launch(headless = true, offscreen = false) {
  const args = ['--disable-blink-features=AutomationControlled'];
  // Cloudflare blockt headless. Der Pull laeuft daher als echtes, sichtbares
  // Chrome – aber off-screen positioniert, damit es nicht stoert.
  if (offscreen) args.push('--window-position=-2400,-2400', '--window-size=1280,900');
  const opts = { headless, viewport: { width: 1400, height: 1000 }, args };
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: 'chrome' });
  } catch (e) {
    return chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

async function readSession(page) {
  return page.evaluate(() => {
    const N = window.__NEXT_DATA__;
    const u = ((N?.props || {}).pageProps || {}).session?.user || {};
    return {
      buildId: N?.buildId || null,
      handle: u.handle || u.uidName || null,
      designCount: u.MWCount?.designCount ?? null
    };
  });
}

const SESSION_FILE = path.join(DATA_DIR, 'session.json');

// Entschluesselte Session (Cookies) aus dem eingeloggten Profil exportieren,
// damit sie auf einen anderen Rechner (Pi) uebertragen werden kann.
export async function exportSession() {
  const ctx = await launch(true);
  try {
    const page = await ctx.newPage();
    await page.goto('https://makerworld.com/en', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
    const state = await ctx.storageState();
    const mw = (state.cookies || []).filter(c => /makerworld|bambulab/i.test(c.domain));
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookies: mw, exported: new Date().toISOString() }, null, 2));
    return { ok: true, cookies: mw.length, file: SESSION_FILE };
  } finally { await ctx.close(); }
}

// Cookies aus session.json in den Kontext laden (Fallback, wenn das Profil
// selbst nicht (mehr) eingeloggt ist - z.B. nach Uebertragung auf den Pi).
async function injectSessionCookies(ctx) {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const { cookies } = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (cookies && cookies.length) { await ctx.addCookies(cookies); return true; }
  } catch { /* ignorieren */ }
  return false;
}

// Ist ein gueltiger Login vorhanden?  {loggedIn, handle, buildId}
export async function checkLogin() {
  const ctx = await launch(true);
  try {
    const page = await ctx.newPage();
    await page.goto('https://makerworld.com/en', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);
    const s = await readSession(page);
    return { loggedIn: !!s.handle, ...s };
  } finally { await ctx.close(); }
}

// Login-Fenster oeffnen und warten bis eingeloggt (headful).  Blockiert.
export async function interactiveLogin(onStatus = () => {}) {
  const ctx = await launch(false);
  try {
    const page = await ctx.newPage();
    await page.goto('https://makerworld.com/en', { waitUntil: 'domcontentloaded' });
    onStatus('Browserfenster geoeffnet. Bitte oben rechts auf "Sign In" bei MakerWorld einloggen ...');
    // Der Login passiert clientseitig; die initialen Seitendaten aendern sich
    // dabei nicht. Deshalb regelmaessig neu laden und die Session pruefen.
    for (let i = 0; i < 60; i++) {           // bis zu ~6 Minuten
      await sleep(6000);
      let s;
      try { s = await readSession(page); } catch { s = null; }
      if (!s || !s.handle) {
        try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }); } catch {}
        try { s = await readSession(page); } catch { continue; }
      }
      if (s && s.handle) {
        onStatus('Eingeloggt als @' + s.handle + ' — Fenster schliesst gleich.');
        try {   // Session gleich exportieren (fuer Uebertragung auf den Pi)
          const state = await ctx.storageState();
          const mw = (state.cookies || []).filter(c => /makerworld|bambulab/i.test(c.domain));
          fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookies: mw, exported: new Date().toISOString() }, null, 2));
        } catch {}
        await sleep(1500);
        return { loggedIn: true, handle: s.handle };
      }
      onStatus(`Warte auf Login … (${i + 1})`);
    }
    return { loggedIn: false };
  } finally { await ctx.close(); }
}

// ---------------------------------------------------------------------------
// Analytics-Felder (wie im Konsolen-Skript).
const RAW = ['impression','view','download','print','collect','like','follower','boost',
  'pointFromModel','pointFromInst','pointFromRatings','pointFromOthers'];
const cell = (row, f) => { const v = row[f]; return (v && typeof v === 'object') ? 0 : (v ?? 0); };

async function collectIds(page, handle) {
  const url = `https://makerworld.com/en/@${handle}/upload`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1500);
  let last = 0, stable = 0;
  for (let i = 0; i < 80 && stable < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(800);
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h === last) stable++; else { stable = 0; last = h; }
  }
  return page.evaluate(() =>
    [...new Set([...document.body.innerHTML.matchAll(/\/models\/(\d+)/g)].map(m => m[1]))]
  );
}

async function fetchAnalytics(page, buildId, id, from, to, loc = 'en') {
  const u = `https://makerworld.com/_next/data/${buildId}/${loc}/my/data-overview/model/${id}.json`
          + `?designId=${id}&startDate=${from}&endDate=${to}`;
  return page.evaluate(async (url) => {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = await r.text();
    if (t.trim().startsWith('<')) throw new Error('HTML statt JSON');
    return JSON.parse(t).pageProps || {};
  }, u);
}

// Detail-Seite: robust nach bekannten Feldern durchsuchen (Struktur kann sich
// aendern -> Rohantwort wird zusaetzlich gespeichert).
async function fetchDetail(page, id) {
  await page.goto(`https://makerworld.com/en/models/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1200);
  return page.evaluate(() => {
    const N = window.__NEXT_DATA__;
    const pp = (N?.props || {}).pageProps || {};
    // erstes Objekt finden, das wie das Design aussieht
    const seen = new Set(); let design = null;
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return;
      seen.add(o);
      if (!design && (o.title || o.name) &&
          (o.designId || o.id) && ('likeCount' in o || 'collectCount' in o || 'instances' in o || 'summary' in o))
        design = o;
      for (const k in o) { try { walk(o[k], depth + 1); } catch {} }
    })(pp, 0);
    const d = design || {};
    const pick = (...keys) => { for (const k of keys) if (d[k] != null) return d[k]; return null; };
    const tagsRaw = pick('designTags','tags','modelTags') || [];
    const tags = Array.isArray(tagsRaw)
      ? tagsRaw.map(t => (typeof t === 'string' ? t : (t.name || t.title || t.tag))).filter(Boolean)
      : [];
    // Bild-URLs aus dem gesamten pageProps sammeln
    const imgs = new Set();
    (function walk(o, depth) {
      if (!o || depth > 7) return;
      if (typeof o === 'string') {
        if (/https?:\/\/[^\s"']+\.(?:jpe?g|png|webp)/i.test(o) && /makerworld|bambu|mkw/i.test(o)) imgs.add(o);
        return;
      }
      if (typeof o === 'object') for (const k in o) { try { walk(o[k], depth + 1); } catch {} }
    })(d, 0);
    return {
      found: !!design,
      title: pick('title','name'),
      description: pick('description','summary','intro','content'),
      tags,
      tagCount: tags.length,
      likeCount: pick('likeCount','likes'),
      collectCount: pick('collectionCount','collectCount','collects','favoriteCount'),
      commentCount: pick('commentCount','comments'),
      // MakerWorld hat keine Sterne-Bewertung; Rating bleibt leer.
      ratingAvg: pick('rating','ratingScore','score','starAvg'),
      ratingCount: pick('ratingCount','rateCount','reviewCount'),
      instanceCount: pick('instanceCount','instanceCnt') ?? (Array.isArray(d.instances) ? d.instances.length : null),
      cover: pick('coverUrl','cover','coverImage','thumbnail'),
      license: (v => v && typeof v === 'object' ? (v.name || v.type || null) : v)(pick('license','licenseType')),
      category: (() => { const c = pick('categories','category','categoryName');
        if (Array.isArray(c)) return c.map(x => x?.name || x?.title || x).filter(Boolean).join(' / ') || null;
        return typeof c === 'object' ? (c?.name || null) : c; })(),
      // Nur echte, vom Nutzer hochgeladene Galerie-Bilder (/design/, /instance/).
      // MakerWorld erzeugt aus der 3mf/STL laufend neue Render (/msfile/ mit
      // wechselndem ?at=) sowie Material-/Lizenz-Badges (store.bblcdn,
      // /product/public/) – die werden ignoriert (sonst Bild-Flut + Fehl-Events).
      images: [...new Set([...imgs]
        .filter(u => /\/(?:design|instance)\//i.test(u))
        .map(u => String(u).split('?')[0]))].slice(0, 40),
      raw: d
    };
  });
}

async function downloadImages(id, urls) {
  const dir = path.join(IMAGES_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const ext = (url.match(/\.(jpe?g|png|webp)/i)?.[1] || 'jpg').toLowerCase();
    const rel = path.join('images', String(id), `${i}.${ext}`);
    const abs = path.join(DATA_DIR, rel);
    try {
      if (!fs.existsSync(abs)) {
        const r = await fetch(url);
        if (r.ok) fs.writeFileSync(abs, Buffer.from(await r.arrayBuffer()));
      }
      out.push({ position: i, url, local_path: rel });
    } catch { /* Bild ueberspringen */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ein kompletter Pull. onLog(msg) fuer Live-Fortschritt.
export async function runPull({ mode = 'manual', onLog = () => {} } = {}) {
  const startDate = getSetting('start_date', '2023-01-01');
  const endDate = new Date().toISOString().slice(0, 10);
  const capturedAt = nowIso();
  const run = db.prepare(`INSERT INTO pull_runs(started_at,status,mode,models_ok,models_failed,log)
                          VALUES(?,?,?,?,?,?)`).run(capturedAt, 'running', mode, 0, 0, '');
  const runId = run.lastInsertRowid;
  const lines = [];
  const log = (m) => { lines.push(m); onLog(m); db.prepare('UPDATE pull_runs SET log=? WHERE id=?').run(lines.join('\n'), runId); };

  const ctx = await launch(false, true);   // sichtbares Chrome (off-screen), sonst blockt Cloudflare
  let ok = 0, failed = 0, accountSaved = false;
  try {
    const page = await ctx.newPage();
    await page.goto('https://makerworld.com/en', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    let s = await readSession(page);
    if (!s.handle) {                        // evtl. Cloudflare-Zwischenseite -> kurz warten & neu laden
      await sleep(3000);
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
      await sleep(1500);
      s = await readSession(page);
    }
    if (!s.handle) {                        // Profil nicht eingeloggt -> Cookies aus session.json injizieren
      if (await injectSessionCookies(ctx)) {
        onLog('Session aus session.json geladen ...');
        await page.goto('https://makerworld.com/en', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(2000); s = await readSession(page);
      }
    }
    if (!s.handle) throw new Error('Nicht eingeloggt. Bitte zuerst den Login ausfuehren (bzw. Session übertragen).');
    log(`Konto @${s.handle}, Build ${s.buildId}. Sammle Modell-IDs ...`);

    const ids = await collectIds(page, s.handle);
    log(`${ids.length} Modelle gefunden.`);

    // Der _next/data-Endpunkt liefert nur JSON, wenn der Sprachpfad zur Session
    // passt. Sprache automatisch erkennen (dein Konto laeuft auf de) und cachen.
    let LOC = null;
    const urlLoc = (() => { try { return new URL(page.url()).pathname.split('/')[1]; } catch { return ''; } })();
    const locCandidates = [urlLoc, 'de', 'en', 'zh'].filter((v, i, a) => v && a.indexOf(v) === i);
    const analytics = async (id) => {
      const cands = LOC ? [LOC] : locCandidates;
      let lastErr;
      for (const l of cands) {
        try { const pp = await fetchAnalytics(page, s.buildId, id, startDate, endDate, l); LOC = l; return pp; }
        catch (e) { lastErr = e; if (!String(e.message).includes('HTML')) throw e; }
      }
      throw lastErr;
    };

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        const pp = await analytics(id);
        if (i === 0 || (LOC && i < 2)) log('Sprachpfad: ' + LOC);
        if (!pp.modelData) throw new Error('keine modelData (fremdes Modell?)');
        if (!accountSaved && pp.session?.user) { writeAccount(pp.session.user, capturedAt); accountSaved = true; log(`Konto-Snapshot: ${pp.session.user.point} Punkte, ${pp.session.user.fanCount} Fans`); }

        // Detail (Beschreibung, Tags, Bewertungen, Bilder)
        let det = {};
        try { det = await fetchDetail(page, id); }
        catch (e) { log(`  Detail ${id} uebersprungen: ${e.message}`); }

        // Zentrale Schreiblogik (inkl. Bilder, Titelbild-Hash, Aenderungserkennung, geplante Merges)
        const r = await writeModel({ id, pp, detail: det, capturedAt });
        ok++;
        log(`[${i + 1}/${ids.length}] ${r.title} — ${r.days} Tage, ${r.tags} Tags, ${r.images} Bilder` + (r.merged ? ` — geplantes Produkt verschmolzen` : ''));
      } catch (e) {
        failed++;
        log(`[${i + 1}/${ids.length}] FEHLER ${id}: ${e.message}`);
      }
      db.prepare('UPDATE pull_runs SET models_ok=?, models_failed=? WHERE id=?').run(ok, failed, runId);
      await sleep(1400);
    }

    db.prepare('UPDATE pull_runs SET status=?, finished_at=?, models_ok=?, models_failed=? WHERE id=?')
      .run('ok', nowIso(), ok, failed, runId);
    log(`Fertig: ${ok} ok, ${failed} Fehler.`);
    return { ok, failed, runId };
  } catch (e) {
    db.prepare('UPDATE pull_runs SET status=?, finished_at=?, log=? WHERE id=?')
      .run('error', nowIso(), [...lines, 'ABBRUCH: ' + e.message].join('\n'), runId);
    onLog('ABBRUCH: ' + e.message);
    throw e;
  } finally {
    await ctx.close();
  }
}

// CLI
import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const arg = process.argv[2];
  if (arg === '--login') {
    interactiveLogin(m => console.log(m)).then(r => { console.log(r); process.exit(0); });
  } else if (arg === '--pull') {
    runPull({ mode: 'manual', onLog: m => console.log(m) }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  } else if (arg === '--check') {
    checkLogin().then(r => { console.log(r); process.exit(0); });
  } else if (arg === '--export-session') {
    exportSession().then(r => { console.log(r); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
  } else {
    console.log('Aufruf: node server/scraper.js [--login|--pull|--check|--export-session]');
    process.exit(0);
  }
}
