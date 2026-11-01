// Kern: Sprache (t), DOM-Helfer (el), API-Aufruf + Fehlerbanner, Formate, Konstanten, Routing/Navigation/Tabs, Mobil-Menue.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
// MakerWorld Analytics — Frontend (helles, eckiges CRM). Vanilla JS + Chart.js
const $ = (s, r = document) => r.querySelector(s);
// ---- Sprache / i18n -------------------------------------------------------
// Quelle der Wahrheit im Code ist Deutsch; t() übersetzt zur Laufzeit ins
// Englische (Wörterbuch TR am Dateiende). Alle Texte laufen über el() -> t().
const LANG = { cur: (() => { try { return localStorage.getItem('lang') || 'de'; } catch { return 'de'; } })() };
const LOC = () => LANG.cur === 'en' ? 'en-US' : 'de-DE';
// Dynamische Saetze (mit Zahlen/Namen) uebersetzen Regeln aus TR_RULES (i18n-en.js): [RegExp, Ersetzung | Funktion].
// Nicht uebersetzbare Texte merkt sich window.__missingT (Entwicklungshilfe, siehe tests/i18n.test.mjs).
function t(s) {
  if (s == null || LANG.cur === 'de') return s;
  s = String(s); if (TR[s] != null) return TR[s];
  for (const [re, rep] of TR_RULES) { const m = s.match(re); if (m) return typeof rep === 'function' ? rep(...m) : s.replace(re, rep); }
  // Muster "Label (Zusatz)" -> Präfix (und ggf. Zähl-Wort im Zusatz) übersetzen.
  const m = s.match(/^(.+?) \((.*)\)$/);
  if (m && TR[m[1]] != null) {
    let inner = m[2]; const w = inner.match(/^([\d.,]+) (.+)$/);
    if (w && TR[w[2]] != null) inner = w[1] + ' ' + TR[w[2]];
    return TR[m[1]] + ' (' + inner + ')';
  }
  if (/[A-Za-zÄÖÜäöüß]{3}/.test(s)) (window.__missingT = window.__missingT || new Set()).add(s);
  return s;
}
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : (typeof v === 'string' && (k === 'placeholder' || k === 'title' || k === 'aria-label' || k === 'alt') ? t(v) : v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(t(String(c))));
  // Tastatur: alles Klickbare, das kein echtes Bedienelement ist (Zeilen, Karten, Chips, Links ohne href),
  // wird fokussierbar und reagiert auf Enter/Leertaste.
  if (typeof attrs.onclick === 'function' && !['button', 'input', 'select', 'textarea', 'label', 'summary'].includes(tag) && !(tag === 'a' && attrs.href)) {
    n.setAttribute('tabindex', '0');
    if (tag !== 'tr' && tag !== 'th' && tag !== 'td' && !n.hasAttribute('role')) n.setAttribute('role', 'button');
    n.addEventListener('keydown', e => { if (e.target === n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); n.click(); } });
  }
  return n;
};
// Zentrale API-Funktion: Netzwerk-/Serverfehler zeigen einen Banner (sonst bleibt die Seite stumm leer).
// 4xx mit JSON-Fehlertext wird wie bisher an den Aufrufer zurueckgegeben (z.B. „Nicht bezahlt").
let _bannerT;
function showBanner(msg) {
  let b = document.getElementById('errBanner');
  if (!b) { b = document.createElement('div'); b.id = 'errBanner'; b.className = 'errbanner'; b.addEventListener('click', () => { b.hidden = true; }); document.body.append(b); }
  b.textContent = t(msg); b.hidden = false; clearTimeout(_bannerT); _bannerT = setTimeout(() => { b.hidden = true; }, 12000);
}
const api = async (p, opt) => {
  let r;
  try { r = await fetch('/api' + p, { ...opt, headers: { 'X-Lang': LANG.cur, ...(opt && opt.headers) } }); }
  catch (e) { showBanner('Server nicht erreichbar — Verbindung zur Pi prüfen.'); throw e; }
  let body = null; try { body = await r.json(); } catch { /* kein JSON */ }
  if (!r.ok) {
    if (r.status >= 500 || !body) showBanner(`Fehler ${r.status} bei ${p}` + (body && body.error ? ': ' + body.error : ''));
    if (body) return body;
    throw new Error('HTTP ' + r.status + ' ' + p);
  }
  return body;
};
window.addEventListener('unhandledrejection', e => { const m = e.reason && e.reason.message ? e.reason.message : String(e.reason); if (!/HTTP \d+|Failed to fetch|Load failed/.test(m)) showBanner('Unerwarteter Fehler: ' + m); });
const jpost = (p, body, m = 'POST') => api(p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fmt = n => n == null ? '–' : Number(n).toLocaleString(LOC());
const fmt1 = n => n == null ? '–' : Number(n).toLocaleString(LOC(), { maximumFractionDigits: 1 });
const eur = n => n == null ? '–' : Number(n).toLocaleString(LOC(), { style: 'currency', currency: 'EUR' });
const rate = () => STATE.overview?.settings?.eur_per_point || (40 / 524);
const nice = iso => iso ? new Date(iso).toLocaleString(LOC(), { dateStyle: 'medium', timeStyle: 'short' }) : '–';
// Einheitliches Datumsformat in der Anzeige: TT.MM.JJJJ (de) bzw. MM/DD/YYYY (en). Eingaben/Diagramme bleiben ISO.
const dmy = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return iso ? String(iso) : '–';
  return LANG.cur === 'en' ? `${m[2]}/${m[3]}/${m[1]}` : `${m[3]}.${m[2]}.${m[1]}`; };
const today = () => new Date().toISOString().slice(0, 10);
const COLORS = ['#1f5c8f','#1a7f37','#b4620a','#c1332d','#6b4fa1','#0e7490','#a3357a','#4b5563','#2563eb','#059669','#d97706','#7c3aed'];

const METRICS = [['view','Views'],['impression','Impressionen'],['download','Downloads'],['print','Drucke'],
  ['collect','Gesammelt'],['like','Likes'],['follower','Follower'],['boost','Boost'],['points','Punkte']];
const metricLabel = m => (METRICS.find(x => x[0] === m) || [m, m])[1];
const STATUSES = [['idee','Idee'],['arbeit','In Arbeit'],['live','Live'],['update','Update geplant'],['archiv','Archiviert']];
const STATUS_COLOR = { idee: '#6b7280', arbeit: '#9a6a00', live: '#1a7f37', update: '#1f5c8f', archiv: '#b0b4b9' };
const statusLabel = s => (STATUSES.find(x => x[0] === s) || ['live', 'Live']).find((_, i) => i === 1) || 'Live';
const stOf = m => m.status || 'live';
function statusBadge(s) { return el('span', { class: 'tag', style: `background:${STATUS_COLOR[s] || '#6b7280'}` }, statusLabel(s)); }

// CSV-Export der aktuell in #view sichtbaren Tabelle (bzw. per Selektor).
function exportTableCsv(filename, sel = '#view table') {
  const table = document.querySelector(sel);
  if (!table) return toast('Keine Tabelle gefunden.');
  const rows = [...table.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('th,td')]
    .map(c => { const t = (c.textContent || '').trim().replace(/ | /g, ''); return /[",\n;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }).join(';'));
  const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename }); document.body.append(a); a.click(); a.remove();
}
const csvBtn = (name) => el('button', { class: 'btn sm', onclick: () => exportTableCsv(name) }, 'CSV');

let STATE = { overview: null };
// Anzeigenamen der Alert-Typen (statt roher Kuerzel wie STALL/COOL).
const ALERT_LABELS = { hot: 'Läuft heiß', cool: 'Kühlt ab', stall: 'Stillstand', goal: 'Ziel erreicht', goal_near: 'Ziel nah' };
// Erklaerungen als Tooltip fuer Tabellenkoepfe und Kennzahlen (Kuerzel wie DL, Impr, CTR%, Punktebegriffe).
const COL_TIPS = {
  'Impressionen': 'Wie oft das Modell in Listen und Suchergebnissen angezeigt wurde', 'Views': 'Aufrufe der Modellseite', 'CTR%': 'Klickrate (CTR): Views ÷ Impressionen',
  'Downloads': 'Downloads gesamt', 'Downloads 30 T': 'Downloads in den letzten 30 Tagen', 'Views/Tag': 'Views pro Tag (Ø der letzten 7 Tage)',
  'Trend': 'Veränderung der Views gegenüber der Vorwoche', 'Views-Verlauf 30 T': 'Tägliche Views der letzten 30 Tage (Verlauf)',
  'Gesammelt': 'In Sammlungen anderer Nutzer gespeichert', 'Kommentare': 'Anzahl Kommentare', 'Punkte': 'Punkte, die das Modell seit Beginn eingebracht hat',
  'Verdient': 'Punkte × Punktwert (524 Punkte = 40 €) — rechnerischer Wert, keine Auszahlung', 'Boost': 'Erhaltene Boosts', 'Release': 'Veröffentlichungsdatum auf MakerWorld',
  'Tags': 'Anzahl der Hashtags', 'Drucke': 'Wie oft das Modell nachgedruckt wurde', 'Views 7 T': 'Views der letzten 7 Tage', 'Views 30 T': 'Views der letzten 30 Tage',
  'Downloads 7 T': 'Downloads der letzten 7 Tage', 'Downloads/Tag': 'Downloads pro Tag (Ø 7 Tage)', 'Δ Downloads Woche': 'Downloads: diese Woche minus Vorwoche',
  'Punkte 30 T': 'Punkte der letzten 30 Tage', 'Likes': 'Anzahl Likes'
};
const STAT_TIPS = {
  'Kontostand': 'Aktueller Punktestand Ihres MakerWorld-Kontos (Wallet) laut letztem Pull — noch nicht eingelöst.',
  'Punkte gesamt': 'Summe der Punkte, die alle Ihre Modelle seit Beginn der Aufzeichnung eingebracht haben.',
  'Verdient gesamt': 'Punkte gesamt × Punktwert (aktuell 524 Punkte = 40 €). Rechnerischer Wert, keine Auszahlung.',
  'Downloads · 30 T': 'Downloads in den letzten 30 Tagen', 'Punkte · 30 T': 'Punkte der letzten 30 Tage', 'CTR': 'Klickrate: Views ÷ Impressionen',
  'Impressionen': 'Wie oft das Modell angezeigt wurde', 'Downloads': 'Downloads gesamt', 'Gesammelt': 'In Sammlungen anderer Nutzer gespeichert'
};

// -------- Sparkline (winzige Inline-SVG) --------
function sparkline(vals, w = 72, h = 16) {
  const span = el('span', { class: 'spark' });
  if (!vals || !vals.length) return span;
  const max = Math.max(1, ...vals), n = vals.length;
  const pts = vals.map((v, i) => `${(i / (n - 1 || 1) * (w - 2) + 1).toFixed(1)},${(h - 1 - (v / max) * (h - 3)).toFixed(1)}`).join(' ');
  span.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="#1f5c8f" stroke-width="1"/></svg>`;
  return span;
}
// Serien auf gemeinsame X-Achse (Union aller Datumswerte) ausrichten, damit
// Tooltip/Linien korrekt sind, auch wenn Produkte unterschiedlich früh starten.
// cumulative: vor dem ersten Datenpunkt einer Serie = null (keine Linie),
// danach letzter Wert fortgeschrieben. pro Periode: fehlend = 0.
function alignSeries(series, cumulative) {
  const xs = [...new Set(series.flatMap(s => s.points.map(p => p.x)))].sort((a, b) => String(a).localeCompare(String(b)));
  const datasets = series.map((s, i) => {
    const map = new Map(s.points.map(p => [p.x, p.y]));
    let last = null, started = false;
    const data = xs.map(x => {
      if (map.has(x)) { started = true; last = map.get(x); return last; }
      if (cumulative) return started ? last : null;
      return 0;
    });
    return { label: s.title, data, borderColor: COLORS[i % COLORS.length], backgroundColor: COLORS[i % COLORS.length], tension: .15, pointRadius: 0, borderWidth: 1.5, spanGaps: false };
  });
  return { labels: xs, datasets };
}

function trendCell(pct) {
  if (pct == null) return el('td', { class: 'n muted' }, '–');
  const cls = pct > 0 ? 'pos' : pct < 0 ? 'neg' : '';
  return el('td', { class: 'n ' + cls }, (pct > 0 ? '+' : '') + pct + '%');
}
function deltaCell(v, dec = 0) {
  if (v == null) return el('td', { class: 'n muted' }, '–');
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted';
  return el('td', { class: 'n ' + cls }, (v > 0 ? '+' : '') + fmt1(v));
}

// ---- Navigation: 10 Bereiche, verwandte Seiten als Tabs (alte Adressen wie #momentum bleiben gueltig) ----
const SECTIONS = {
  modelle:      [['overview', 'Übersicht'], ['momentum', 'Momentum'], ['compare', 'Vergleich'], ['groups', 'Kategorien']],
  auswertung:   [['report', 'Wochenbericht'], ['points', 'Punkte & Gutschein']],
  kunden:       [['contacts', 'Liste'], ['leads', 'Leads']],
  projekte:     [['projekte', 'Board'], ['druckplan', 'Druckplan']],
  entwuerfe:    [['pipeline', 'Modell-Pipeline'], ['selbst', 'Eigenprojekte']],
  materialkalk: [['teile', 'Kalkulation & Bauteile'], ['material', 'Filament-Lager']]
};
const SECTION_OF = {}; for (const [sec, tabs] of Object.entries(SECTIONS)) tabs.forEach(([r]) => { SECTION_OF[r] = sec; });
const sectionOf = r => SECTION_OF[r] || r;   // Einzelseiten (heute, revenue, todos, data) sind ihr eigener Bereich
const lastTab = sec => { try { return localStorage.getItem('tab_' + sec); } catch { return null; } };
// Hash -> echte Seite: Bereichsnamen (#modelle) oeffnen den zuletzt benutzten Tab.
function resolveRoute(r) {
  if (routes[r]) return r;
  if (SECTIONS[r]) { const lt = lastTab(r); return SECTIONS[r].some(x => x[0] === lt) ? lt : SECTIONS[r][0][0]; }
  return 'heute';
}
let CUR_ROUTE = null;
function go(route) {
  route = resolveRoute(route);
  CUR_ROUTE = route;
  const sec = sectionOf(route);
  if (SECTIONS[sec]) { try { localStorage.setItem('tab_' + sec, route); } catch {} }
  document.querySelectorAll('nav a').forEach(a => { const on = a.dataset.section === sec; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (location.hash.slice(1) !== route) location.hash = route;
  closeMenu();
  routes[route]();
}
// Klick auf einen Bereich: zuletzt benutzten Tab oeffnen
document.querySelectorAll('nav a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); go(SECTIONS[a.dataset.section] ? a.dataset.section : a.dataset.route); }));
// Browser-Zurueck/Vor und manuell geaenderte Adresse
window.addEventListener('hashchange', () => { const r = location.hash.slice(1); if (r && resolveRoute(r) !== CUR_ROUTE) go(r); });

// ---- Mobil-Menue (Sidebar als ausklappbares Menue unter 800 px) ----
const sidebarEl = () => document.getElementById('sidebar');
function openMenu() { const sb = sidebarEl(); sb.classList.add('open'); $('#navScrim').hidden = false; $('#navToggle').setAttribute('aria-expanded', 'true'); $('#navToggle').setAttribute('aria-label', t('Menü schließen')); const a = sb.querySelector('nav a.active') || sb.querySelector('nav a'); if (a) a.focus({ preventScroll: true }); }
function closeMenu() { const sb = sidebarEl(); if (!sb || !sb.classList.contains('open')) return; sb.classList.remove('open'); $('#navScrim').hidden = true; $('#navToggle').setAttribute('aria-expanded', 'false'); $('#navToggle').setAttribute('aria-label', t('Menü öffnen')); }
$('#navToggle').addEventListener('click', () => sidebarEl().classList.contains('open') ? closeMenu() : openMenu());
$('#navScrim').addEventListener('click', closeMenu);

// Navigations-Beschriftungen je Sprache (Zähler-Badge bleibt erhalten).
const NAVLABELS = {
  heute: ['Heute', 'Today'], modelle: ['Modelle', 'Models'], auswertung: ['Auswertung', 'Analysis'], kunden: ['Kunden', 'Customers'],
  projekte: ['Projekte', 'Projects'], revenue: ['Finanzen', 'Finance'], entwuerfe: ['Ideen & Entwürfe', 'Ideas & Drafts'],
  materialkalk: ['Material & Kalkulation', 'Material & Costing'], todos: ['Aufgaben', 'Tasks'], data: ['Daten & Pull', 'Data & Sync']
};
function applyNavLang() {
  const i = LANG.cur === 'en' ? 1 : 0;
  document.querySelectorAll('nav a').forEach(a => { const lbl = NAVLABELS[a.dataset.section]; if (!lbl) return;
    const cnt = a.querySelector('.cnt'); a.textContent = lbl[i]; if (cnt) a.append(cnt); });
  document.querySelectorAll('.nav-sep').forEach(d => { d.dataset.de = d.dataset.de || d.textContent; d.textContent = t(d.dataset.de); });
  const gs = $('#globalSearch'); if (gs) { gs.dataset.de = gs.dataset.de || gs.placeholder; gs.placeholder = t(gs.dataset.de); }
  [['.skip', null], ['#navToggle', 'aria-label'], ['#globalSearch', 'aria-label']].forEach(([sel, at]) => { const n = document.querySelector(sel); if (!n) return;
    n.__de = n.__de || (at ? n.getAttribute(at) : n.textContent); if (at) n.setAttribute(at, t(n.__de)); else n.textContent = t(n.__de); });
  const pb = $('#pullBtn'); if (pb && !/(läuft|running)/i.test(pb.textContent)) pb.textContent = t('Live-Pull starten');
  document.querySelectorAll('#langSw a').forEach(a => a.classList.toggle('on', a.dataset.lang === LANG.cur));
  document.documentElement.lang = LANG.cur;
}
document.querySelectorAll('#langSw a').forEach(a => a.addEventListener('click', e => { e.preventDefault(); setLang(a.dataset.lang); }));
function setLang(l) { if (l === LANG.cur) return; LANG.cur = l; try { localStorage.setItem('lang', l); } catch {}
  jpost('/settings', { lang: l }).catch(() => {});   // Hintergrundjobs (Push, Digest, Statusseite) sprechen dann dieselbe Sprache
  applyNavLang(); const r = location.hash.slice(1) || 'heute'; (routes[r] || renderOverview)(); }

async function loadOverview() {
  STATE.overview = await api('/overview');
  $('#handle').textContent = STATE.overview.handle || '@you';
  $('#todoCnt').textContent = STATE.overview.openTodos ?? 0;
  renderLastPull();
}
// Tab-Leiste eines Bereichs (role=tablist; Pfeiltasten wechseln den Tab).
function tabBar(sec) {
  const tabs = SECTIONS[sec]; if (!tabs) return null;
  const bar = el('div', { class: 'tabbar', role: 'tablist', 'aria-label': t(NAVLABELS[sec] ? NAVLABELS[sec][LANG.cur === 'en' ? 1 : 0] : sec) });
  tabs.forEach(([r, label]) => {
    const on = r === CUR_ROUTE;
    const a = el('a', { class: 'tab' + (on ? ' on' : ''), role: 'tab', href: '#' + r, 'aria-selected': on ? 'true' : 'false', tabindex: on ? '0' : '-1' }, label);
    a.addEventListener('click', e => { e.preventDefault(); if (!on) go(r); });
    a.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault(); const i = tabs.findIndex(x => x[0] === r), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0];
      go(n);
    });
    bar.append(a);
  });
  return bar;
}
function pagehead(title, sub) {
  const v = $('#view'); v.innerHTML = '';
  v.append(el('div', { class: 'pagehead' }, el('h1', {}, title), sub ? el('p', { class: 'sub' }, sub) : null, tabBar(sectionOf(CUR_ROUTE))));
  const w = el('div', { class: 'wrap' }); v.append(w); return w;
}
