// Tag-Assistent: MakerWorld erlaubt bis zu 50 Tags je Modell. Wir recherchieren, welche Tags die bestplatzierten Modelle zum
// Thema nutzen (Such-API) und wie haeufig Nutzer jeden Tag insgesamt verwenden (Vorschlags-API liefert Nutzungszahlen),
// bewerten beides zusammen mit deinen eigenen Erfahrungswerten und schlagen bis zu 50 Tags vor.
// Die Abfragen laufen im eingeloggten Browser (Cloudflare blockt einfaches HTTP) als Browser-Auftrag, siehe mwjobs.js.
import express from 'express';
import { db, getSetting, setSetting, nowIso } from './db.js';
import { T } from './i18n.js';
import { startMwJob } from './mwjobs.js';
import { modelsWithKpis, aggregateGroups } from './kpi.js';

const app = express.Router();
export const router = app;

db.exec(`CREATE TABLE IF NOT EXISTS tag_counts (
  key        TEXT PRIMARY KEY,   -- normalisiert (klein, einfache Leerzeichen)
  text       TEXT,               -- Schreibweise mit der groessten Nutzung
  count      INTEGER,            -- wie oft Nutzer den Tag auf MakerWorld verwenden (laut Vorschlags-API)
  fetched_at TEXT
);`);

export const MAX_TAGS = 50, MAX_TAG_LEN = 40, CACHE_DAYS = 14;
const STOP = new Set('the and for with a an to of in on at by from this that your you our my it is are be as v1 v2 v3 set pack kit pcs piece pieces mm cm inch'.split(' '));
export const norm = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const fold = s => norm(s).replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
export const tokens = s => norm(s).replace(/[^a-z0-9äöüß ]+/g, ' ').split(' ').filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
// Deutsche Titelwoerter -> englische Tag-Begriffe (MakerWorld-Tags sind ueberwiegend englisch)
const DE_EN = { bierdeckel: ['coaster'], untersetzer: ['coaster'], fussball: ['football', 'soccer'], geschenk: ['gift'], halter: ['holder'], halterung: ['holder', 'mount'], staender: ['stand'],
  schluesselanhaenger: ['keychain'], schluesselbrett: ['key holder'], aufbewahrung: ['storage'], dose: ['box'], schachtel: ['box'], becher: ['cup'], vase: ['vase'], lampe: ['lamp'], haken: ['hook'],
  wandhalter: ['wall mount', 'holder'], regal: ['shelf'], schreibtisch: ['desk'], kabel: ['cable'], kabelhalter: ['cable holder'], deko: ['decor'], dekoration: ['decoration'], weihnachten: ['christmas'],
  ostern: ['easter'], tier: ['animal'], katze: ['cat'], hund: ['dog'], flaschenoeffner: ['bottle opener'], oeffner: ['opener'], stiftehalter: ['pen holder'], blumentopf: ['planter'], pflanzentopf: ['planter'],
  tuerstopper: ['door stopper'], handyhalter: ['phone holder', 'phone stand'], handy: ['phone'], kopfhoerer: ['headphone'], ladestation: ['charging station'], werkzeug: ['tool'], werkzeughalter: ['tool holder'],
  spielzeug: ['toy'], spiel: ['game'], bier: ['beer'], wein: ['wine'], kaffee: ['coffee'], kueche: ['kitchen'], bad: ['bathroom'], garten: ['garden'], auto: ['car'], fahrrad: ['bike'], verein: ['club'], fans: ['fan'] };
export const translate = word => DE_EN[fold(word)] || [];
// Kernbegriffe eines Titels: seine Woerter plus englische Entsprechungen
export function coreTokens(title) { const base = tokens(title), out = new Set(base); for (const w of base) for (const e of translate(w)) for (const t of tokens(e)) out.add(t); return out; }

// Titel -> Suchanfragen (ganzer Titel, wichtigste Wortpaare, englische Fassung, Kategorie, eigene Tags)
export function buildQueries({ title = '', category = '', tags = [] }) {
  const clean = String(title).replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const w = tokens(clean), q = [];
  if (clean) q.push(clean.split(' ').slice(0, 5).join(' '));
  // Titel mit englischen Entsprechungen ("borussia dortmund bierdeckel" -> "borussia dortmund coaster")
  const en = clean.split(' ').map(x => translate(x)[0] || x).join(' ').trim(); if (en && norm(en) !== norm(clean)) q.push(en.split(' ').slice(0, 5).join(' '));
  for (let i = 0; i + 1 < w.length && q.length < 4; i++) q.push(w[i] + ' ' + w[i + 1]);
  if (w.length === 1) q.push(w[0]);
  if (category) q.push(String(category).split(/[\/,&]/)[0].trim());
  for (const t of tags.slice(0, 2)) q.push(t);
  return [...new Set(q.map(norm).filter(Boolean))].slice(0, 6);
}
// Begriffe, nach denen Nutzer tippen koennten (Buchstaben-Expansion): Titelwoerter und englische Entsprechungen, je Anfrage max. 5 Treffer
export function expansionSeeds(title, queries) {
  const seeds = [...queries.filter(q => q.split(' ').length <= 3).slice(0, 1)];
  const w = tokens(title);
  for (const t of w) { if (seeds.length >= 4) break; if (!seeds.includes(t)) seeds.push(t); }
  for (const t of w) for (const e of translate(t)) { if (seeds.length >= 5) break; if (!seeds.includes(norm(e))) seeds.push(norm(e)); }
  return seeds;
}
// Titel-Kandidaten: Einzelwoerter, Wortpaare, ganzer Titel
export function titleCandidates(title) {
  const w = tokens(title), out = new Set(w);
  for (let i = 0; i + 1 < w.length; i++) out.add(w[i] + ' ' + w[i + 1]);
  const full = norm(title).replace(/[^a-z0-9äöüß ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (full && full.length <= MAX_TAG_LEN && w.length >= 2) out.add(full);
  return [...out];
}

// Reine Bewertung (ohne Browser, gut testbar). models: [{id,title,tags,dl}], counts: {key: Nutzungszahl},
// extra: [{text,count,seed}] (von Nutzern getippte Varianten), ownLift: {key: Faktor}, forbidden: [Woerter]
// focus 'close' (Standard): nur Tags nah am Original (Titel-Begriffe, Tags AEHNLICHER Modelle) - 'reach': auch allgemeine Reichweiten-Tags.
export function rankTags({ title = '', description = '', category = '', ownTags = [], models = [], counts = {}, extra = [], ownLift = {}, forbidden = [], limit = MAX_TAGS, focus = 'close' }) {
  const core = coreTokens(title), ctxTok = new Set([...tokens(description), ...tokens(category)]);
  const cand = new Map();
  const get = text => { const k = norm(text); if (!k) return null; let c = cand.get(k); if (!c) cand.set(k, c = { key: k, variants: new Map(), usage: 0, simUsage: 0, n: 0, nSim: 0, sources: new Set() }); c.variants.set(text, (c.variants.get(text) || 0) + 1); return c; };
  // Aehnlichkeit jedes Top-Modells zum Original: wie viele Kernbegriffe stecken in Titel/Tags des Modells?
  let totalW = 0, simW = 0, similar = 0; const denom = Math.max(2, Math.min(core.size, 4));
  for (const m of models) {
    const have = new Set([...tokens(m.title), ...(m.tags || []).flatMap(tokens)]);
    const hits = [...core].filter(t => have.has(t)).length, sim = Math.min(1, hits / denom);
    const w = 1 + Math.log10(1 + (m.dl || 0)), ws = sim * w; totalW += w; simW += ws; if (hits) similar++;
    for (const t of new Set((m.tags || []).map(x => String(x).trim()).filter(Boolean))) { const c = get(t); c.usage += w; c.n++; c.simUsage += ws; if (hits) c.nSim++; c.sources.add('top'); }
  }
  for (const t of titleCandidates(title)) get(t).sources.add('titel');
  for (const w of core) { if (!tokens(title).includes(w)) get(w).sources.add('titel'); }                // englische Entsprechungen (coaster, football ...)
  for (const t of ownTags) { const c = get(t); if (c) c.sources.add('eigen'); }
  for (const e of extra) { const c = get(e.text); if (c) { c.sources.add('nutzer'); if (e.count != null) counts[c.key] = Math.max(counts[c.key] || 0, e.count); } }
  const bad = forbidden.map(norm).filter(Boolean), titleTok = new Set(tokens(title));
  const scored = [];
  for (const c of cand.values()) {
    const tok = tokens(c.key), len = c.key.length;
    if (len < 2 || len > MAX_TAG_LEN || /^\d+$/.test(c.key) || /[&#<>;]/.test(c.key)) continue;
    if (bad.some(b => new RegExp('(^|[^a-z0-9])' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])').test(c.key))) continue;
    const count = counts[c.key] ?? null, own = c.sources.has('eigen'), inTitle = c.sources.has('titel');
    const rel = tok.some(t => core.has(t)) ? 1 : tok.some(t => ctxTok.has(t)) ? 0.6 : 0;
    const simShare = simW ? c.simUsage / simW : 0, share = totalW ? c.usage / totalW : 0;
    let keep;
    if (focus === 'reach') keep = own || inTitle || rel > 0 || (c.n >= 2 && share >= 0.08);
    else { const need = (count || 0) >= 100000 ? 0.5 : (count || 0) >= 30000 ? 0.35 : 0.15;   // allgemeine Riesen-Tags (decor, art ...) nur, wenn fast alle aehnlichen Modelle sie nutzen; Themen-Tags (soccer) schon bei 15 %
      keep = own || inTitle || (rel >= 1 && (c.sources.has('top') || (count || 0) >= 30)) || (rel > 0 && simShare >= 0.1) || (c.nSim >= 3 && simShare >= need); }
    if (!keep) continue;
    if (count === 0 && c.n < 2 && !own && !inTitle) continue;                                        // niemand nutzt ihn
    if (!own && !inTitle && !c.sources.has('top') && (count || 0) < 30) continue;                     // reine Tipp-Variante mit kaum Nutzung
    if (focus !== 'reach') {
      if (inTitle && !own && !c.sources.has('top') && !c.sources.has('nutzer') && tok.length > 1 && !(count > 0)) continue;   // Titel-Kombination, die niemand nutzt
      if (!own && !inTitle && (count || 0) < 5 && c.nSim < 2) continue;                              // praktisch ungenutzt und nur ein Modell
      if (!own && !inTitle && !c.sources.has('top') && !tok.some(t => titleTok.has(t))) continue;     // Tipp-Variante nur ueber eine Uebersetzung (coaster alien ...)
    }
    const foreign = tok.length > 1 ? Math.min(0.2, 0.1 * tok.filter(t => !core.has(t) && !ctxTok.has(t)).length) : 0;   // Zusatzwoerter ohne Bezug zum Titel (borussia moenchengladbach)
    scored.push({ c, count, rel, simShare, share, own, inTitle, foreign });
  }
  const maxSim = Math.max(1e-9, ...scored.map(x => x.simShare)), maxShare = Math.max(1e-9, ...scored.map(x => x.share)), maxCount = Math.max(1, ...scored.map(x => x.count || 0));
  const out0 = scored.map(({ c, count, rel, simShare, share, own, inTitle, foreign }) => {
    const lift = ownLift[c.key] || 0, pop = count ? Math.log10(count + 1) / Math.log10(maxCount + 1) : 0;
    const score = focus === 'reach'
      ? 0.5 * (share / maxShare) + 0.3 * pop + 0.2 * rel + (own ? 0.15 : 0) + Math.min(0.2, Math.max(0, lift) * 0.05)
      : 0.4 * (simShare / maxSim) + 0.3 * rel + 0.15 * pop + 0.1 * (share / maxShare) + (own ? 0.15 : 0) + (inTitle ? 0.1 : 0) - foreign + Math.min(0.2, Math.max(0, lift) * 0.05);
    const display = [...c.variants.entries()].sort((a, b) => b[1] - a[1] || (a[0] === a[0].toLowerCase() ? -1 : 1))[0][0];
    return { tag: display === display.toUpperCase() && display.length > 4 ? display.toLowerCase() : display, key: c.key, count, usedBy: c.nSim, similar, share: +share.toFixed(3), simShare: +simShare.toFixed(3), rel, lift: +lift.toFixed(2), score: +score.toFixed(4), sources: [...c.sources] };
  });
  out0.sort((a, b) => b.score - a.score || (b.count || 0) - (a.count || 0));
  const out = [], seen = new Set();
  for (const x of out0) {
    const stem = x.key.length > 4 ? x.key.replace(/(es|s)$/, '') : x.key;       // desk / desks nicht doppelt
    if (seen.has(stem) || seen.has(x.key)) continue; seen.add(stem); seen.add(x.key);
    out.push({ ...x, tier: x.count == null ? 'niche' : x.count >= 20000 ? 'broad' : x.count >= 1500 ? 'mid' : 'niche' });
    if (out.length >= limit) break;
  }
  return out;
}

// ---- Abfragen im Browser (diese Funktionen laufen IN der Seite und duerfen nichts von aussen verwenden) ----
async function inPageSearch({ q, offset }) {
  const r = await fetch('/api/v1/search-service/select/design2?orderBy=score&designType=0&keyword=' + encodeURIComponent(q) + '&limit=20&offset=' + offset, { credentials: 'include' });
  if (!r.ok) throw new Error('Suche HTTP ' + r.status);
  const j = await r.json();
  return (j.hits || []).map(h => ({ id: h.id, title: h.title, tags: h.tags || [], dl: h.downloadCount || 0, likes: h.likeCount || 0 }));
}
async function inPageSuggest(kws) {
  const out = [];
  for (const kw of kws) {
    try {
      const r = await fetch('/api/v1/search-service/suggest?keyword=' + encodeURIComponent(kw) + '&type=design_tag', { credentials: 'include' });
      const j = r.ok ? await r.json() : { suggestions: [] };
      out.push({ kw, items: (j.suggestions || []).map(s => ({ text: String(s.text || '').replace(/&amp;/g, '&'), count: s.count || 0 })) });
    } catch { out.push({ kw, items: [] }); }
    await new Promise(res => setTimeout(res, +globalThis.__MW_DELAY__ || 160));
  }
  return out;
}

const cacheGet = db.prepare('SELECT count, fetched_at FROM tag_counts WHERE key=?');
const cachePut = db.prepare(`INSERT INTO tag_counts(key,text,count,fetched_at) VALUES(?,?,?,?)
  ON CONFLICT(key) DO UPDATE SET text=CASE WHEN excluded.count>=tag_counts.count THEN excluded.text ELSE tag_counts.text END, count=MAX(excluded.count,tag_counts.count), fetched_at=excluded.fetched_at`);
const fresh = row => row && Date.now() - Date.parse(row.fetched_at) < CACHE_DAYS * 86400000;

// Eigene Erfahrungswerte: Tags, bei denen deine Modelle ueberdurchschnittlich viele Views haben (mind. 2 Modelle)
export function ownTagLift() {
  const models = modelsWithKpis().filter(m => !m.planned);
  const all = aggregateGroups(models, 'tag').filter(t => t.key !== '—');
  const avg = models.length ? models.reduce((s, m) => s + (m.view || 0), 0) / models.length : 0;
  const lift = {}; for (const t of all) if (t.count >= 2 && avg > 0) lift[norm(t.key)] = t.view / t.count / avg - 1;
  return lift;
}

// Komplette Recherche. page: eingeloggte MakerWorld-Seite; plan: { title, description, category, tags, depth }
export async function researchTags(page, plan, log = () => {}) {
  const queries = buildQueries(plan);
  log(T(`Suchanfragen: ${queries.join(' | ')}`, `Search queries: ${queries.join(' | ')}`));
  const byId = new Map();
  for (const q of queries) for (const offset of [0, 20]) {
    try { for (const m of await page.evaluate(inPageSearch, { q, offset })) if (!byId.has(m.id)) byId.set(m.id, m); }
    catch (e) { log(`${q}: ${e.message}`); }
  }
  const models = [...byId.values()];
  log(T(`${models.length} Top-Modelle ausgewertet.`, `${models.length} top models analysed.`));

  // Kandidaten fuer die Nutzungszahlen: haeufigste Tags der Top-Modelle + Titel-Kandidaten + eigene Tags
  const pre = rankTags({ title: plan.title, description: plan.description, category: plan.category, ownTags: plan.tags || [], models, limit: 90, focus: 'reach' });
  const want = [...new Set([...pre.map(p => p.tag), ...titleCandidates(plan.title), ...(plan.tags || [])].map(norm))].slice(0, 110);
  const counts = {}, todo = [];
  for (const k of want) { const row = cacheGet.get(k); if (fresh(row)) counts[k] = row.count; else todo.push(k); }
  let calls = 0; const extra = [];
  const store = (items, seed) => { for (const it of items) { const k = norm(it.text); if (!k) continue; counts[k] = Math.max(counts[k] || 0, it.count); cachePut.run(k, it.text, it.count, nowIso()); if (seed && k.includes(seed)) extra.push({ text: it.text, count: it.count, seed }); } };
  for (let i = 0; i < todo.length; i += 25) {
    const part = todo.slice(i, i + 25);
    const res = await page.evaluate(inPageSuggest, part); calls += part.length;
    for (const r of res) { store(r.items); if (!r.items.some(x => norm(x.text) === r.kw)) { counts[r.kw] = counts[r.kw] || 0; cachePut.run(r.kw, r.kw, 0, nowIso()); } }
    log(T(`Nutzungszahlen ${Math.min(i + 25, todo.length)}/${todo.length}`, `Usage counts ${Math.min(i + 25, todo.length)}/${todo.length}`));
  }
  // Tiefe Recherche: was tippen Nutzer nach dem Hauptbegriff? (Vorschlags-API liefert je Anfrage nur 5 Treffer -> Buchstaben anhaengen)
  if (plan.depth !== 'fast') {
    const seeds = expansionSeeds(plan.title, queries);
    for (const seed of seeds) {
      const kws = 'abcdefghijklmnopqrstuvwxyz'.split('').map(l => seed + ' ' + l);
      const res = await page.evaluate(inPageSuggest, kws); calls += kws.length;
      for (const r of res) store(r.items, seed);
      log(T(`Nutzer-Eingaben zu „${seed}“ geprüft.`, `User input for "${seed}" checked.`));
    }
  }
  const forbidden = (() => { try { return JSON.parse(getSetting('mw_forbidden_words', '[]')); } catch { return []; } })();
  const tags = rankTags({ title: plan.title, description: plan.description, category: plan.category, ownTags: plan.tags || [], models, counts, extra, ownLift: ownTagLift(), forbidden, focus: plan.focus });
  log(T(`${tags.length} Tags vorgeschlagen.`, `${tags.length} tags suggested.`));
  return { created_at: nowIso(), title: plan.title, queries, models: models.length, similar: tags[0]?.similar ?? 0, focus: plan.focus || 'close', suggestCalls: calls, tags };
}

app.post('/api/tags/research', (req, res) => {
  const b = req.body || {};
  let { design_id, title, description, category, tags } = b;
  if (design_id) {
    const m = db.prepare('SELECT title, description, tags, category FROM models WHERE design_id=?').get(design_id);
    if (m) { title = title ?? m.title; description = description ?? m.description; category = category ?? m.category; if (tags === undefined) { try { tags = JSON.parse(m.tags || '[]'); } catch { tags = []; } } }
  }
  title = String(title || '').trim();
  if (!title) return res.status(400).json({ error: T('Titel fehlt', 'title missing') });
  const plan = { title, description: String(description || ''), category: String(category || ''), tags: (Array.isArray(tags) ? tags : String(tags || '').split(',')).map(x => String(x).trim()).filter(Boolean), depth: b.depth === 'fast' ? 'fast' : 'deep', focus: b.focus === 'reach' ? 'reach' : 'close' };
  const r = startMwJob('tags', async ({ page, log }) => {
    const result = await researchTags(page, plan, log);
    if (design_id) setSetting('tag_result:' + design_id, JSON.stringify(result));
    return result;
  });
  res.json(r);
});
app.get('/api/tags/result/:design_id', (req, res) => { try { res.json(JSON.parse(getSetting('tag_result:' + req.params.design_id, 'null'))); } catch { res.json(null); } });
