// MakerWorld Analytics — Frontend (helles, eckiges CRM). Vanilla JS + Chart.js
const $ = (s, r = document) => r.querySelector(s);
// ---- Sprache / i18n -------------------------------------------------------
// Quelle der Wahrheit im Code ist Deutsch; t() übersetzt zur Laufzeit ins
// Englische (Wörterbuch TR am Dateiende). Alle Texte laufen über el() -> t().
const LANG = { cur: (() => { try { return localStorage.getItem('lang') || 'de'; } catch { return 'de'; } })() };
const LOC = () => LANG.cur === 'en' ? 'en-US' : 'de-DE';
function t(s) {
  if (s == null || LANG.cur === 'de') return s;
  s = String(s); if (TR[s] != null) return TR[s];
  // Muster "Label (Zusatz)" -> Präfix (und ggf. Zähl-Wort im Zusatz) übersetzen.
  const m = s.match(/^(.+?) \((.*)\)$/);
  if (m && TR[m[1]] != null) {
    let inner = m[2]; const w = inner.match(/^([\d.,]+) (.+)$/);
    if (w && TR[w[2]] != null) inner = w[1] + ' ' + TR[w[2]];
    return TR[m[1]] + ' (' + inner + ')';
  }
  return s;
}
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(t(String(c))));
  return n;
};
const api = (p, opt) => fetch('/api' + p, opt).then(r => r.json());
const jpost = (p, body, m = 'POST') => api(p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fmt = n => n == null ? '–' : Number(n).toLocaleString(LOC());
const fmt1 = n => n == null ? '–' : Number(n).toLocaleString(LOC(), { maximumFractionDigits: 1 });
const eur = n => n == null ? '–' : Number(n).toLocaleString(LOC(), { style: 'currency', currency: 'EUR' });
const rate = () => STATE.overview?.settings?.eur_per_point || (40 / 524);
const nice = iso => iso ? new Date(iso).toLocaleString(LOC(), { dateStyle: 'short', timeStyle: 'short' }) : '–';
const today = () => new Date().toISOString().slice(0, 10);
const COLORS = ['#1f5c8f','#1a7f37','#b4620a','#c1332d','#6b4fa1','#0e7490','#a3357a','#4b5563','#2563eb','#059669','#d97706','#7c3aed'];

const METRICS = [['view','Views'],['impression','Impressions'],['download','Downloads'],['print','Drucke'],
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

// -------- Routing --------
const routes = { heute: renderHeute, overview: renderOverview, momentum: renderMomentum, compare: renderCompare,
  groups: renderGroups, points: renderPoints, report: renderReport,
  contacts: renderContacts, leads: renderLeads, projekte: renderProjekte, revenue: renderRevenue, teile: renderParts,
  pipeline: renderPipeline, selbst: renderSelfProjects, druckplan: renderDruckplan, material: renderMaterial,
  todos: renderTodos, events: renderEvents, data: renderData };
function go(route) {
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.route === route));
  location.hash = route;
  (routes[route] || renderOverview)();
}
document.querySelectorAll('nav a').forEach(a => a.addEventListener('click', () => go(a.dataset.route)));

// Navigations-Beschriftungen je Sprache (Zähler-Badge bleibt erhalten).
const NAVLABELS = {
  heute: ['Heute', 'Today'], overview: ['Übersicht', 'Overview'], momentum: ['Momentum', 'Momentum'],
  compare: ['Vergleich', 'Comparison'], groups: ['Kategorien', 'Categories'], points: ['Punkte', 'Points'],
  report: ['Bericht', 'Report'], contacts: ['Kunden', 'Customers'], leads: ['Leads', 'Leads'],
  projekte: ['Projekte', 'Projects'], revenue: ['Finanzen', 'Finance'], teile: ['Teile & Kalkulation', 'Parts & Costing'],
  pipeline: ['Produkte', 'Products'], selbst: ['Eigenprojekte', 'Own Projects'], druckplan: ['Druckplan', 'Print Queue'], material: ['Filament-Lager', 'Filament Stock'],
  todos: ['Aufgaben', 'Tasks'], data: ['Daten & Pull', 'Data & Sync']
};
function applyNavLang() {
  const i = LANG.cur === 'en' ? 1 : 0;
  document.querySelectorAll('nav a').forEach(a => { const lbl = NAVLABELS[a.dataset.route]; if (!lbl) return;
    const cnt = a.querySelector('.cnt'); a.textContent = lbl[i]; if (cnt) a.append(cnt); });
  document.querySelectorAll('.nav-sep').forEach(d => { d.dataset.de = d.dataset.de || d.textContent; d.textContent = t(d.dataset.de); });
  const gs = $('#globalSearch'); if (gs) { gs.dataset.de = gs.dataset.de || gs.placeholder; gs.placeholder = t(gs.dataset.de); }
  const pb = $('#pullBtn'); if (pb && !/(läuft|running)/i.test(pb.textContent)) pb.textContent = t('Live-Pull starten');
  document.querySelectorAll('#langSw a').forEach(a => a.classList.toggle('on', a.dataset.lang === LANG.cur));
  document.documentElement.lang = LANG.cur;
}
document.querySelectorAll('#langSw a').forEach(a => a.addEventListener('click', () => setLang(a.dataset.lang)));
function setLang(l) { if (l === LANG.cur) return; LANG.cur = l; try { localStorage.setItem('lang', l); } catch {}
  applyNavLang(); const r = location.hash.slice(1) || 'heute'; (routes[r] || renderOverview)(); }

async function loadOverview() {
  STATE.overview = await api('/overview');
  $('#handle').textContent = STATE.overview.handle || '@you';
  $('#todoCnt').textContent = STATE.overview.openTodos ?? 0;
  renderLastPull();
}
function pagehead(title, sub) {
  const v = $('#view'); v.innerHTML = '';
  v.append(el('div', { class: 'pagehead' }, el('h1', {}, title), sub ? el('p', { class: 'sub' }, sub) : null));
  const w = el('div', { class: 'wrap' }); v.append(w); return w;
}

// ============ ÜBERSICHT ============
let sortKey = 'download', sortDir = -1, searchTerm = '', statusFilter = '', segments = null;
const fcTile = (label, d30, d90) => el('div', { class: 'stat' }, el('div', { class: 'v' }, '+' + fmt(Math.round(d30))), el('div', { class: 'l' }, label + ' · +30 T'), el('div', { class: 'd muted' }, '+' + fmt(Math.round(d90)) + ' · +90 T'));
async function renderOverview() {
  if (!STATE.overview) await loadOverview();
  if (segments === null) segments = await api('/views').catch(() => []);
  const o = STATE.overview, t = o.totals, ac = o.account;
  const w = pagehead(`Übersicht`, `${o.count} Modelle · Datenstand ${nice(o.lastPull?.finished_at || o.lastPull?.started_at)}`);

  // Portfolio-Kopf (Konto-Ebene) — echter Punkte-Kontostand, Follower, Summen
  if (ac) {
    const pstrip = el('div', { class: 'stats', style: 'border-color:var(--accent)' },
      el('div', { class: 'stat' }, el('div', { class: 'v pos' }, fmt(ac.point) + ' P'), el('div', { class: 'l' }, 'Kontostand'), el('div', { class: 'd pos' }, '≈ ' + eur(ac.wallet_eur))),
      el('div', { class: 'stat' }, el('div', { class: 'v' }, t.voucher_eta_days != null ? '~' + t.voucher_eta_days + ' T' : '–'), el('div', { class: 'l' }, 'nächster 40€-Gutschein'), el('div', { class: 'd muted' }, 'noch ' + fmt(t.voucher_remaining) + ' P')),
      el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(ac.fan_count)), el('div', { class: 'l' }, 'Follower'), el('div', { class: 'd muted' }, 'folgt ' + fmt(ac.follow_count))),
      el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(ac.like_count)), el('div', { class: 'l' }, 'Likes gesamt')),
      el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(ac.collection_count)), el('div', { class: 'l' }, 'Sammlungen gesamt')),
      el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(ac.download_count)), el('div', { class: 'l' }, 'Downloads gesamt'), el('div', { class: 'd muted' }, `Modell ${fmt(ac.my_design_dl)} · Profil ${fmt(ac.my_instance_dl)}`)),
      el('div', { class: 'stat' }, el('div', { class: 'v' }, 'Lv ' + fmt(ac.level)), el('div', { class: 'l' }, 'MakerWorld-Level')));
    w.append(el('div', { style: 'font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim2);margin:0 0 4px' }, 'Konto · Portfolio'));
    w.append(pstrip);
  }

  const stats = [['view','Views'],['impression','Impressions'],['download','Downloads'],['print','Drucke'],
    ['collect','Gesammelt'],['like','Likes'],['point','Punkte'],['boost','Boost']];
  const strip = el('div', { class: 'stats' });
  stats.forEach(([k, l]) => strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(t[k] || 0)), el('div', { class: 'l' }, l))));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(t.dl30)), el('div', { class: 'l' }, 'DL · 30 T'),
    el('div', { class: 'd muted' }, fmt(t.v30) + ' Views/30T')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(t.pts30)), el('div', { class: 'l' }, 'Punkte · 30 T')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(t.earned)), el('div', { class: 'l' }, 'Verdient (Lifetime)'),
    el('div', { class: 'd muted' }, eur(t.earned30) + ' /30T')));
  w.append(strip);

  // Prognose (Trend-Regression über 90 Tage)
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Prognose (Trend, letzte 90 Tage)'),
    el('div', { class: 'bd' }, el('div', { class: 'stats', style: 'border:0;margin:0' },
      fcTile('Downloads', t.proj_dl30, t.proj_dl90), fcTile('Views', t.proj_v30, t.proj_v90), fcTile('Punkte', t.proj_pts30, t.proj_pts90),
      el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(t.proj_eur30)), el('div', { class: 'l' }, '€ · +30 T'), el('div', { class: 'd muted' }, eur(t.proj_eur90) + ' · +90 T')),
      el('div', { class: 'stat' }, el('div', { class: 'v' }, t.voucher_eta_days != null ? '~' + t.voucher_eta_days + ' T' : '–'), el('div', { class: 'l' }, 'nächster 40€-Gutschein'), el('div', { class: 'd muted' }, 'noch ' + fmt(t.voucher_remaining) + ' Punkte'))))));

  if (o.alerts && o.alerts.length) {
    const al = el('div', { class: 'alerts' });
    o.alerts.slice(0, 8).forEach(a => al.append(el('div', { class: 'alert', onclick: () => a.design_id && openModel(a.design_id) },
      el('span', { class: 'tag ' + a.type }, a.type), el('b', {}, a.title || 'Global'), el('span', { class: 'muted' }, '— ' + a.text))));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Alerts (${o.alerts.length})`), al));
  }

  const search = el('input', { class: 'search', placeholder: 'Modell suchen …', value: searchTerm,
    oninput: e => { searchTerm = e.target.value; draw(); } });
  const stFilter = el('select', {}, el('option', { value: '' }, 'alle Status'), STATUSES.map(([v, l]) => el('option', { value: v }, l)));
  stFilter.value = statusFilter; stFilter.onchange = () => { statusFilter = stFilter.value; draw(); };
  const segSel = el('select', {}, el('option', { value: '' }, 'Segment laden …'), (segments || []).map(s => el('option', { value: s.id }, s.name)));
  segSel.onchange = () => { const s = segments.find(x => x.id == segSel.value); if (s) applySegment(s.config); };
  const toolbar = el('div', { class: 'toolbar' }, search, el('label', {}, 'Status'), stFilter, segSel,
    el('button', { class: 'btn sm', onclick: saveSegment }, '＋ Segment'),
    el('button', { class: 'btn sm ghost', onclick: delSegment, title: 'gewähltes Segment löschen' }, ''),
    csvBtn('uebersicht.csv'), el('span', { class: 'muted', style: 'margin-left:auto' }, 'Klick = Details'));
  w.append(toolbar);
  const wrap = el('div', { class: 'tablewrap' }); w.append(wrap);

  const cols = [
    ['title','Modell','str'],['status','Status','status'],['publish_date','Release','str'],['impression','Impr','n'],['view','Views','n'],
    ['ctr_pct','CTR%','pct'],['download','DL','n'],['dl30','DL30','n'],['v_per_day','V/T','n'],['v_trend','Trend','trend'],
    ['spark','30T Views','spark'],['collect','Gesamm','n'],['like','Likes','n'],['comment_count','Komm','n'],
    ['point','Punkte','n'],['earned','Verdient','eur'],['boost','Boost','n'],['tag_count','Tags','n']];
  function applySegment(c) { searchTerm = c.search || ''; statusFilter = c.status || ''; sortKey = c.sortKey || 'download'; sortDir = c.sortDir || -1; search.value = searchTerm; stFilter.value = statusFilter; draw(); }
  async function saveSegment() { const name = prompt('Segment-Name:'); if (!name) return; const v = await jpost('/views', { name, config: { search: searchTerm, status: statusFilter, sortKey, sortDir } }); segments.push({ ...v, config: JSON.parse(v.config) }); segSel.append(el('option', { value: v.id }, v.name)); segSel.value = v.id; toast('Segment gespeichert.'); }
  async function delSegment() { const id = segSel.value; if (!id) return toast('Erst ein Segment wählen.'); await api('/views/' + id, { method: 'DELETE' }); segments = segments.filter(s => s.id != id); renderOverview(); }
  function draw() {
    let rows = o.models.filter(m => (!searchTerm || (m.title || '').toLowerCase().includes(searchTerm.toLowerCase())) && (!statusFilter || stOf(m) === statusFilter));
    rows.sort((a, b) => {
      let x = a[sortKey], y = b[sortKey];
      if (sortKey === 'title' || sortKey === 'publish_date') return sortDir * String(x || '').localeCompare(String(y || ''));
      return sortDir * (((x ?? -1)) - ((y ?? -1)));
    });
    const thead = el('tr', {}, cols.map(([k, l]) => el('th', { class: k === 'title' ? '' : 'n',
      onclick: () => { if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; } draw(); } },
      l + (sortKey === k ? (sortDir < 0 ? ' ▾' : ' ▴') : ''))));
    const tb = el('tbody', {}, rows.map(m => el('tr', { onclick: () => openModel(m.design_id) },
      cols.map(([k, , type]) => {
        if (type === 'status') return el('td', {}, statusBadge(stOf(m)));
        if (type === 'str') return el('td', { class: k === 'title' ? 'title' : '' }, k === 'title' ? (m.title || m.design_id) : (m[k] || '–'));
        if (type === 'pct') return el('td', { class: 'n' }, m[k] != null ? fmt1(m[k]) : '–');
        if (type === 'eur') return el('td', { class: 'n pos' }, eur(m[k]));
        if (type === 'trend') return trendCell(m.v_trend);
        if (type === 'spark') return el('td', { class: 'n' }, sparkline(m.spark));
        return el('td', { class: 'n' }, fmt(m[k]));
      }))));
    wrap.innerHTML = ''; wrap.append(el('table', {}, el('thead', {}, thead), tb));
  }
  draw();
}

// ============ MOMENTUM ============
async function renderMomentum() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Momentum', 'Was gerade läuft — 7/30-Tage-Aktivität, Trend gegenüber Vorwoche.');
  const models = [...STATE.overview.models].sort((a, b) => (b.v7 || 0) - (a.v7 || 0));
  w.append(el('div', { class: 'toolbar' }, csvBtn('momentum.csv')));
  const wrap = el('div', { class: 'tablewrap' }); w.append(wrap);
  const cols = [['Modell'],['V·7T'],['V·30T'],['V/Tag'],['Trend'],['DL·7T'],['DL·30T'],['DL/Tag'],['ΔDL Wo'],['30T Views'],['Punkte·30T']];
  const thead = el('tr', {}, cols.map(([l], i) => el('th', { class: i ? 'n' : '' }, l)));
  const tb = el('tbody', {}, models.map(m => el('tr', { onclick: () => openModel(m.design_id) },
    el('td', { class: 'title' }, m.title || m.design_id),
    el('td', { class: 'n' }, fmt(m.v7)), el('td', { class: 'n' }, fmt(m.v30)),
    el('td', { class: 'n' }, fmt1(m.v_per_day)), trendCell(m.v_trend),
    el('td', { class: 'n' }, fmt(m.dl7)), el('td', { class: 'n' }, fmt(m.dl30)),
    el('td', { class: 'n' }, fmt1(m.dl_per_day)), deltaCell(m.dl_delta),
    el('td', { class: 'n' }, sparkline(m.spark, 90, 16)), el('td', { class: 'n' }, fmt(m.pts30)))));
  wrap.append(el('table', {}, el('thead', {}, thead), tb));
}

// ============ VERGLEICH ============
let cmpSel = new Set(), cmpMetric = 'view', cmpGran = 'day', cmpMode = 'date', cmpCum = true, cmpChart = null, cmpView = 'models';
let grpSort = { key: 'download', dir: -1 };
async function renderCompare() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Vergleich', 'Modelle überlagern — nach Datum oder nach Alter seit Release.');
  const mk = (opts, val, on) => { const s = el('select', {}, opts.map(([v, l]) => el('option', { value: v }, l))); s.value = val; s.onchange = () => on(s.value); return s; };
  const metricSel = mk(METRICS, cmpMetric, v => { cmpMetric = v; drawCompare(); });
  const granSel = mk([['day','Tag'],['week','Woche'],['month','Monat']], cmpGran, v => { cmpGran = v; drawCompare(); });
  const modeSel = mk([['date','nach Datum'],['age','nach Alter']], cmpMode, v => { cmpMode = v; granSel.disabled = v === 'age'; drawCompare(); });
  const cumSel = mk([['1','kumuliert'],['0','pro Periode']], cmpCum ? '1' : '0', v => { cmpCum = v === '1'; drawCompare(); });
  const viewSel = mk([['models','Einzelmodelle'],['group','eigene Kategorie'],['category','MakerWorld-Kategorie'],['tag','Tag']], cmpView, v => { cmpView = v; renderCompare(); });
  granSel.disabled = cmpMode === 'age';
  w.append(el('div', { class: 'toolbar' }, el('label', {}, 'Ansicht'), viewSel, el('label', {}, 'Metrik'), metricSel,
    el('label', {}, 'Auflösung'), granSel, el('label', {}, 'Ausrichtung'), modeSel, cumSel,
    cmpView === 'models' ? el('button', { class: 'btn sm', onclick: () => { cmpSel = new Set(STATE.overview.models.slice(0, 6).map(m => m.design_id)); renderCompare(); } }, 'Top 6') : null,
    cmpView === 'models' ? el('button', { class: 'btn sm ghost', onclick: () => { cmpSel.clear(); renderCompare(); } }, 'Leeren') : null));
  const chartCard = el('div', { class: 'card' }, el('div', { class: 'bd' }, el('div', { class: 'chartbox' }, el('canvas', { id: 'cmpChart' }))));
  if (cmpView === 'models') {
    w.append(el('div', { class: 'grid-3-1' }, chartCard,
      el('div', { class: 'card', style: 'max-height:360px;overflow:auto' }, el('div', { class: 'hd' }, 'Modelle'),
        el('div', { class: 'bd' }, STATE.overview.models.map(m => {
          const cb = el('input', { type: 'checkbox' }); cb.checked = cmpSel.has(m.design_id);
          cb.onchange = () => { cb.checked ? cmpSel.add(m.design_id) : cmpSel.delete(m.design_id); drawCompare(); };
          return el('label', { class: 'checkline' }, cb, el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, m.title || m.design_id), el('span', { class: 'muted num' }, fmt(m[cmpMetric] ?? m.view)));
        })))));
  } else {
    w.append(chartCard);
    if (cmpView === 'group') w.append(el('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Eigene Kategorie pro Modell im Detail (unter „Ziele & Gruppe") oder unten in „Kategorien" zuordnen.'));
  }
  const tbl = el('div', { class: 'card' }); w.append(tbl); window.__cmpTbl = tbl;
  drawCompare();
}
async function drawCompare() {
  const grouped = cmpView !== 'models';
  const q = grouped
    ? `/timeseries?group=${cmpView === 'category' ? 'category' : cmpView === 'tag' ? 'tag' : 'group'}&metric=${cmpMetric}&granularity=${cmpGran}&mode=${cmpMode}&cumulative=${cmpCum ? 1 : 0}`
    : (cmpSel.size ? `/timeseries?ids=${[...cmpSel].join(',')}&metric=${cmpMetric}&granularity=${cmpGran}&mode=${cmpMode}&cumulative=${cmpCum ? 1 : 0}` : null);
  if (!q) { if (cmpChart) { cmpChart.destroy(); cmpChart = null; } if (window.__cmpTbl) window.__cmpTbl.innerHTML = '<div class="bd muted">Keine Modelle gewählt.</div>'; return; }
  const { series } = await api(q);
  if (cmpChart) cmpChart.destroy();
  let data, xScale;
  if (cmpMode === 'age') {
    data = { datasets: series.map((s, i) => ({ label: s.title, data: s.points.map(p => ({ x: p.x, y: p.y })), borderColor: COLORS[i % COLORS.length], backgroundColor: COLORS[i % COLORS.length], tension: .15, pointRadius: 0, borderWidth: 1.5 })) };
    xScale = { type: 'linear', title: { display: true, text: 'Tage seit Release', color: '#5b6169' }, ticks: { color: '#5b6169' }, grid: { color: '#e3e5e8' } };
  } else {
    data = alignSeries(series, cmpCum);
    xScale = { type: 'category', ticks: { color: '#5b6169', maxTicksLimit: 12 }, grid: { color: '#e3e5e8' } };
  }
  cmpChart = new Chart($('#cmpChart'), { type: 'line', data, options: { ...chartOpts(),
    scales: { x: xScale, y: { ticks: { color: '#5b6169' }, grid: { color: '#e3e5e8' } } } } });
  const tbl = window.__cmpTbl; tbl.innerHTML = '';
  if (grouped) {
    const by = cmpView === 'category' ? 'category' : cmpView === 'tag' ? 'tag' : 'group';
    const { rows } = await api('/analytics/groups?by=' + by);
    tbl.append(el('div', { class: 'hd' }, 'Kennzahlen je ' + (by === 'tag' ? 'Tag' : by === 'group' ? 'eigener Kategorie' : 'MakerWorld-Kategorie') + ' — Spaltenkopf sortiert'));
    const cols = [['key','Gruppe'],['count','#'],['view','Views'],['impression','Impr'],['ctr','CTR%'],['download','DL'],['dl30','DL30'],['collect','Gesamm'],['like','Likes'],['point','Punkte']];
    const wrap = el('div', { class: 'tablewrap' }); tbl.append(wrap);
    const draw = () => {
      const sorted = [...rows].sort((a, b) => {
        let x = a[grpSort.key], y = b[grpSort.key];
        if (grpSort.key === 'key') return grpSort.dir * String(x || '').localeCompare(String(y || ''), 'de');
        return grpSort.dir * (((x ?? -1)) - ((y ?? -1)));
      });
      wrap.innerHTML = '';
      wrap.append(el('table', {},
        el('thead', {}, el('tr', {}, cols.map(([k, l]) => el('th', { class: k === 'key' ? '' : 'n',
          onclick: () => { if (grpSort.key === k) grpSort.dir *= -1; else { grpSort.key = k; grpSort.dir = k === 'key' ? 1 : -1; } draw(); } },
          l + (grpSort.key === k ? (grpSort.dir < 0 ? ' ▾' : ' ▴') : ''))))),
        el('tbody', {}, sorted.map(r => el('tr', { onclick: () => openGroup(by, r.key) },
          cols.map(([k]) => k === 'key' ? el('td', { class: 'title' }, r.key)
            : el('td', { class: 'n' }, k === 'ctr' ? (r.ctr != null ? fmt1(r.ctr) : '–') : fmt(r[k]))))))));
    };
    draw();
    return;
  }
  tbl.append(el('div', { class: 'hd' }, 'Kennzahlen im Vergleich'));
  const chosen = STATE.overview.models.filter(m => cmpSel.has(m.design_id));
  const cols = [['title','Modell'],['publish_date','Release'],['view','Views'],['impression','Impr'],['ctr_pct','CTR%'],['download','DL'],['dl30','DL30'],['collect','Gesamm'],['like','Likes'],['point','Punkte'],['earned','Verdient']];
  tbl.append(el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, cols.map(([k, l]) => el('th', { class: k === 'title' ? '' : 'n' }, l)))),
    el('tbody', {}, chosen.map(m => el('tr', { onclick: () => openModel(m.design_id) },
      cols.map(([k]) => k === 'title' ? el('td', { class: 'title' }, m.title || m.design_id)
        : k === 'earned' ? el('td', { class: 'n pos' }, eur(m.earned))
        : el('td', { class: 'n' }, k === 'publish_date' ? (m.publish_date || '–') : k === 'ctr_pct' ? (m.ctr_pct != null ? fmt1(m.ctr_pct) : '–') : fmt(m[k])))))))));
}

// ============ KATEGORIEN ============
let grpBy = 'category';
async function renderGroups() {
  const w = pagehead('Kategorien & Gruppen', 'Aggregierte Leistung nach Kategorie, Tag oder eigener Gruppe.');
  const sel = el('select', {}, [['category','nach Kategorie'],['tag','nach Tag'],['group','nach eigener Gruppe']].map(([v, l]) => el('option', { value: v }, l)));
  sel.value = grpBy; sel.onchange = () => { grpBy = sel.value; renderGroups(); };
  w.append(el('div', { class: 'toolbar' }, el('label', {}, 'Gruppieren'), sel, csvBtn('kategorien.csv'),
    grpBy === 'group' ? el('span', { class: 'muted' }, 'Eigene Gruppe pro Modell im Detail unter „Ziele & Gruppe" setzen.') : null));
  const { rows } = await api('/analytics/groups?by=' + grpBy);
  w.append(el('p', { class: 'muted', style: 'margin:4px 0 8px' }, 'Klick auf eine Zeile → alle Produkte der Gruppe · Klick auf Spaltenkopf sortiert.'));
  const wrap = el('div', { class: 'tablewrap' }); w.append(wrap);
  const cols = [['key','Gruppe'],['count','#'],['view','Views'],['impression','Impr'],['ctr','CTR%'],['download','DL'],['dl30','DL30'],['print','Drucke'],['collect','Gesamm'],['like','Likes'],['point','Punkte'],['boost','Boost']];
  const draw = () => {
    const sorted = [...rows].sort((a, b) => {
      let x = a[grpSort.key], y = b[grpSort.key];
      if (grpSort.key === 'key') return grpSort.dir * String(x || '').localeCompare(String(y || ''), 'de');
      return grpSort.dir * (((x ?? -1)) - ((y ?? -1)));
    });
    wrap.innerHTML = '';
    wrap.append(el('table', {},
      el('thead', {}, el('tr', {}, cols.map(([k, l]) => el('th', { class: k === 'key' ? '' : 'n',
        onclick: () => { if (grpSort.key === k) grpSort.dir *= -1; else { grpSort.key = k; grpSort.dir = k === 'key' ? 1 : -1; } draw(); } },
        l + (grpSort.key === k ? (grpSort.dir < 0 ? ' ▾' : ' ▴') : ''))))),
      el('tbody', {}, sorted.map(r => el('tr', { onclick: () => openGroup(grpBy, r.key) },
        cols.map(([k]) => k === 'key' ? el('td', { class: 'title' }, r.key)
          : el('td', { class: 'n' }, k === 'ctr' ? (r.ctr != null ? fmt1(r.ctr) : '–') : fmt(r[k]))))))));
  };
  draw();

  // Schnell-Zuordner für eigene Kategorien
  if (grpBy === 'group') {
    const existing = [...new Set(STATE.overview.models.map(m => m.group_label).filter(Boolean))];
    const dl = el('datalist', { id: 'grouplist' }, existing.map(g => el('option', { value: g })));
    const list = el('div', {});
    STATE.overview.models.forEach(m => {
      const inp = el('input', { value: m.group_label || '', placeholder: '—', list: 'grouplist', style: 'width:160px' });
      inp.onchange = async () => { m.group_label = inp.value || null; await jpost('/model/' + m.design_id + '/group', { group_label: inp.value || null }, 'PUT'); toast('Kategorie gespeichert.'); };
      list.append(el('div', { class: 'checkline' }, el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, m.title || m.design_id), inp));
    });
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Eigene Kategorie je Produkt zuordnen'), el('div', { class: 'bd' }, dl, list)));
  }

  // Tag-Empfehlungen: welche Tags bringen im Schnitt mehr Reichweite
  const tp = await api('/analytics/tag-perf');
  const top = tp.tags.filter(t => t.models >= 1).slice(0, 15);
  const wrap2 = el('div', { class: 'tablewrap' });
  wrap2.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Tag'), el('th', { class: 'n' }, 'Modelle'), el('th', { class: 'n' }, 'Ø Views/Modell'), el('th', { class: 'n' }, 'Ø DL/Modell'), el('th', { class: 'n' }, 'Views gesamt'))),
    el('tbody', {}, top.map(t => el('tr', {}, el('td', { class: 'title' }, t.tag), el('td', { class: 'n' }, fmt(t.models)), el('td', { class: 'n' }, fmt(t.viewsPerModel)), el('td', { class: 'n' }, fmt1(t.dlPerModel)), el('td', { class: 'n muted' }, fmt(t.views)))))));
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Tag-Empfehlungen — was bei dir Reichweite bringt'),
    el('div', { class: 'bd muted', style: 'padding-bottom:0' }, 'Nach Ø Views pro Modell sortiert. Tags oben in der Liste lohnen sich für neue Uploads (sofern thematisch passend).'), wrap2));
}

// Drilldown: alle Produkte einer Gruppe/Kategorie/Tag
let groupChart = null;
async function openGroup(by, key) {
  const members = STATE.overview.models.filter(m => {
    if (by === 'tag') return (m.tags ? JSON.parse(m.tags) : []).includes(key);
    const v = by === 'group' ? m.group_label : m.category;
    return (v || '—') === key;
  });
  const inner = $('#drawer .drawer-inner'); inner.innerHTML = '';
  $('#drawer').classList.remove('hidden');
  const sum = k => members.reduce((s, m) => s + (m[k] || 0), 0);
  inner.append(el('div', { class: 'dh' }, el('div', { style: 'flex:1' },
    el('h1', {}, key), el('div', { class: 'muted' }, `${by === 'tag' ? 'Tag' : by === 'group' ? 'Eigene Kategorie' : 'MakerWorld-Kategorie'} · ${members.length} Produkte`)),
    el('span', { class: 'close', onclick: closeDrawer }, '✕')));
  const body = el('div', { class: 'dbody' }); inner.append(body);
  const strip = el('div', { class: 'stats' });
  [['view','Views'],['impression','Impr'],['download','DL'],['dl30','DL·30T'],['print','Drucke'],['collect','Gesammelt'],['like','Likes'],['point','Punkte']]
    .forEach(([k, l]) => strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(sum(k))), el('div', { class: 'l' }, l))));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(sum('earned'))), el('div', { class: 'l' }, 'Verdient')));
  body.append(strip);
  // Chart: Downloads kumuliert je Produkt
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Downloads kumuliert je Produkt'), el('div', { class: 'bd' }, el('div', { class: 'chartbox' }, el('canvas', { id: 'groupChart' })))));
  const { series } = await api(`/timeseries?ids=${members.map(m => m.design_id).join(',')}&metric=download&granularity=day&mode=date&cumulative=1`);
  if (groupChart) groupChart.destroy();
  groupChart = new Chart($('#groupChart'), { type: 'line', data: alignSeries(series, true), options: chartOpts() });
  // Produkt-Tabelle
  const cols = [['title','Produkt'],['view','Views'],['ctr_pct','CTR%'],['download','DL'],['dl30','DL30'],['collect','Gesamm'],['like','Likes'],['point','Punkte'],['earned','Verdient']];
  body.append(el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, cols.map(([k, l]) => el('th', { class: k === 'title' ? '' : 'n' }, l)))),
    el('tbody', {}, members.map(m => el('tr', { onclick: () => openModel(m.design_id) },
      cols.map(([k]) => k === 'title' ? el('td', { class: 'title' }, m.title)
        : k === 'earned' ? el('td', { class: 'n pos' }, eur(m.earned))
        : el('td', { class: 'n' }, k === 'ctr_pct' ? (m.ctr_pct != null ? fmt1(m.ctr_pct) : '–') : fmt(m[k])))))))));
}

// ============ PUNKTE ============
let ptsChart = null;
async function renderPoints() {
  const w = pagehead('Punkte-Ökonomie', 'Echter Kontostand, Punkte über die Zeit und je Modell. Punkte = Basis der Auszahlung.');
  const d = await api('/analytics/points');
  const acc = await api('/analytics/account').catch(() => ({ history: [], latest: null }));
  const ac = acc.latest;
  const strip = el('div', { class: 'stats' });
  if (ac) strip.append(
    el('div', { class: 'stat', style: 'border-right:2px solid var(--accent)' }, el('div', { class: 'v pos' }, fmt(ac.point) + ' P'), el('div', { class: 'l' }, 'Kontostand (Wallet)'), el('div', { class: 'd pos' }, '≈ ' + eur(ac.point * acc.rate))),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt1(ac.point_exclusive)), el('div', { class: 'l' }, 'davon Exklusiv'), el('div', { class: 'd muted' }, 'Regulär ' + fmt1(ac.point_regular))));
  strip.append(
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(d.totals.point)), el('div', { class: 'l' }, 'Punkte gesamt (Lifetime)')),
    el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(d.totals.earned)), el('div', { class: 'l' }, 'Verdient (Lifetime)')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(d.totals.pts30)), el('div', { class: 'l' }, 'Punkte · 30 T'), el('div', { class: 'd muted' }, eur(d.totals.earned30) + ' /30T')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(d.totals.boost)), el('div', { class: 'l' }, 'Boost gesamt')));
  w.append(strip);
  // Konto-Kontostand über Zeit (füllt sich mit jedem Pull)
  if (acc.history && acc.history.length > 1) {
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Kontostand (Punkte) über Zeit'), el('div', { class: 'bd' }, el('div', { class: 'chartbox', style: 'height:180px' }, el('canvas', { id: 'accChart' })))));
    if (window.__accChart) window.__accChart.destroy();
    window.__accChart = new Chart($('#accChart'), { type: 'line', data: { labels: acc.history.map(h => (h.captured_at || '').slice(0, 10)), datasets: [{ label: 'Kontostand (P)', data: acc.history.map(h => h.point), borderColor: COLORS[0], backgroundColor: 'rgba(31,92,143,.12)', fill: true, tension: .2, pointRadius: 2, borderWidth: 1.5 }] }, options: chartOpts() });
  } else if (ac) {
    w.append(el('p', { class: 'muted', style: 'margin:0 0 12px' }, 'Kontostand-Verlauf baut sich mit jedem täglichen Pull auf.'));
  }
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Punkte kumuliert'), el('div', { class: 'bd' }, el('div', { class: 'chartbox' }, el('canvas', { id: 'ptsChart' })))));
  if (ptsChart) ptsChart.destroy();
  ptsChart = new Chart($('#ptsChart'), { type: 'line', data: { datasets: [{ label: 'Punkte kumuliert', data: d.series.map(p => ({ x: p.x, y: p.y })), borderColor: COLORS[1], backgroundColor: 'rgba(26,127,55,.12)', fill: true, tension: .15, pointRadius: 0, borderWidth: 1.5 }] }, options: chartOpts() });
  w.append(el('div', { class: 'toolbar' }, csvBtn('punkte.csv')));
  const wrap = el('div', { class: 'tablewrap' }); w.append(wrap);
  wrap.append(el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, 'Modell'), el('th', { class: 'n' }, 'Punkte'), el('th', { class: 'n' }, 'Verdient'), el('th', { class: 'n' }, 'Punkte·30T'), el('th', { class: 'n' }, '€·30T'), el('th', { class: 'n' }, 'Boost'))),
    el('tbody', {}, d.perModel.map(m => el('tr', { onclick: () => openModel(m.design_id) },
      el('td', { class: 'title' }, m.title), el('td', { class: 'n' }, fmt(m.point)), el('td', { class: 'n pos' }, eur(m.earned)), el('td', { class: 'n' }, fmt(m.pts30)), el('td', { class: 'n' }, eur(m.earned30)), el('td', { class: 'n' }, fmt(m.boost)))))));

  // ===== Punkte-Matrix (Reverse Engineering) =====
  const pm = await api('/analytics/points-matrix').catch(() => null);
  if (pm && pm.shares && pm.shares.total > 0) {
    const sh = pm.shares; const pctOf = v => sh.total ? Math.round((v / sh.total) * 100) : 0;
    const stat = (v, l, cls, dd) => el('div', { class: 'stat' }, el('div', { class: 'v ' + (cls || '') }, v), el('div', { class: 'l' }, l), dd ? el('div', { class: 'd muted' }, dd) : null);
    w.append(el('div', { class: 'pagehead', style: 'padding:12px 0;border:0;margin-top:10px' }, el('h1', { style: 'font-size:15px' }, 'Punkte-Matrix (Reverse Engineering)')));
    w.append(el('div', { class: 'stats' },
      stat(fmt1(pm.perDownload), 'Punkte / Download', 'pos', pm.fit.downloadCorr != null ? 'Korrelation ' + pm.fit.downloadCorr : 'zu wenig Daten'),
      stat(fmt1(pm.perPrint), 'Punkte / Druck', 'pos', pm.fit.printCorr != null ? 'Korrelation ' + pm.fit.printCorr : 'zu wenig Daten'),
      stat(fmt(pm.predTotal), 'Prognose Punkte · 30 T', '', eur(pm.predTotalEur) + ' bei gleicher Aktivität'),
      stat(fmt(pm.fit.samples), 'Datenpunkte (Tage)', 'muted', 'wird mit jedem Pull genauer')));
    // Herkunft der Punkte (MakerWorlds eigene Kategorisierung = Basis der "Matrix")
    const bar = (label, val) => el('div', { class: 'checkline' }, el('span', { style: 'flex:1' }, label),
      el('div', { class: 'goalbar', style: 'width:160px' }, el('i', { style: `width:${pctOf(val)}%` }), el('span', {}, pctOf(val) + '%')),
      el('span', { class: 'num muted', style: 'font-size:11px' }, fmt(val) + ' P'));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Herkunft der Punkte (Lifetime)'),
      el('div', { class: 'bd muted', style: 'padding-bottom:0' }, 'MakerWorlds eigene Aufteilung — daraus + der Rate je Download/Druck lässt sich das Punktesystem annähern. Die Rate wird mit jedem täglichen Pull genauer (aktuell ' + fmt(pm.fit.samples) + ' Tagesdatenpunkte).'),
      el('div', { class: 'bd' }, bar('Modell (Downloads)', sh.model), bar('Druckprofil (Drucke)', sh.inst), bar('Bewertungen', sh.ratings), bar('Sonstige', sh.others))));
    if (pm.byModel && pm.byModel.length) {
      const wrap2 = el('div', { class: 'tablewrap' });
      wrap2.append(el('table', {}, el('thead', {}, el('tr', {},
        el('th', {}, 'Modell'), el('th', { class: 'n' }, 'Punkte-Tage'), el('th', { class: 'n' }, 'Ø Abstand'),
        el('th', { class: 'n' }, 'letzter'), el('th', { class: 'n' }, 'Tage her'), el('th', { class: 'n' }, 'Prognose 30 T'))),
        el('tbody', {}, pm.byModel.map(m => el('tr', { onclick: () => openModel(m.design_id) },
          el('td', { class: 'title' }, m.title),
          el('td', { class: 'n' }, fmt(m.events)),
          el('td', { class: 'n' }, m.avgGap != null ? fmt1(m.avgGap) + ' T' : '–'),
          el('td', { class: 'n muted' }, m.lastDate || '–'),
          el('td', { class: 'n ' + ((m.daysSince ?? 0) > (m.avgGap ?? 1e9) ? 'neg' : 'muted') }, m.daysSince != null ? m.daysSince : '–'),
          el('td', { class: 'n pos' }, '+' + fmt(m.pred30)))))));
      w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Punkte-Timing & Prognose je Modell', el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, '„Tage her" rot = überfällig ggü. Ø-Abstand')), wrap2));
    }
  }
}

// ============ BERICHT (Wochenrückblick) ============
async function renderReport() {
  if (!STATE.overview) await loadOverview();
  const o = STATE.overview, models = o.models, t = o.totals;
  const w = pagehead('Bericht', 'Wochenrückblick — Bewegung der letzten 7 Tage, Prognose und offene Punkte.');
  w.append(el('div', { class: 'toolbar' }, el('button', { class: 'btn sm', onclick: () => window.print() }, 'Drucken / PDF')));

  const dl7 = models.reduce((s, m) => s + (m.dl7 || 0), 0);
  const v7 = models.reduce((s, m) => s + (m.v7 || 0), 0);
  w.append(el('div', { class: 'stats' },
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(dl7)), el('div', { class: 'l' }, 'Downloads · 7 T')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(v7)), el('div', { class: 'l' }, 'Views · 7 T')),
    el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(t.earned30)), el('div', { class: 'l' }, 'Verdient · 30 T')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(o.openTodos)), el('div', { class: 'l' }, 'offene Todos')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, t.voucher_eta_days != null ? '~' + t.voucher_eta_days + ' T' : '–'), el('div', { class: 'l' }, 'nächster 40€-Gutschein'), el('div', { class: 'd muted' }, 'noch ' + fmt(t.voucher_remaining) + ' Punkte'))));

  const miniTable = (title, rows, valFn, cls) => {
    const c = el('div', { class: 'card' }, el('div', { class: 'hd' }, title));
    const tb = el('table', {}, el('tbody', {}, rows.length ? rows.map(m => el('tr', { onclick: () => openModel(m.design_id) },
      el('td', { class: 'title' }, m.title || m.design_id), el('td', { class: 'n ' + (cls || '') }, valFn(m)))) : [el('tr', {}, el('td', { class: 'muted' }, 'nichts'))]));
    c.append(el('div', { class: 'tablewrap' }, tb)); return c;
  };
  const gainers = models.filter(m => (m.dl_delta || 0) > 0).sort((a, b) => b.dl_delta - a.dl_delta).slice(0, 5);
  const coolers = models.filter(m => m.v_trend != null && m.v_trend < 0).sort((a, b) => a.v_trend - b.v_trend).slice(0, 5);
  const risers = models.filter(m => m.v_trend != null && m.v_trend > 0).sort((a, b) => b.v_trend - a.v_trend).slice(0, 5);
  w.append(el('div', { class: 'grid2' },
    miniTable('Top Downloads-Zuwachs (Woche vs. Vorwoche)', gainers, m => (m.dl_delta > 0 ? '+' : '') + fmt1(m.dl_delta) + ' DL', 'pos'),
    miniTable('Größte Abkühlung (Views-Trend)', coolers, m => m.v_trend + '%', 'neg')));
  w.append(el('div', { class: 'grid2' },
    miniTable('Heißeste Aufsteiger (Views-Trend)', risers, m => '+' + m.v_trend + '%', 'pos'),
    miniTable('Prognose Downloads · nächste 30 T', [...models].sort((a, b) => (b.proj_dl30 || 0) - (a.proj_dl30 || 0)).slice(0, 5), m => '+' + fmt(m.proj_dl30))));

  // Änderungswirkung aggregiert: was bringen Titelbild-/Titel-/Tag-/Beschreibung-Änderungen im Schnitt?
  const ci = await api('/analytics/change-impact').catch(() => ({ rows: [] }));
  if (ci.rows && ci.rows.length) {
    const wrap = el('div', { class: 'tablewrap' });
    wrap.append(el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Änderungstyp'), el('th', { class: 'n' }, 'Anzahl'), el('th', { class: 'n' }, 'Ø CTR-Δ'),
      el('th', { class: 'n' }, 'Trefferquote'), el('th', { class: 'n' }, 'Downloads v→n'))),
      el('tbody', {}, ci.rows.map(r => el('tr', {},
        el('td', { class: 'title' }, r.label),
        el('td', { class: 'n' }, fmt(r.count)),
        r.avgCtrDelta == null ? el('td', { class: 'n muted' }, '–') : el('td', { class: 'n ' + (r.avgCtrDelta > 0 ? 'pos' : r.avgCtrDelta < 0 ? 'neg' : '') }, (r.avgCtrDelta > 0 ? '+' : '') + fmt1(r.avgCtrDelta) + '%'),
        el('td', { class: 'n ' + (r.winRate >= 50 ? 'pos' : r.winRate != null ? 'neg' : 'muted') }, r.winRate != null ? r.winRate + '%' : '–'),
        el('td', { class: 'n muted' }, r.dlChangePct != null ? (r.dlChangePct > 0 ? '+' : '') + r.dlChangePct + '%' : '–'))))));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Wirkung von Änderungen (aggregiert, ±' + ci.win + ' Tage)', el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, ci.measured + ' von ' + ci.totalEvents + ' auswertbar')),
      el('div', { class: 'bd muted', style: 'padding-bottom:0' }, 'Über alle Modelle: durchschnittliche CTR-Veränderung vor/nach einer Änderung + Anteil der Änderungen, die die CTR verbessert haben („Trefferquote"). Zeigt, welcher Hebel wirklich zieht.'), wrap));
  }

  // Alerts + letzte Änderungen
  if (o.alerts && o.alerts.length) {
    const al = el('div', { class: 'alerts' });
    o.alerts.forEach(a => al.append(el('div', { class: 'alert', onclick: () => a.design_id && openModel(a.design_id) },
      el('span', { class: 'tag ' + a.type }, a.type), el('b', {}, a.title || 'Global'), el('span', { class: 'muted' }, '— ' + a.text))));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Alerts (${o.alerts.length})`), al));
  }
  const evs = await api('/events');
  const byId = Object.fromEntries(models.map(m => [m.design_id, m.title]));
  const recent = evs.slice(0, 12);
  const list = el('ul', { class: 'timeline' });
  if (!recent.length) list.append(el('li', { class: 'muted' }, 'keine Einträge'));
  recent.forEach(ev => list.append(el('li', {}, el('span', { class: 'date' }, ev.date), el('span', { class: 'pill' }, ev.type || 'other'),
    el('div', { style: 'flex:1' }, el('b', {}, ev.title || ''), el('div', { class: 'muted' }, (ev.design_id ? (byId[ev.design_id] || ev.design_id) : 'Global') + (ev.note ? ' — ' + ev.note : ''))))));
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Letzte Änderungen'), el('div', { class: 'bd' }, list)));
}

// ============ TODOS (global) ============
let todoFilter = '0';
async function renderTodos() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Aufgaben', 'Aufgaben je Modell und global — zentral gebündelt.');
  const models = STATE.overview.models;
  const titleI = el('input', { placeholder: 'Neue Aufgabe …', style: 'flex:1;min-width:200px' });
  const modelSel = el('select', {}, el('option', { value: '' }, '— global —'), models.map(m => el('option', { value: m.design_id }, m.title || m.design_id)));
  const prioSel = el('select', {}, [['1','normal'],['2','hoch'],['0','niedrig']].map(([v, l]) => el('option', { value: v }, l)));
  const dueI = el('input', { type: 'date' });
  const add = async () => {
    if (!titleI.value.trim()) return;
    await jpost('/todos', { design_id: modelSel.value || null, title: titleI.value.trim(), priority: +prioSel.value, due_date: dueI.value || null });
    titleI.value = ''; dueI.value = ''; await loadOverview(); renderTodos();
  };
  titleI.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  const filt = el('select', {}, [['0','offen'],['1','erledigt'],['all','alle']].map(([v, l]) => el('option', { value: v }, l)));
  filt.value = todoFilter; filt.onchange = () => { todoFilter = filt.value; renderTodos(); };
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Neue Aufgabe'),
    el('div', { class: 'bd row' }, titleI, modelSel, prioSel, dueI, el('button', { class: 'btn primary sm', onclick: add }, '+ Hinzufügen'))));
  w.append(el('div', { class: 'toolbar' }, el('label', {}, 'Filter'), filt));

  const q = todoFilter === 'all' ? '' : '?done=' + todoFilter;
  const todos = await api('/todos' + q);
  const list = el('ul', { class: 'todolist' });
  if (!todos.length) list.append(el('li', { class: 'muted' }, 'Keine Aufgaben.'));
  todos.forEach(tdo => list.append(todoRow(tdo, () => renderTodos())));
  w.append(el('div', { class: 'card' }, el('div', { class: 'bd' }, list)));
}
function todoRow(t, after) {
  const cb = el('input', { type: 'checkbox' }); cb.checked = !!t.done;
  cb.onchange = async () => { await jpost('/todos/' + t.id, { done: cb.checked }, 'PUT'); await loadOverview(); after && after(); };
  const overdue = t.due_date && !t.done && t.due_date < today();
  const link = t.contact_name ? el('span', { class: 'pill', onclick: () => openContact(t.contact_id) }, '' + t.contact_name + (t.project_title ? ' · ' + t.project_title : ''))
    : t.model_title ? el('span', { class: 'pill', onclick: () => openModel(t.design_id) }, t.model_title)
    : el('span', { class: 'pill' }, 'global');
  return el('li', { class: 'todo' + (t.done ? ' done' : '') },
    el('span', { class: 'prio p' + (t.priority ?? 1) }), cb,
    el('span', { class: 't' }, t.title), link,
    t.due_date ? el('span', { class: 'due' + (overdue ? ' over' : '') }, t.due_date) : null,
    el('button', { class: 'btn sm ghost', onclick: async () => { await api('/todos/' + t.id, { method: 'DELETE' }); await loadOverview(); after && after(); } }, '✕'));
}

// ---- Drag & Drop für Kanban-Boards (Alternative zum Dropdown) ------------
let _drag = null;
function dndCard(card, id, allow) {   // allow = erlaubte Zielspalten (sonst alle)
  card.setAttribute('draggable', 'true');
  card.addEventListener('dragstart', e => { _drag = { id, allow }; e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(id)); } catch {} setTimeout(() => card.classList.add('dragging'), 0); });
  card.addEventListener('dragend', () => { card.classList.remove('dragging');
    document.querySelectorAll('.col.dragover').forEach(c => c.classList.remove('dragover')); _drag = null; });
}
function dndColumn(col, stage, onDrop) {
  const ok = () => _drag && (!_drag.allow || _drag.allow.includes(stage));
  col.addEventListener('dragover', e => { if (!ok()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('dragover'); });
  col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('dragover'); });
  col.addEventListener('drop', async e => { e.preventDefault(); col.classList.remove('dragover');
    const d = _drag; _drag = null; if (!d || (d.allow && !d.allow.includes(stage))) return; await onDrop(d.id, stage); });
}

// Stufen-Pfad (Chevron-Leiste à la Salesforce Path). stages=[[key,label]], onSelect(key).
function stagePath(stages, curKey, onSelect) {
  const order = stages.map(s => s[0]); const ci = order.indexOf(curKey);
  const bar = el('div', { class: 'pathbar' });
  stages.forEach(([v, l], i) => {
    const state = i < ci ? 'done' : i === ci ? 'cur' : 'todo';
    bar.append(el('div', { class: 'pathseg ' + state, title: l, onclick: () => onSelect(v) },
      i < ci ? el('span', { class: 'pmark' }, '✓') : null, el('span', {}, l)));
  });
  return bar;
}

// ============ PIPELINE (Kanban) ============
async function renderPipeline() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Pipeline', 'Von der Idee bis Archiviert. Geplante Produkte werden beim Pull automatisch mit dem echten Modell verschmolzen (Titel-Abgleich).');
  w.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary sm', onclick: planProduct }, '＋ Produkt planen'),
    el('span', { class: 'muted' }, 'Neue Idee anlegen — Titel exakt wie später auf MakerWorld, dann verschmilzt der Pull automatisch.')));
  const all = [...STATE.overview.models, ...(STATE.overview.planned || [])];
  const board = el('div', { class: 'board' });
  STATUSES.forEach(([sv, sl]) => {
    const members = all.filter(m => stOf(m) === sv).sort((a, b) => (b.download || 0) - (a.download || 0));
    const col = el('div', { class: 'col' }, el('div', { class: 'colhd', style: `border-top:3px solid ${STATUS_COLOR[sv]}` }, sl, el('span', { class: 'cnt' }, members.length)));
    dndColumn(col, sv, async (id, stage) => { const mm = all.find(x => x.design_id === id); if (mm) mm.status = stage;
      await jpost('/model/' + id + '/status', { status: stage }, 'PUT'); renderPipeline(); });
    members.forEach(m => {
      const planned = !!m.planned;
      const sel = el('select', { class: 'sm', onclick: e => e.stopPropagation() }, STATUSES.map(([v, l]) => el('option', { value: v }, l)));
      sel.value = sv;
      sel.onchange = async e => { e.stopPropagation(); m.status = sel.value; await jpost('/model/' + m.design_id + '/status', { status: sel.value }, 'PUT'); renderPipeline(); };
      const card = el('div', { class: 'kcard', onclick: () => planned ? openPlanned(m.design_id) : openModel(m.design_id) },
        el('div', { class: 'kt' }, planned ? el('span', { class: 'tag', style: 'background:#6b7280;margin-right:5px' }, 'GEPLANT') : null, m.title || m.design_id),
        planned ? el('div', { class: 'muted', style: 'font-size:11px' }, m.group_label ? 'Kategorie: ' + m.group_label : 'zum Planen anklicken')
          : el('div', { class: 'muted num', style: 'font-size:11px' }, `${fmt(m.download)} DL · ${fmt(m.view)} V · ${eur(m.earned)}`),
        sel);
      dndCard(card, m.design_id);   // alle Stufen erlaubt (auch geplante -> Live)
      col.append(card);
    });
    if (!members.length) col.append(el('div', { class: 'muted', style: 'padding:8px' }, '—'));
    board.append(col);
  });
  w.append(board);
}
async function planProduct() {
  const title = prompt('Titel des geplanten Produkts (möglichst exakt wie später auf MakerWorld):');
  if (!title || !title.trim()) return;
  await jpost('/products/plan', { title: title.trim(), status: 'idee' });
  await loadOverview(); renderPipeline(); toast('Geplant: ' + title.trim());
}

// Editor für ein GEPLANTES Produkt: Titel, Beschreibung, Tags, Notizen, Todos, Kategorie.
async function openPlanned(id) {
  const d = await api('/model/' + id);
  const m = d.model;
  const inner = $('#drawer .drawer-inner'); inner.innerHTML = '';
  $('#drawer').classList.remove('hidden');
  const debounce = (fn, ms = 600) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };

  const titleI = el('input', { value: m.title || '', style: 'font-size:14px;font-weight:600;flex:1;min-width:220px' });
  const statusSel = el('select', {}, [['idee','Idee'],['arbeit','In Arbeit']].map(([v, l]) => el('option', { value: v }, l)));
  statusSel.value = ['idee','arbeit'].includes(stOf(m)) ? stOf(m) : 'idee';
  statusSel.onchange = async () => { await jpost('/model/' + id + '/status', { status: statusSel.value }, 'PUT'); loadOverview(); };
  inner.append(el('div', { class: 'dh' },
    el('div', { style: 'flex:1' }, el('div', { class: 'row', style: 'margin:0 0 4px' }, el('span', { class: 'tag', style: 'background:#6b7280' }, 'GEPLANT'), titleI),
      el('div', { class: 'muted' }, 'Wird beim Pull automatisch mit dem echten Modell verschmolzen, sobald der Titel übereinstimmt.')),
    el('div', { class: 'row', style: 'margin:0;align-items:center' }, el('label', {}, 'Status'), statusSel),
    el('span', { class: 'close', onclick: closeDrawer }, '✕')));
  const body = el('div', { class: 'dbody' }); inner.append(body);

  // Beschreibung + Tags (autosave via meta)
  const descTa = el('textarea', { style: 'width:100%;height:140px', placeholder: 'Beschreibung entwerfen …' }, m.description || '');
  const tagsI = el('input', { style: 'width:100%', placeholder: 'Tags, mit Komma getrennt (z.B. bierdeckel, bundesliga, geschenk)', value: (Array.isArray(m.tags) ? m.tags : []).join(', ') });
  const tagsPrev = el('div', { class: 'tags' });
  const metaHd = el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, 'autospeichern');
  const drawTagPrev = () => { tagsPrev.innerHTML = ''; tagsI.value.split(',').map(t => t.trim()).filter(Boolean).forEach(t => tagsPrev.append(el('span', { class: 'pill' }, t))); };
  const saveMeta = debounce(async () => { await jpost('/model/' + id + '/meta', { title: titleI.value, description: descTa.value, tags: tagsI.value }, 'PUT'); loadOverview(); flash(metaHd); });
  titleI.addEventListener('input', saveMeta); descTa.addEventListener('input', saveMeta);
  tagsI.addEventListener('input', () => { drawTagPrev(); saveMeta(); }); drawTagPrev();
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Beschreibung (Entwurf)', metaHd), el('div', { class: 'bd' }, descTa)));
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Tags (Entwurf)'), el('div', { class: 'bd' }, tagsI, tagsPrev)));

  // Notizen
  const notesTa = el('textarea', { style: 'width:100%;height:110px', placeholder: 'Notizen …' }, m.notes || '');
  const noteHd = el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, 'autospeichern');
  notesTa.addEventListener('input', debounce(() => jpost('/model/' + id + '/notes', { notes: notesTa.value }, 'PUT').then(() => flash(noteHd))));
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Notizen', noteHd), el('div', { class: 'bd' }, notesTa)));

  // Kategorie
  const grpI = el('input', { value: m.group_label || '', placeholder: 'z.B. Bierdeckel', style: 'width:180px' });
  grpI.addEventListener('change', () => jpost('/model/' + id + '/group', { group_label: grpI.value || null }, 'PUT').then(() => { loadOverview(); toast('Kategorie gespeichert.'); }));
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Kategorie'), el('div', { class: 'bd row' }, el('label', {}, 'Gruppe'), grpI)));

  // Todos
  const tl = el('ul', { class: 'todolist' });
  const drawTodos = todos => { tl.innerHTML = ''; if (!todos.length) tl.append(el('li', { class: 'muted' }, 'Keine Aufgaben.'));
    todos.forEach(tdo => tl.append(todoRow(tdo, async () => { const nd = await api('/model/' + id); drawTodos(nd.todos); }))); };
  const tIn = el('input', { placeholder: 'Aufgabe …', style: 'flex:1' });
  const tPrio = el('select', {}, [['1','normal'],['2','hoch'],['0','niedrig']].map(([v, l]) => el('option', { value: v }, l)));
  const tDue = el('input', { type: 'date' });
  const addTodo = async () => { if (!tIn.value.trim()) return; await jpost('/todos', { design_id: id, title: tIn.value.trim(), priority: +tPrio.value, due_date: tDue.value || null }); tIn.value = ''; tDue.value = ''; const nd = await api('/model/' + id); drawTodos(nd.todos); loadOverview(); };
  tIn.addEventListener('keydown', e => { if (e.key === 'Enter') addTodo(); });
  drawTodos(d.todos || []);
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Todos'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, tIn, tPrio, tDue, el('button', { class: 'btn primary sm', onclick: addTodo }, '+')), tl)));

  body.append(el('div', { class: 'card' }, el('div', { class: 'bd' },
    el('button', { class: 'btn ghost sm', onclick: async () => { if (!confirm('Geplantes Produkt löschen?')) return; await api('/products/' + id, { method: 'DELETE' }); closeDrawer(); await loadOverview(); renderPipeline(); } }, 'Geplantes Produkt löschen'))));
}

// ============ ÄNDERUNGEN ============
async function renderEvents() {
  if (!STATE.overview) await loadOverview();
  const evs = await api('/events');
  const byId = Object.fromEntries(STATE.overview.models.map(m => [m.design_id, m.title]));
  const w = pagehead('Änderungs-Historie', 'Alle erfassten Upload-Änderungen chronologisch. Einträge pro Modell im Detail.');
  const list = el('ul', { class: 'timeline' });
  if (!evs.length) list.append(el('li', { class: 'muted' }, 'Noch keine Einträge — im Modell-Detail eintragen.'));
  evs.forEach(ev => list.append(el('li', {},
    el('span', { class: 'date' }, ev.date), el('span', { class: 'pill' }, ev.type || 'other'),
    el('div', { style: 'flex:1' }, el('b', {}, ev.title || '(ohne Titel)'), el('div', { class: 'muted' }, (ev.design_id ? (byId[ev.design_id] || ev.design_id) : 'Global') + (ev.note ? ' — ' + ev.note : ''))),
    ev.design_id ? el('a', { onclick: () => openModel(ev.design_id) }, 'öffnen') : null)));
  w.append(el('div', { class: 'card' }, el('div', { class: 'bd' }, list)));
}

// ============ MODELL-DETAIL (Drawer) ============
let detailChart = null;
async function openModel(id) {
  const d = await api('/model/' + id);
  const m = d.model, snap = d.snaps[d.snaps.length - 1] || {};
  const inner = $('#drawer .drawer-inner'); inner.innerHTML = '';
  $('#drawer').classList.remove('hidden');
  const cover = m.cover_image ? '/data/' + m.cover_image : (m.cover_url || '');

  const statusSel = el('select', {}, STATUSES.map(([v, l]) => el('option', { value: v }, l)));
  statusSel.value = stOf(m);
  statusSel.onchange = async () => { m.status = statusSel.value; await jpost('/model/' + id + '/status', { status: statusSel.value }, 'PUT'); const mm = STATE.overview?.models.find(x => x.design_id === id); if (mm) mm.status = statusSel.value; toast('Status: ' + statusLabel(statusSel.value)); };
  inner.append(el('div', { class: 'dh' },
    cover ? el('img', { src: cover, onerror: e => e.target.remove() }) : null,
    el('div', { style: 'flex:1' }, el('h1', {}, m.title || id),
      el('div', { class: 'muted' }, `${m.publish_date ? 'Release ' + m.publish_date + ' · ' : ''}${m.mw_update_time ? 'zuletzt bearbeitet ' + m.mw_update_time.slice(0, 10) + ' · ' : ''}ID ${id} · ${m.category || '—'} · `,
        el('a', { href: m.url || `https://makerworld.com/en/models/${id}`, target: '_blank' }, 'MakerWorld ↗')),
      el('div', { class: 'tags' }, (m.tags || []).map(tt => el('span', { class: 'pill' }, tt)))),
    el('div', { class: 'row', style: 'margin:0;align-items:center' }, el('label', {}, 'Status'), statusSel),
    el('span', { class: 'close', onclick: closeDrawer }, '✕')));

  const body = el('div', { class: 'dbody' }); inner.append(body);

  // KPI-Strip
  const kp = [['view','Views'],['impression','Impr'],['download','DL'],['print','Drucke'],['collect','Gesammelt'],['like','Likes'],['point','Punkte'],['boost','Boost']];
  const strip = el('div', { class: 'stats' });
  kp.forEach(([k, l]) => strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(snap[k])), el('div', { class: 'l' }, l))));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur((snap.point || 0) * rate())), el('div', { class: 'l' }, 'Verdient (Lifetime)')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, snap.ctr_pct != null ? fmt1(snap.ctr_pct) + '%' : '–'), el('div', { class: 'l' }, 'CTR')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(snap.comment_count)), el('div', { class: 'l' }, 'Kommentare')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(m.dl30)), el('div', { class: 'l' }, 'DL · 30T'), el('div', { class: 'd ' + (m.v_trend > 0 ? 'pos' : m.v_trend < 0 ? 'neg' : 'muted') }, m.v_trend != null ? (m.v_trend > 0 ? '+' : '') + m.v_trend + '% Views' : '')));
  body.append(strip);

  // Chart — mehrere Kennwerte gleichzeitig (Chips zum An-/Abwählen), Auto-Doppelachse.
  const METRIC_COLOR = { view: '#1f5c8f', impression: '#6b7280', download: '#1a7f37', print: '#b4620a', collect: '#a3357a', like: '#c1332d', follower: '#0e7490', boost: '#7c3aed', points: '#d97706' };
  const selected = new Set(['view']);
  const cumSel = el('select', {}, el('option', { value: '0' }, 'täglich'), el('option', { value: '1' }, 'kumuliert'));
  const chips = el('div', { class: 'metricchips' });
  const seriesFor = metric => d.daily.map(r => metric === 'points' ? (r.point_from_model + r.point_from_inst + r.point_from_ratings + r.point_from_others) : (r[metric] || 0));
  METRICS.forEach(([v, l]) => {
    const chip = el('button', { class: 'chip', style: `--c:${METRIC_COLOR[v]}` }, el('span', { class: 'dot', style: `background:${METRIC_COLOR[v]}` }), l);
    const sync = () => chip.classList.toggle('on', selected.has(v));
    chip.onclick = () => { if (selected.has(v)) { if (selected.size > 1) selected.delete(v); } else selected.add(v); sync(); drawDetail(); };
    sync(); chips.append(chip);
  });
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Verlauf', el('span', { class: 'row', style: 'margin:0' }, cumSel)),
    el('div', { class: 'bd' }, chips, el('div', { class: 'chartbox' }, el('canvas', { id: 'detailChart' })))));
  const drawDetail = () => {
    const cum = cumSel.value === '1';
    const labels = d.daily.map(r => r.date);
    const sel = [...selected];
    const raw = sel.map(m => { let arr = seriesFor(m); if (cum) { let c = 0; arr = arr.map(v => c += (v || 0)); } return { m, arr, max: Math.max(1, ...arr) }; });
    const overall = Math.max(...raw.map(r => r.max));
    const useY2 = sel.length > 1 && raw.some(r => r.max < overall * 0.15);
    const datasets = raw.map(r => {
      const onY2 = useY2 && r.max < overall * 0.15;
      return { label: metricLabel(r.m) + (onY2 ? ' (r.)' : ''), data: r.arr, borderColor: METRIC_COLOR[r.m], backgroundColor: sel.length === 1 ? 'rgba(31,92,143,.12)' : METRIC_COLOR[r.m], yAxisID: onY2 ? 'y2' : 'y', fill: sel.length === 1, tension: .2, pointRadius: 0, borderWidth: 1.5 };
    });
    if (detailChart) detailChart.destroy();
    const opt = chartOpts();
    detailChart = new Chart($('#detailChart'), { type: 'line', data: { labels, datasets },
      options: { ...opt, scales: {
        x: { type: 'category', ticks: { color: '#5b6169', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: '#e3e5e8' } },
        y: { position: 'left', ticks: { color: '#5b6169', font: { size: 10 } }, grid: { color: '#e3e5e8' } },
        ...(useY2 ? { y2: { position: 'right', ticks: { color: '#5b6169', font: { size: 10 } }, grid: { drawOnChartArea: false } } } : {})
      } } });
  };
  cumSel.onchange = drawDetail; drawDetail();

  // Zwei-Spalten: links Notizen+Todos, rechts Ziele+Traffic
  const left = el('div'), right = el('div');
  body.append(el('div', { class: 'grid2' }, left, right));

  // Notizen (autosave)
  const notesTa = el('textarea', { style: 'width:100%;height:120px', placeholder: 'Notizen zu diesem Produkt …' }, m.notes || '');
  let noteTimer;
  const saveNote = () => { clearTimeout(noteTimer); noteTimer = setTimeout(() => jpost('/model/' + id + '/notes', { notes: notesTa.value }, 'PUT').then(() => flash(noteHd)), 600); };
  notesTa.addEventListener('input', saveNote);
  const noteHd = el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, 'autospeichern');
  left.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Notizen', noteHd), el('div', { class: 'bd' }, notesTa)));

  // Todos
  const tl = el('ul', { class: 'todolist' });
  const drawTodos = (todos) => { tl.innerHTML = ''; if (!todos.length) tl.append(el('li', { class: 'muted' }, 'Keine Aufgaben.'));
    todos.forEach(tdo => tl.append(todoRow(tdo, async () => { const nd = await api('/model/' + id); drawTodos(nd.todos); }))); };
  const tIn = el('input', { placeholder: 'Aufgabe …', style: 'flex:1' });
  const tPrio = el('select', {}, [['1','normal'],['2','hoch'],['0','niedrig']].map(([v, l]) => el('option', { value: v }, l)));
  const tDue = el('input', { type: 'date' });
  const addTodo = async () => { if (!tIn.value.trim()) return; await jpost('/todos', { design_id: id, title: tIn.value.trim(), priority: +tPrio.value, due_date: tDue.value || null }); tIn.value = ''; tDue.value = ''; const nd = await api('/model/' + id); drawTodos(nd.todos); await loadOverview(); };
  tIn.addEventListener('keydown', e => { if (e.key === 'Enter') addTodo(); });
  drawTodos(d.todos || []);
  left.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Todos'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, tIn, tPrio, tDue, el('button', { class: 'btn primary sm', onclick: addTodo }, '+')), tl)));

  // Ziele & Gruppe
  const gDl = el('input', { type: 'number', value: m.goal_download || '', placeholder: 'DL', style: 'width:90px' });
  const gView = el('input', { type: 'number', value: m.goal_view || '', placeholder: 'Views', style: 'width:90px' });
  const gPt = el('input', { type: 'number', value: m.goal_point || '', placeholder: 'Punkte', style: 'width:90px' });
  const gGrp = el('input', { value: m.group_label || '', placeholder: 'z.B. Bierdeckel', style: 'width:140px' });
  const goalWrap = el('div');
  const drawGoals = () => { goalWrap.innerHTML = '';
    const bar = (val, goal, label) => { if (!goal) return null; const p = Math.min(100, Math.round((val / goal) * 100));
      return el('div', { style: 'margin-top:6px' }, el('div', { class: 'muted', style: 'font-size:11px' }, `${label}: ${fmt(val)} / ${fmt(goal)}`),
        el('div', { class: 'goalbar' }, el('i', { style: `width:${p}%` }), el('span', {}, p + '%'))); };
    [bar(snap.download, m.goal_download, 'Downloads'), bar(snap.view, m.goal_view, 'Views'), bar(snap.point, m.goal_point, 'Punkte')].filter(Boolean).forEach(x => goalWrap.append(x));
    if (!m.goal_download && !m.goal_view && !m.goal_point) goalWrap.append(el('span', { class: 'muted', style: 'font-size:11px' }, 'Noch keine Ziele gesetzt.'));
    // ETA zum Download-Ziel (Basis: letzte 30 Tage)
    const perDay = (m.dl30 || 0) / 30;
    if (m.goal_download && snap.download != null && snap.download < m.goal_download && perDay > 0) {
      const days = Math.ceil((m.goal_download - snap.download) / perDay);
      goalWrap.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' }, `Ziel-Prognose: in ~${days} Tagen erreicht (bei ${fmt1(perDay)} DL/Tag)`));
    } };
  drawGoals();
  const saveGoals = async () => { m.goal_download = +gDl.value || null; m.goal_view = +gView.value || null; m.goal_point = +gPt.value || null; m.group_label = gGrp.value || null;
    await jpost('/model/' + id + '/goals', { goal_download: m.goal_download, goal_view: m.goal_view, goal_point: m.goal_point, group_label: m.group_label }, 'PUT'); drawGoals(); flash(goalHd); };
  const goalHd = el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, '');
  right.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Ziele & Gruppe', goalHd),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, el('label', {}, 'DL'), gDl, el('label', {}, 'Views'), gView, el('label', {}, 'Punkte'), gPt),
      el('div', { class: 'row' }, el('label', {}, 'Gruppe'), gGrp, el('button', { class: 'btn sm', onclick: saveGoals }, 'Speichern')), goalWrap)));

  // Traffic-Quellen als Donut (Lifetime) + Conversion-Funnel
  if (d.traffic && d.traffic.length) {
    const lt = d.traffic.find(t => t.window === 'lifetime') || d.traffic[0];
    right.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Quelle des Datenverkehrs'),
      el('div', { class: 'bd' }, trafficDonut(lt, snap.view, id))));
  }
  body.append(funnelCard(id, snap, d.daily));

  // Druckprofile (Instanzen) inkl. Bewertungen
  if (d.instances && d.instances.length) {
    const cols = [['title','Druckprofil'],['download_count','DL'],['print_count','Drucke'],['rating','★ (Anz.)'],['weight','Filament'],['time','Druckzeit'],['ams','AMS']];
    body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Druckprofile (${d.instances.length})`),
      el('div', { class: 'tablewrap' }, el('table', {},
        el('thead', {}, el('tr', {}, cols.map(([k, l]) => el('th', { class: k === 'title' ? '' : 'n' }, l)))),
        el('tbody', {}, d.instances.map(inst => el('tr', {},
          el('td', { class: 'title' }, (inst.is_default ? '★ ' : '') + (inst.title || '—')),
          el('td', { class: 'n' }, fmt(inst.download_count)),
          el('td', { class: 'n' }, fmt(inst.print_count)),
          el('td', { class: 'n' }, inst.rating_avg != null ? `${fmt1(inst.rating_avg)} (${inst.rating_count})` : '–'),
          el('td', { class: 'n' }, inst.weight != null ? fmt(inst.weight) + ' g' : '–'),
          el('td', { class: 'n' }, inst.print_min != null ? Math.floor(inst.print_min / 60) + ' h ' + (inst.print_min % 60) + ' min' : '–'),
          el('td', { class: 'n' }, inst.need_ams ? 'ja' : '–'))))))));
  }

  // Prognose (Trend-Regression über 90 Tage)
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Prognose (Trend, letzte 90 Tage)'),
    el('div', { class: 'bd' }, el('div', { class: 'stats', style: 'border:0;margin:0' },
      fcTile('Downloads', m.proj_dl30 || 0, m.proj_dl90 || 0), fcTile('Views', m.proj_v30 || 0, m.proj_v90 || 0), fcTile('Punkte', m.proj_pts30 || 0, m.proj_pts90 || 0),
      el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(m.proj_eur30 || 0)), el('div', { class: 'l' }, '€ · +30 T'), el('div', { class: 'd muted' }, eur(m.proj_eur90 || 0) + ' · +90 T'))))));

  // Wirkung von Änderungen (Titelbild/Titel/Tags/Beschreibung) auf CTR
  const ctrCard = el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Wirkung von Änderungen (CTR ±21 Tage)'), el('div', { class: 'bd', id: 'ctrbd' }, el('span', { class: 'muted' }, 'lädt …')));
  body.append(ctrCard);
  const TLBL = { thumbnail: 'Titelbild', title: 'Titel', tags: 'Tags', description: 'Beschreibung' };
  api('/model/' + id + '/ctr-impact').then(ci => {
    const bd = ctrCard.querySelector('#ctrbd'); bd.innerHTML = '';
    if (!ci.impacts.length) { bd.append(el('span', { class: 'muted' }, 'Änderungen an Titelbild, Titel, Tags oder Beschreibung werden beim Pull automatisch erkannt — danach steht hier CTR & Impressionen vorher/nachher (±' + ci.win + ' Tage).')); return; }
    const tb = el('table', {}, el('thead', {}, el('tr', {}, ['Datum','Änderung','CTR vorher','CTR nachher','Δ','Impr./Tag v→n','DL v→n'].map((h, i) => el('th', { class: i ? 'n' : '' }, h)))),
      el('tbody', {}, ci.impacts.map(im => el('tr', {},
        el('td', {}, im.date), el('td', {}, TLBL[im.type] || im.type),
        el('td', { class: 'n' }, im.before.ctr != null ? fmt1(im.before.ctr) + '%' : '–'),
        el('td', { class: 'n' }, im.after.ctr != null ? fmt1(im.after.ctr) + '%' : '–'),
        im.delta == null ? el('td', { class: 'n muted' }, '–') : el('td', { class: 'n ' + (im.delta > 0 ? 'pos' : im.delta < 0 ? 'neg' : '') }, (im.delta > 0 ? '+' : '') + fmt1(im.delta)),
        el('td', { class: 'n muted' }, `${fmt1(im.before.impPerDay)} → ${fmt1(im.after.impPerDay)}`),
        el('td', { class: 'n muted' }, `${fmt(im.before.dl)} → ${fmt(im.after.dl)}`)))));
    bd.append(el('div', { class: 'tablewrap' }, tb));
  });

  // Verknüpfte Projekte (CRM) zu diesem Modell
  if (d.crmProjects && d.crmProjects.length) {
    body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Verknüpfte Projekte (${d.crmProjects.length})`),
      el('div', { class: 'bd' }, d.crmProjects.map(pr => el('div', { class: 'checkline', style: 'cursor:pointer', onclick: () => openProject(pr.id) },
        el('span', { class: 'tag', style: `background:${PSTAGE_COLOR[pr.stage] || '#6b7280'}` }, labelOf(PROJECT_STAGES, pr.stage)),
        el('span', { style: 'flex:1' }, el('b', {}, pr.title), el('span', { class: 'muted' }, ' · ' + pr.contact_name)),
        el('span', { class: 'num muted' }, pr.price ? eur(pr.price) : 'gratis'))))));
  }
  // Beschreibung
  if (m.description) body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Beschreibung'), el('div', { class: 'bd muted', style: 'white-space:pre-wrap' }, m.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 1600))));

  // Galerie
  if (d.images && d.images.length) body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Bilder (${d.images.length})`),
    el('div', { class: 'bd' }, el('div', { class: 'gallery' }, d.images.map(im => el('a', { href: im.local_path ? '/data/' + im.local_path : im.url, target: '_blank' }, el('img', { src: im.local_path ? '/data/' + im.local_path : im.url, loading: 'lazy' })))))));

  // Änderungs-Events
  body.append(renderEventEditor(id, d.events));
}
function closeDrawer() { $('#drawer').classList.add('hidden'); if (detailChart) { detailChart.destroy(); detailChart = null; } if (groupChart) { groupChart.destroy(); groupChart = null; } if (donutChart) { donutChart.destroy(); donutChart = null; } }

// Traffic-Quellen als Donut (wie im MakerWorld Creator Center).
let donutChart = null;
function trafficDonut(lt, views, id) {
  const SRC = [['recommend','Empfehlen','#3fb950'],['search','Suchen','#2f81f7'],['browse','Durchsuchen','#f85149'],['direct','Direkte URL','#e3a008'],['other','Andere','#a371f7']];
  const cid = 'donut_' + id;
  const box = el('div', { class: 'donutbox' }, el('canvas', { id: cid }),
    el('div', { class: 'donutctr' }, el('div', { class: 'v' }, fmt(views)), el('div', { class: 'l' }, 'Aufrufe')));
  const list = el('div', { class: 'srclist' }, SRC.map(([k, l, c]) =>
    el('div', { class: 'r' }, el('span', { class: 'dot', style: `background:${c}` }), el('span', { class: 'nm' }, l), el('span', { class: 'pc' }, fmt1(lt[k] || 0) + '%'))));
  setTimeout(() => {
    const cv = document.getElementById(cid); if (!cv) return;
    if (donutChart) donutChart.destroy();
    donutChart = new Chart(cv, { type: 'doughnut',
      data: { labels: SRC.map(s => s[1]), datasets: [{ data: SRC.map(([k]) => +lt[k] || 0), backgroundColor: SRC.map(s => s[2]), borderColor: '#fff', borderWidth: 2 }] },
      options: { cutout: '64%', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => c.label + ': ' + c.formattedValue + '%' } } } } });
  }, 0);
  return el('div', { class: 'donutwrap' }, box, list);
}

// Conversion-Funnel: Eindrücke → Aufrufe → Downloads/Drucke, mit Zeitraum-Wahl.
function funnelCard(id, snap, daily) {
  let range = 'gesamt', metric = 'download';
  const cutoff = days => { const d = new Date(); d.setDate(d.getDate() - days); return d.toISOString().slice(0, 10); };
  const sumRange = (field, days) => daily.filter(r => r.date >= cutoff(days)).reduce((s, r) => s + (r[field] || 0), 0);
  const fnl = el('div', { class: 'funnel' });
  const render = () => {
    let imp, view, out;
    if (range === 'gesamt') { imp = snap.impression || 0; view = snap.view || 0; out = snap[metric] || 0; }
    else { const days = range === '365' ? 365 : 30; imp = sumRange('impression', days); view = sumRange('view', days); out = sumRange(metric, days); }
    const c1 = imp ? (view / imp * 100) : 0, c2 = view ? (out / view * 100) : 0;
    const label = metric === 'download' ? 'Downloads' : 'Drucke';
    fnl.innerHTML = '';
    fnl.append(
      el('div', { class: 'fstage', style: 'width:100%;background:#e3a008' }, 'Eindrücke', el('b', {}, fmt(imp))),
      el('div', { class: 'fconv' }, `▼ ${fmt1(c1)} %  (Eindrücke → Aufrufe)`),
      el('div', { class: 'fstage', style: 'width:64%;background:#3fb950' }, 'Aufrufe', el('b', {}, fmt(view))),
      el('div', { class: 'fconv' }, `▼ ${fmt1(c2)} %  (Aufrufe → ${label})`),
      el('div', { class: 'fstage', style: 'width:42%;background:#2f81f7' }, label, el('b', {}, fmt(out))));
  };
  const rangeSel = el('select', { class: 'sm' }, [['gesamt','Gesamt'],['365','1 Jahr'],['30','1 Monat']].map(([v, l]) => el('option', { value: v }, l)));
  rangeSel.onchange = () => { range = rangeSel.value; render(); };
  const metSel = el('select', { class: 'sm' }, [['download','Downloads'],['print','Drucke']].map(([v, l]) => el('option', { value: v }, l)));
  metSel.onchange = () => { metric = metSel.value; render(); };
  render();
  return el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Umrechnungskurse (Funnel)',
    el('span', { class: 'row', style: 'margin:0' }, rangeSel, metSel)), el('div', { class: 'bd' }, fnl));
}
$('#drawer').addEventListener('click', e => { if (e.target.id === 'drawer') closeDrawer(); });
function flash(node) { node.textContent = '✓ gespeichert'; node.classList.add('pos'); setTimeout(() => { node.textContent = ''; node.classList.remove('pos'); }, 1500); }

function renderEventEditor(design_id, events) {
  const list = el('ul', { class: 'timeline' });
  const draw = evs => { list.innerHTML = ''; if (!evs.length) list.append(el('li', { class: 'muted' }, 'Noch keine Änderungen erfasst.'));
    evs.forEach(ev => list.append(el('li', {}, el('span', { class: 'date' }, ev.date), el('span', { class: 'pill' }, ev.type || 'other'),
      el('div', { style: 'flex:1' }, el('b', {}, ev.title || '(ohne Titel)'), ev.note ? el('div', { class: 'muted' }, ev.note) : null),
      el('button', { class: 'btn sm ghost', onclick: async () => { await api('/events/' + ev.id, { method: 'DELETE' }); draw(evs = evs.filter(x => x.id !== ev.id)); } }, '✕')))); };
  draw(events);
  const dateI = el('input', { type: 'date', value: today() });
  const typeI = el('select', {}, ['thumbnail','title','description','tags','price','files','other'].map(t => el('option', { value: t }, t)));
  const titleI = el('input', { placeholder: 'Was geändert?', style: 'flex:1;min-width:160px' });
  const noteI = el('input', { placeholder: 'Notiz (optional)', style: 'flex:1;min-width:160px' });
  const add = async () => { if (!titleI.value && !noteI.value) return;
    const ev = await jpost('/events', { design_id, date: dateI.value, type: typeI.value, title: titleI.value, note: noteI.value });
    events.unshift(ev); draw(events); titleI.value = ''; noteI.value = ''; };
  return el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Änderungs-Timeline'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, dateI, typeI, titleI, noteI, el('button', { class: 'btn primary sm', onclick: add }, '+ Eintrag')), list));
}

// ============ HEUTE (Aktions-Dashboard) ============
async function renderHeute() {
  const d = await api('/today');
  const w = pagehead('Heute', 'Tagesübersicht: offene Zahlungen, fällige Aufgaben, Hinweise und Änderungen.');
  const tile = (v, l, cls) => el('div', { class: 'stat' }, el('div', { class: 'v ' + (cls || '') }, fmt(v)), el('div', { class: 'l' }, l));
  w.append(el('div', { class: 'stats' },
    tile(d.counts.payments, 'offene Zahlungen', d.counts.payments ? 'neg' : ''),
    tile(d.counts.due, 'überfällige Aufgaben', d.counts.due ? 'neg' : ''),
    tile(d.counts.todos, 'offene Aufgaben'),
    tile(d.counts.alerts, 'Alerts')));

  // Insights + Meilensteine (best effort — blockieren die Seite nicht)
  const [ins, ms] = await Promise.all([api('/insights').catch(() => ({ insights: [] })), api('/milestones').catch(() => [])]);
  if (ins.insights && ins.insights.length) {
    const bd = el('div', { class: 'bd' });
    ins.insights.forEach(i => bd.append(el('div', { class: 'checkline', style: i.design_id ? 'cursor:pointer' : '', onclick: () => i.design_id && openModel(i.design_id) },
      el('span', { style: 'flex:1' }, el('b', {}, i.title), el('span', { class: 'muted' }, ' — ' + i.text)))));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Insights', el('a', { onclick: () => go('report'), style: 'font-weight:400;text-transform:none;font-size:11px' }, 'Bericht →')), bd));
  }
  if (Array.isArray(ms) && ms.length) {
    const bd = el('div', { class: 'bd' });
    ms.slice(0, 6).forEach(m => bd.append(el('div', { class: 'checkline', style: m.design_id ? 'cursor:pointer' : '', onclick: () => m.design_id && openModel(m.design_id) },
      el('span', { class: 'muted' }, '•'), el('span', { style: 'flex:1' }, m.title), el('span', { class: 'muted num', style: 'font-size:11px' }, m.date))));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Meilensteine'), bd));
  }

  if (d.openPayments.length) {
    const bd = el('div', { class: 'bd' });
    d.openPayments.forEach(p => bd.append(el('div', { class: 'checkline', style: 'cursor:pointer', onclick: () => openProject(p.id) },
      el('span', { class: 'tag', style: 'background:var(--neg)' }, 'offen'),
      el('span', { style: 'flex:1' }, el('b', {}, p.contact_name), el('span', { class: 'muted' }, ' · ' + p.title)),
      el('span', { class: 'num' }, p.price ? eur(p.price) : '—'))));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Offene Zahlungen'), bd));
  }
  const openT = el('ul', { class: 'todolist' });
  const drawT = () => { openT.innerHTML = ''; if (!d.dueTodos.length) openT.append(el('li', { class: 'muted' }, 'Keine offenen Aufgaben.'));
    d.dueTodos.forEach(t => openT.append(todoRow(t, renderHeute))); };
  drawT();
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Aufgaben'), el('div', { class: 'bd' }, openT)));

  if (d.alerts.length) { const al = el('div', { class: 'alerts' });
    d.alerts.forEach(a => al.append(el('div', { class: 'alert', onclick: () => a.design_id && openModel(a.design_id) },
      el('span', { class: 'tag ' + a.type }, a.type), el('b', {}, a.title || 'Global'), el('span', { class: 'muted' }, '— ' + a.text))));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Alerts (${d.alerts.length})`), al)); }
  if (d.recentChanges.length) { const list = el('ul', { class: 'timeline' });
    d.recentChanges.forEach(c => list.append(el('li', {}, el('span', { class: 'date' }, c.date), el('span', { class: 'pill' }, c.type),
      el('div', { style: 'flex:1' }, el('b', {}, c.model_title || ''), c.note ? el('div', { class: 'muted' }, c.note) : null),
      c.design_id ? el('a', { onclick: () => openModel(c.design_id) }, 'öffnen') : null)));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Änderungen (letzte 3 Tage)'), el('div', { class: 'bd' }, list))); }
}

// ---- Globale Suche ----
function setupSearch() {
  const inp = $('#globalSearch'), box = $('#searchResults'); if (!inp) return;
  let t;
  inp.addEventListener('input', () => { clearTimeout(t); const q = inp.value.trim(); if (q.length < 3) { box.hidden = true; return; }
    t = setTimeout(async () => {
      const r = await api('/search?q=' + encodeURIComponent(q)); box.innerHTML = '';
      const grp = (title, items, fn) => { if (!items.length) return; box.append(el('div', { class: 'grp' }, title)); items.forEach(it => box.append(fn(it))); };
      const close = () => { box.hidden = true; inp.value = ''; };
      grp('Modelle', r.models, m => el('a', { onclick: () => { close(); openModel(m.design_id); } }, m.title || m.design_id));
      grp('Kunden', r.contacts, c => el('a', { onclick: () => { close(); openContact(c.id); } }, '' + c.name));
      grp('Projekte', r.projects, p => el('a', { onclick: () => { close(); openProject(p.id); } }, '' + p.title + ' · ' + p.contact_name));
      if (!r.models.length && !r.contacts.length && !r.projects.length) box.append(el('div', { class: 'grp' }, 'nichts gefunden'));
      box.hidden = false;
    }, 250); });
  document.addEventListener('click', e => { if (!e.target.closest('.searchbox')) box.hidden = true; });
}

// ---- Rechnung / Beleg (druckbar) ----
async function openInvoice(pid) {
  const s = await api('/crm/settings'); const seller = s.seller || {};
  if (!seller.name) { if (confirm('Kein Rechnungs-Absender hinterlegt. Jetzt unter Finanzen eintragen?')) { closeDrawer(); go('revenue'); } return; }
  const p = await api('/project/' + pid);
  const c = p.contact_id ? await api('/contact/' + p.contact_id).then(x => x.contact) : {};
  const num = (await jpost('/crm/invoice-number', {})).number;
  const qty = p.qty || 1; const total = p.calc?.price || 0; const unit = qty ? total / qty : total;
  const esc = x => String(x || '').replace(/[<>&]/g, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]));
  const dt = new Date().toLocaleDateString('de-DE');
  const custName = c.name || p.contact_name || '';
  // Druckpositionen (falls vorhanden) als Detailzeilen unter der Hauptposition.
  const posLines = (p.items || []).map(it => `<div class=detail>• ${esc(it.label || it.model_title || 'Position')} — ${it.qty}×</div>`).join('');
  const fnameSafe = s2 => String(s2 || '').replace(/[^\w äöüÄÖÜß.-]/g, '').trim().replace(/\s+/g, '_');
  const title = `Rechnung_${num}_${fnameSafe(custName) || 'Kunde'}`;
  const html = `<!doctype html><html lang=de><head><meta charset=utf-8><title>${esc(title)}</title>
  <style>body{font:13px/1.5 -apple-system,system-ui,sans-serif;color:#1a1c1f;max-width:720px;margin:0 auto;padding:40px 24px}
  h1{font-size:22px;margin:0 0 2px}.muted{color:#666}.row{display:flex;justify-content:space-between;margin-top:24px}
  table{width:100%;border-collapse:collapse;margin-top:24px}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;vertical-align:top}
  td.n,th.n{text-align:right}.tot{font-weight:700;font-size:16px}.foot{margin-top:30px;color:#666;font-size:12px}
  .detail{color:#666;font-size:11px;margin-top:2px}
  .bar{position:sticky;top:0;display:flex;gap:8px;align-items:center;background:#f4f5f6;border:1px solid #dcdfe3;border-radius:8px;padding:10px 12px;margin-bottom:20px;font-size:12px}
  .bar b{font-size:13px}.bar button{font:inherit;padding:6px 12px;border:1px solid #c3c7cc;background:#fff;border-radius:6px;cursor:pointer}
  .bar .pri{background:#1f5c8f;color:#fff;border-color:#1f5c8f;font-weight:600}
  @media print{body{margin:0;padding:0}.bar{display:none}}</style></head><body>
  <div class=bar><b>Rechnung ${num}</b><span class=muted style="flex:1">→ „Als PDF speichern" und dann selbst per WhatsApp / Mail / AirDrop verschicken.</span>
    <button class=pri onclick="window.print()">Als PDF speichern</button><button onclick="window.close()">Schließen</button></div>
  <div class=row><div><h1>${esc(seller.name)}</h1><div class=muted>${esc(seller.address || '')}<br>${esc(seller.email || '')} ${esc(seller.phone || '')}</div></div>
  <div style="text-align:right"><b>Rechnung</b><br>Nr. ${num}<br>${dt}</div></div>
  <div style="margin-top:24px"><div class=muted>Rechnung an</div><b>${esc(custName)}</b><br>${esc(c.email || '')}</div>
  <table><thead><tr><th>Position</th><th class=n>Menge</th><th class=n>Einzel</th><th class=n>Betrag</th></tr></thead>
  <tbody><tr><td>${esc(p.title)}${posLines}</td><td class=n>${qty}</td><td class=n>${unit.toFixed(2)} €</td><td class=n>${total.toFixed(2)} €</td></tr></tbody>
  <tfoot><tr><td colspan=3 class="n tot">Gesamt</td><td class="n tot">${total.toFixed(2)} €</td></tr></tfoot></table>
  ${seller.taxnote ? '<div class=foot>' + esc(seller.taxnote) + '</div>' : ''}
  ${seller.iban ? '<div class=foot>Zahlbar auf: ' + esc(seller.iban) + '</div>' : ''}</body></html>`;
  const wnd = window.open('', '_blank');
  if (!wnd) return toast('Popup blockiert — bitte Popups erlauben.');
  wnd.document.write(html); wnd.document.close(); wnd.focus();
}

// ============ CRM ============
const CONTACT_STAGES = [['neu','Neu'],['kontaktiert','Kontaktiert'],['angebot','Angebot'],['gewonnen','Gewonnen'],['verloren','Verloren']];
const STAGE_COLOR = { neu: '#6b7280', kontaktiert: '#1f5c8f', angebot: '#9a6a00', gewonnen: '#1a7f37', verloren: '#c1332d' };
const SOURCES = [['makerworld','MakerWorld'],['freund','Freund'],['empfehlung','Empfehlung'],['manuell','Manuell']];
const ORDER_STATUS = [['angefragt','Angefragt'],['bestaetigt','Bestätigt'],['produktion','Produktion'],['versendet','Versendet'],['bezahlt','Bezahlt'],['storniert','Storniert']];
const OSTATUS_COLOR = { angefragt: '#6b7280', bestaetigt: '#1f5c8f', produktion: '#9a6a00', versendet: '#0e7490', bezahlt: '#1a7f37', storniert: '#c1332d' };
const PROJECT_STATUS = [['offen','Offen'],['in_arbeit','In Arbeit'],['fertig','Fertig'],['abgebrochen','Abgebrochen']];
const PROJECT_STAGES = [['anfrage','Anfrage'],['modellierung','Modellieren'],['druck','Drucken'],['fertig','Fertig'],['abgebrochen','Abgebrochen']];
const PSTAGE_COLOR = { anfrage: '#6b7280', modellierung: '#9a6a00', druck: '#1f5c8f', fertig: '#1a7f37', abgebrochen: '#c1332d' };
// Eigenprojekte (kein Kunde): eigener Produktions-Workflow bis zur Veröffentlichung.
const SELF_STAGES = [['idee','Idee'],['modellierung','Modellieren'],['druck','Drucken'],['fotos','Fotos'],['eintrag','MW-Eintrag'],['publish','Veröffentlicht'],['abgebrochen','Abgebrochen']];
const SSTAGE_COLOR = { idee: '#6b7280', modellierung: '#9a6a00', druck: '#1f5c8f', fotos: '#0e7490', eintrag: '#7c3aed', publish: '#1a7f37', abgebrochen: '#c1332d' };
// Prioritäten (alle Projekte) — zum Strukturieren, was wann verfolgt wird.
const PRIORITIES = [['3','Dringend'],['2','Hoch'],['1','Normal'],['0','Niedrig']];
const PRIO_COLOR = { 3: '#c1332d', 2: '#b4620a', 1: '#6b7280', 0: '#9aa0a6' };
const prioLabel = v => (PRIORITIES.find(x => +x[0] === +v) || ['1', 'Normal'])[1];
// Stufen je Projekt-Typ (self / kind); ohne "abgebrochen" für Board/Path.
const stagesOf = p => p.self ? SELF_STAGES : (p.kind === 'modell' ? PROJECT_STAGES.filter(s => s[0] !== 'druck') : PROJECT_STAGES);
const stageColorOf = p => p.self ? SSTAGE_COLOR : PSTAGE_COLOR;
// Deadline-Badge (überfällig rot, bald orange).
function deadlineBadge(due) { if (!due) return null;
  const days = Math.ceil((Date.parse(due) - Date.now()) / 86400000);
  const cls = days < 0 ? 'neg' : days <= 3 ? 'warn' : 'muted';
  return el('span', { class: 'ddl ' + cls, title: 'Deadline ' + due }, days < 0 ? 'überfällig ' + (-days) + ' T' : days === 0 ? 'heute' : 'in ' + days + ' T'); }
function prioBadge(v) { if (v == null) return null; return el('span', { class: 'prio-badge', style: `background:${PRIO_COLOR[v] || '#6b7280'}` }, prioLabel(v)); }
const PART_CATEGORIES = [['magnet','Magnet'],['schraube','Schraube'],['metall','Metallteil'],['elektronik','Elektronik'],['sonstiges','Sonstiges']];
const labelOf = (arr, v) => (arr.find(x => x[0] === v) || [v, v])[1];
const mkSelect = (opts, val, cls) => { const s = el('select', cls ? { class: cls } : {}, opts.map(([v, l]) => el('option', { value: v }, l))); s.value = val; return s; };
function modelSelect(value) { const s = el('select', {}, el('option', { value: '' }, '— Modell (optional) —'),
  (STATE.overview?.models || []).map(m => el('option', { value: m.design_id }, (m.title || m.design_id).slice(0, 44)))); s.value = value || ''; return s; }
async function newContact() { const name = prompt('Name des Kunden/Leads:'); if (!name || !name.trim()) return;
  const c = await jpost('/contacts', { name: name.trim(), source: 'manuell' }); openContact(c.id); }

// ---- Kundenliste ----
async function renderContacts() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Kunden', 'Kontakte, Projekte und Aufträge im CRM.');
  const list = await api('/contacts');
  w.append(el('div', { class: 'toolbar' }, el('button', { class: 'btn primary sm', onclick: newContact }, '＋ Kunde'), csvBtn('kunden.csv'),
    el('span', { class: 'muted' }, `${list.length} Kontakte · Klick = Details`)));
  if (!list.length) { w.append(el('div', { class: 'card' }, el('div', { class: 'bd muted' }, 'Noch keine Kontakte. Lege oben deinen ersten Kunden/Lead an.'))); return; }
  const wrap = el('div', { class: 'tablewrap' }); w.append(wrap);
  const cols = [['Name'],['Quelle'],['Stufe'],['Projekte'],['Best.'],['Umsatz'],['bezahlt'],['letzte Best.']];
  wrap.append(el('table', {},
    el('thead', {}, el('tr', {}, cols.map(([l], i) => el('th', { class: i ? 'n' : '' }, l)))),
    el('tbody', {}, list.map(c => el('tr', { onclick: () => openContact(c.id) },
      el('td', { class: 'title' }, c.name),
      el('td', {}, labelOf(SOURCES, c.source)),
      el('td', {}, el('span', { class: 'tag', style: `background:${STAGE_COLOR[c.stage] || '#6b7280'}` }, labelOf(CONTACT_STAGES, c.stage))),
      el('td', { class: 'n' }, fmt(c.project_count)),
      el('td', { class: 'n' }, fmt(c.order_count)),
      el('td', { class: 'n' }, eur(c.order_total)),
      el('td', { class: 'n pos' }, eur(c.revenue_paid)),
      el('td', { class: 'n muted' }, c.last_order || '–'))))));
}

// ---- Kunden-Detail (Drawer) ----
async function openContact(id) {
  const d = await api('/contact/' + id);
  const c = d.contact;
  const inner = $('#drawer .drawer-inner'); inner.innerHTML = '';
  $('#drawer').classList.remove('hidden');
  const stageSel = mkSelect(CONTACT_STAGES, c.stage);
  stageSel.onchange = async () => { await jpost('/contacts/' + id, { stage: stageSel.value }, 'PUT'); toast('Stufe: ' + labelOf(CONTACT_STAGES, stageSel.value)); };
  inner.append(el('div', { class: 'dh' },
    el('div', { style: 'flex:1' }, el('h1', {}, c.name),
      el('div', { class: 'muted' }, labelOf(SOURCES, c.source) + (c.mw_handle ? ' · @' + c.mw_handle : '') + (c.email ? ' · ' + c.email : ''))),
    el('div', { class: 'row', style: 'margin:0;align-items:center' }, el('label', {}, 'Stufe'), stageSel),
    el('span', { class: 'close', onclick: closeDrawer }, '✕')));
  const body = el('div', { class: 'dbody' }); inner.append(body);

  // Umsatz-Kopf (aus Projekten)
  const prj = d.projects || [];
  const paid = prj.filter(p => p.paid).reduce((s, p) => s + (p.calc?.price || 0), 0);
  const openSum = prj.filter(p => !p.paid && p.stage !== 'abgebrochen' && (p.calc?.price || 0) > 0).reduce((s, p) => s + (p.calc?.price || 0), 0);
  const mwSum = prj.reduce((s, p) => s + (p.calc?.mwEarned || 0), 0);
  body.append(el('div', { class: 'stats' },
    el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(paid)), el('div', { class: 'l' }, 'bezahlt')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, eur(openSum)), el('div', { class: 'l' }, 'offen')),
    el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(mwSum)), el('div', { class: 'l' }, 'MakerWorld-Ertrag')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(prj.length)), el('div', { class: 'l' }, 'Projekte'))));

  // Stammdaten
  const f = {};
  const row = (label, key, type) => { f[key] = el('input', { type: type || 'text', value: c[key] || '', style: 'flex:1;min-width:160px' }); return el('div', { class: 'row' }, el('label', { style: 'min-width:70px' }, label), f[key]); };
  const srcSel = mkSelect(SOURCES, c.source); f.tags = el('input', { value: (c.tags || []).join(', '), placeholder: 'Tags, Komma', style: 'flex:1' });
  const notesTa = el('textarea', { style: 'width:100%;height:80px', placeholder: 'Notizen …' }, c.notes || '');
  const saveC = async () => { await jpost('/contacts/' + id, { name: f.name.value, source: srcSel.value, mw_handle: f.mw_handle.value, email: f.email.value, phone: f.phone.value, tags: f.tags.value, notes: notesTa.value }, 'PUT'); toast('Gespeichert.'); };
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Stammdaten'),
    el('div', { class: 'bd' }, row('Name', 'name'), el('div', { class: 'row' }, el('label', { style: 'min-width:70px' }, 'Quelle'), srcSel),
      row('Handle', 'mw_handle'), row('E-Mail', 'email'), row('Telefon', 'phone'),
      el('div', { class: 'row' }, el('label', { style: 'min-width:70px' }, 'Tags'), f.tags),
      notesTa, el('div', { class: 'row' }, el('button', { class: 'btn sm', onclick: saveC }, 'Speichern'),
        el('button', { class: 'btn sm ghost', onclick: async () => { if (!confirm('Kunde inkl. Projekte & Bestellungen löschen?')) return; await api('/contacts/' + id, { method: 'DELETE' }); closeDrawer(); renderContacts(); } }, 'Kunde löschen')))));

  const reload = async () => { const nd = await api('/contact/' + id); drawProjects(nd.projects); drawTodos(nd.todos || []); };

  // Projekte
  const pl = el('div');
  const drawProjects = ps => { pl.innerHTML = ''; if (!ps.length) pl.append(el('div', { class: 'muted' }, 'Keine Projekte.'));
    ps.forEach(p => { const c = p.calc || {};
      pl.append(el('div', { class: 'checkline', style: 'gap:10px;cursor:pointer', onclick: () => openProject(p.id) },
        el('span', { class: 'tag', style: `background:${PSTAGE_COLOR[p.stage] || '#6b7280'}` }, labelOf(PROJECT_STAGES, p.stage)),
        el('span', { style: 'flex:1' }, el('b', {}, p.title), p.model_title ? el('span', { class: 'muted' }, ' · ' + p.model_title) : ''),
        el('span', { class: 'muted num', style: 'font-size:11px' }, `Kosten ${eur(c.cost)}`),
        el('span', { class: 'num', style: 'font-weight:600' }, c.free ? el('span', { class: 'neg' }, 'gratis') : eur(c.price)),
        el('button', { class: 'btn sm ghost', onclick: async e => { e.stopPropagation(); if (!confirm('Projekt löschen?')) return; await api('/projects/' + p.id, { method: 'DELETE' }); reload(); } }, '✕'))); }); };
  drawProjects(d.projects);
  const pTitle = el('input', { placeholder: 'Neues Projekt …', style: 'flex:1' }); const pModel = modelSelect();
  const pKind = mkSelect([['modell_print', 'Modell + Druck'], ['modell', 'nur Modellarbeit']], 'modell_print');
  const addP = async () => { if (!pTitle.value.trim()) return; const np = await jpost('/projects', { contact_id: id, title: pTitle.value.trim(), design_id: pModel.value || null, kind: pKind.value }); pTitle.value = ''; openProject(np.id); };
  pTitle.addEventListener('keydown', e => { if (e.key === 'Enter') addP(); });
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Projekte', el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, 'Klick = Kalkulation')),
    el('div', { class: 'bd' }, pl, el('div', { class: 'row', style: 'margin-top:8px' }, pTitle, pModel, pKind, el('button', { class: 'btn primary sm', onclick: addP }, '+ Projekt')))));

  // Follow-up-Aufgaben (Todos) für diesen Kunden
  const tl = el('ul', { class: 'todolist' });
  const drawTodos = ts => { tl.innerHTML = ''; if (!ts.length) tl.append(el('li', { class: 'muted' }, 'Keine Aufgaben.'));
    ts.forEach(t => tl.append(todoRow(t, reload))); };
  drawTodos(d.todos || []);
  const tIn = el('input', { placeholder: 'z.B. Rückruf, Lieferung …', style: 'flex:1' });
  const tPrio = el('select', {}, [['1','normal'],['2','hoch'],['0','niedrig']].map(([v, l]) => el('option', { value: v }, l)));
  const tDue = el('input', { type: 'date' });
  const addT = async () => { if (!tIn.value.trim()) return; await jpost('/todos', { contact_id: id, title: tIn.value.trim(), priority: +tPrio.value, due_date: tDue.value || null }); tIn.value = ''; tDue.value = ''; reload(); await loadOverview(); };
  tIn.addEventListener('keydown', e => { if (e.key === 'Enter') addT(); });
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Aufgaben / Follow-ups'),
    el('div', { class: 'bd' }, tl, el('div', { class: 'row', style: 'margin-top:8px' }, tIn, tPrio, tDue, el('button', { class: 'btn primary sm', onclick: addT }, '+')))));
}

// ---- Leads-Pipeline (Kanban) ----
async function renderLeads() {
  const w = pagehead('Leads', 'Pipeline von Neu bis Gewonnen/Verloren — Stufe je Karte änderbar.');
  const list = await api('/contacts');
  w.append(el('div', { class: 'toolbar' }, el('button', { class: 'btn primary sm', onclick: newContact }, '＋ Lead')));
  const board = el('div', { class: 'board' });
  CONTACT_STAGES.forEach(([sv, sl]) => {
    const members = list.filter(c => (c.stage || 'neu') === sv);
    const col = el('div', { class: 'col' }, el('div', { class: 'colhd', style: `border-top:3px solid ${STAGE_COLOR[sv]}` }, sl, el('span', { class: 'cnt' }, members.length)));
    dndColumn(col, sv, async (id, stage) => { await jpost('/contacts/' + id, { stage }, 'PUT'); renderLeads(); });
    members.forEach(c => {
      const sel = mkSelect(CONTACT_STAGES, sv, 'sm'); sel.onclick = e => e.stopPropagation();
      sel.onchange = async e => { e.stopPropagation(); await jpost('/contacts/' + c.id, { stage: sel.value }, 'PUT'); renderLeads(); };
      const card = el('div', { class: 'kcard', onclick: () => openContact(c.id) },
        el('div', { class: 'kt' }, c.name),
        el('div', { class: 'muted', style: 'font-size:11px' }, `${labelOf(SOURCES, c.source)} · ${c.order_count} Best. · ${eur(c.order_total)}`), sel);
      dndCard(card, c.id);
      col.append(card);
    });
    if (!members.length) col.append(el('div', { class: 'muted', style: 'padding:8px' }, '—'));
    board.append(col);
  });
  w.append(board);
}

// ---- Umsatz-Dashboard ----
let revChart = null;
async function renderRevenue() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Finanzen', 'Umsatz aus Projekten, MakerWorld-Auszahlungen, Ausgaben und Gewinn/Verlust.');
  const d = await api('/crm/revenue');
  w.append(el('div', { class: 'stats' },
    el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(d.paid)), el('div', { class: 'l' }, 'Umsatz bezahlt')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, eur(d.open)), el('div', { class: 'l' }, 'offen (Pipeline)')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, eur(d.total)), el('div', { class: 'l' }, 'gesamt')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(d.contacts)), el('div', { class: 'l' }, 'Kontakte'), el('div', { class: 'd muted' }, d.openLeads + ' offene Leads'))));
  const ps = d.projectStats;
  if (ps && ps.count) w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Projekt-Kalkulation (' + ps.count + ' Projekte)'),
    el('div', { class: 'bd' }, el('div', { class: 'stats', style: 'border:0;margin:0' },
      el('div', { class: 'stat' }, el('div', { class: 'v' }, eur(ps.material)), el('div', { class: 'l' }, 'Materialkosten')),
      el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(ps.revenue)), el('div', { class: 'l' }, 'Direkteinnahmen')),
      el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(ps.mwFromProjects)), el('div', { class: 'l' }, 'MakerWorld-Ertrag'), el('div', { class: 'd muted' }, 'aus verknüpften Modellen')),
      el('div', { class: 'stat', style: 'border-left:2px solid var(--accent)' }, el('div', { class: 'v ' + (ps.grandTotal >= 0 ? 'pos' : 'neg') }, eur(ps.grandTotal)), el('div', { class: 'l' }, 'Gesamtbilanz'), el('div', { class: 'd muted' }, 'direkt − Material + MW')),
      el('div', { class: 'stat' }, el('div', { class: 'v neg' }, eur(ps.loss)), el('div', { class: 'l' }, 'Verlust (Gratis)'), el('div', { class: 'd muted' }, ps.freeCount + ' kostenlos'))))));
  if (d.freeButEarning && d.freeButEarning.length) {
    const wrap = el('div', { class: 'tablewrap' });
    wrap.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Gratis-Projekt'), el('th', {}, 'Kunde'), el('th', {}, 'Modell'), el('th', { class: 'n' }, 'MakerWorld €'), el('th', { class: 'n' }, 'netto'))),
      el('tbody', {}, d.freeButEarning.map(p => el('tr', { onclick: () => openProject(p.id) },
        el('td', { class: 'title' }, p.title), el('td', {}, p.contact_name),
        el('td', {}, p.model_title || '–'), el('td', { class: 'n pos' }, eur(p.mwEarned)),
        el('td', { class: 'n ' + (p.net >= 0 ? 'pos' : 'neg') }, eur(p.net)))))));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Gratis-Projekte, die auf MakerWorld verdienen'),
      el('div', { class: 'bd muted', style: 'padding-bottom:0' }, 'Kostenlos modelliert — aber das hochgeladene Modell bringt über Punkte/Downloads Geld ein.'), wrap));
  }
  // Projekte, deren Modell auf MakerWorld Geld/Credits macht ("hat sich gelohnt?")
  if (d.projectModels && d.projectModels.length) {
    const wrap = el('div', { class: 'tablewrap' });
    wrap.append(el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Projekt'), el('th', {}, 'Kunde'), el('th', {}, 'Modell'),
      el('th', { class: 'n' }, 'Downloads'), el('th', { class: 'n' }, 'Punkte'),
      el('th', { class: 'n' }, 'MakerWorld €'), el('th', { class: 'n' }, 'netto'))),
      el('tbody', {}, d.projectModels.map(r => el('tr', {},
        el('td', { class: 'title', style: 'cursor:pointer', onclick: () => openProject(r.project_id) }, r.title,
          r.free ? el('span', { class: 'tag', style: 'background:#9a6a00;margin-left:6px' }, 'gratis') : (r.paid ? el('span', { class: 'tag', style: 'background:#1a7f37;margin-left:6px' }, eur(r.price)) : '')),
        el('td', {}, r.contact_name),
        el('td', { style: 'cursor:pointer', onclick: () => openModel(r.design_id) }, r.model_title || r.design_id),
        el('td', { class: 'n' }, fmt(r.downloads)), el('td', { class: 'n' }, fmt(r.points)),
        el('td', { class: 'n pos' }, eur(r.mwEarned)),
        el('td', { class: 'n ' + (r.net >= 0 ? 'pos' : 'neg') }, eur(r.net)))))));
    w.append(el('div', { class: 'card' },
      el('div', { class: 'hd' }, 'Projekte → MakerWorld-Ertrag', el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, t('Summe') + ' ' + eur(d.projectModelsTotal))),
      el('div', { class: 'bd muted', style: 'padding-bottom:0' }, 'Privat entstandene Projekte, deren hochgeladenes Modell danach über Downloads/Punkte Geld einbringt. „netto" = MakerWorld-Ertrag − Materialeinsatz des Projekts.'), wrap));
  }
  if (d.monthly && d.monthly.length) {
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Monatsumsatz (bezahlt)'), el('div', { class: 'bd' }, el('div', { class: 'chartbox', style: 'height:200px' }, el('canvas', { id: 'revChart' })))));
    if (revChart) revChart.destroy();
    revChart = new Chart($('#revChart'), { type: 'bar', data: { labels: d.monthly.map(m => m.m), datasets: [{ label: '€ bezahlt', data: d.monthly.map(m => m.sum), backgroundColor: '#1a7f37' }] }, options: chartOpts() });
  }
  const tbl = (title, rows, cols) => { if (!rows.length) return; const c = el('div', { class: 'card' }, el('div', { class: 'hd' }, title));
    c.append(el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, cols.map(([, l], i) => el('th', { class: i ? 'n' : '' }, l)))),
      el('tbody', {}, rows.map(r => el('tr', r._click ? { onclick: r._click } : {}, cols.map(([k], i) => el('td', { class: i ? 'n' + (k === 'paid' ? ' pos' : '') : 'title' }, k === 'source' ? labelOf(SOURCES, r[k]) : (typeof r[k] === 'number' && k !== 'cnt' && k !== 'customers') ? eur(r[k]) : (r[k] ?? '–')))))))));
    w.append(c); };
  tbl('Nach Quelle', d.bySource, [['source','Quelle'],['sum','Umsatz'],['cnt','Projekte']]);
  tbl('Top-Kunden', d.byContact.map(r => ({ ...r, _click: () => openContact(r.id) })), [['name','Kunde'],['sum','Umsatz'],['paid','bezahlt'],['cnt','Proj.']]);
  tbl('Umsatz je Modell', d.byModel.map(r => ({ ...r, _click: () => r.design_id && openModel(r.design_id) })), [['title','Modell'],['sum','Umsatz'],['customers','Kunden'],['cnt','Proj.']]);

  // ===== Gewinn & Verlust + Ausgaben + Auszahlungen =====
  const pnl = await api('/crm/pnl');
  w.append(el('div', { class: 'pagehead', style: 'padding:12px 0;border:0;margin-top:10px' }, el('h1', { style: 'font-size:15px' }, 'Gewinn & Verlust')));
  w.append(el('div', { class: 'stats' },
    el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(pnl.totals.income)), el('div', { class: 'l' }, 'Einnahmen (Projekte)')),
    el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(pnl.totals.payout)), el('div', { class: 'l' }, 'MakerWorld-Auszahlungen')),
    el('div', { class: 'stat' }, el('div', { class: 'v neg' }, eur(pnl.totals.expense)), el('div', { class: 'l' }, 'Ausgaben')),
    el('div', { class: 'stat', style: 'border-left:2px solid var(--accent)' }, el('div', { class: 'v ' + (pnl.totals.net >= 0 ? 'pos' : 'neg') }, eur(pnl.totals.net)), el('div', { class: 'l' }, 'Netto-Gewinn')),
    el('div', { class: 'stat' }, el('div', { class: 'v muted' }, eur(pnl.walletOpenEur)), el('div', { class: 'l' }, 'Punkte offen'), el('div', { class: 'd muted' }, 'noch nicht ausgezahlt'))));
  if (pnl.monthly.length) { w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Monatlich: Einnahmen/Auszahlungen vs. Ausgaben'), el('div', { class: 'bd' }, el('div', { class: 'chartbox', style: 'height:200px' }, el('canvas', { id: 'pnlChart' })))));
    if (window.__pnlChart) window.__pnlChart.destroy();
    window.__pnlChart = new Chart($('#pnlChart'), { type: 'bar', data: { labels: pnl.monthly.map(m => m.m), datasets: [
      { label: 'Einnahmen', data: pnl.monthly.map(m => m.income + m.payout), backgroundColor: '#1a7f37' },
      { label: 'Ausgaben', data: pnl.monthly.map(m => -m.expense), backgroundColor: '#c1332d' }] }, options: { ...chartOpts(), scales: { ...chartOpts().scales, x: { ...chartOpts().scales.x, stacked: true }, y: { ...chartOpts().scales.y, stacked: true } } } });
  }

  // Ausgaben-Verwaltung
  const exWrap = el('div');
  const drawEx = async () => { const list = await api('/expenses'); exWrap.innerHTML = '';
    exWrap.append(el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Datum'), el('th', {}, 'Kategorie'), el('th', {}, 'Beschreibung'), el('th', { class: 'n' }, 'Betrag'), el('th', {}, ''))),
      el('tbody', {}, list.length ? list.map(e => el('tr', {}, el('td', { class: 'num' }, e.date), el('td', {}, labelOf(EXP_CAT, e.category)), el('td', {}, e.description || '–'), el('td', { class: 'n neg' }, eur(e.amount)),
        el('td', {}, el('button', { class: 'btn sm ghost', onclick: async () => { await api('/expenses/' + e.id, { method: 'DELETE' }); drawEx(); } }, '✕'))))
        : [el('tr', {}, el('td', { class: 'muted' }, 'Keine Ausgaben.'))])))); };
  await drawEx();
  const exDate = el('input', { type: 'date', value: today() }); const exCat = mkSelect(EXP_CAT, 'filament');
  const exDesc = el('input', { placeholder: 'Beschreibung', style: 'flex:1' }); const exAmt = el('input', { type: 'number', step: '0.01', placeholder: '€', style: 'width:90px' });
  const addEx = async () => { if (!exAmt.value) return; await jpost('/expenses', { date: exDate.value, category: exCat.value, description: exDesc.value, amount: +exAmt.value }); exDesc.value = ''; exAmt.value = ''; drawEx(); renderRevenue(); };
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Ausgaben'),
    el('div', { class: 'bd' }, exWrap, el('div', { class: 'row', style: 'margin-top:8px' }, exDate, exCat, exDesc, exAmt, el('button', { class: 'btn primary sm', onclick: addEx }, '+ Ausgabe')))));

  // Auszahlungen
  const poWrap = el('div');
  const drawPo = async () => { const list = await api('/payouts'); poWrap.innerHTML = '';
    poWrap.append(el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Datum'), el('th', { class: 'n' }, 'Punkte'), el('th', { class: 'n' }, 'Betrag'), el('th', {}, 'Notiz'), el('th', {}, ''))),
      el('tbody', {}, list.length ? list.map(o => el('tr', {}, el('td', { class: 'num' }, o.date), el('td', { class: 'n' }, fmt(o.points)), el('td', { class: 'n pos' }, eur(o.amount)), el('td', {}, o.note || '–'),
        el('td', {}, el('button', { class: 'btn sm ghost', onclick: async () => { await api('/payouts/' + o.id, { method: 'DELETE' }); drawPo(); } }, '✕'))))
        : [el('tr', {}, el('td', { class: 'muted' }, 'Keine Auszahlungen.'))])))); };
  await drawPo();
  const poDate = el('input', { type: 'date', value: today() }); const poPts = el('input', { type: 'number', value: 524, style: 'width:80px' });
  const poAmt = el('input', { type: 'number', step: '0.01', value: 40, style: 'width:80px' }); const poNote = el('input', { placeholder: 'Notiz', style: 'flex:1' });
  const addPo = async () => { await jpost('/payouts', { date: poDate.value, points: +poPts.value, amount: +poAmt.value, note: poNote.value }); poNote.value = ''; drawPo(); renderRevenue(); };
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Punkte-Auszahlungen (Gutscheine)'),
    el('div', { class: 'bd' }, poWrap, el('div', { class: 'row', style: 'margin-top:8px' }, poDate, poPts, el('span', {}, 'Pkt ='), poAmt, el('span', {}, '€'), poNote, el('button', { class: 'btn primary sm', onclick: addPo }, '+ Auszahlung')))));

  // Rechnungs-Absender
  const seller = d.seller || (await api('/crm/settings')).seller || {};
  const sf = {}; const sRow = (label, key, w2) => { sf[key] = el('input', { value: seller[key] || '', style: 'flex:1' }); return el('div', { class: 'row' }, el('label', { style: 'min-width:110px' }, label), sf[key]); };
  const saveSeller = async () => { await jpost('/crm/settings', { seller: { name: sf.name.value, address: sf.address.value, email: sf.email.value, phone: sf.phone.value, iban: sf.iban.value, taxnote: sf.taxnote.value } }); toast('Absender gespeichert.'); };
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Rechnungs-Absender (für Belege)'),
    el('div', { class: 'bd' }, sRow('Name', 'name'), sRow('Adresse', 'address'), sRow('E-Mail', 'email'), sRow('Telefon', 'phone'), sRow('IBAN', 'iban'), sRow('Steuer-Hinweis', 'taxnote'),
      el('div', { class: 'row' }, el('button', { class: 'btn sm', onclick: saveSeller }, 'Speichern'), el('span', { class: 'muted', style: 'font-size:11px' }, 'z.B. „Kleinunternehmer gemäß §19 UStG, keine Umsatzsteuer."')))));
}
const EXP_CAT = [['filament','Filament'],['drucker','Drucker'],['zubehoer','Zubehör'],['versand','Versand'],['sonstiges','Sonstiges']];

// ---- Projekt-Kalkulation (Drawer) ----
function calcClient(p, parts, s, items = []) {
  const hasItems = items && items.length > 0;
  const filamentG = hasItems ? items.reduce((a, it) => a + (+it.qty || 0) * (+it.weight_g || 0), 0) : (+p.filament_g || 0);
  const printH = hasItems ? items.reduce((a, it) => a + (+it.qty || 0) * (+it.print_min || 0), 0) / 60 : (+p.print_hours || 0);
  const filament = filamentG / 1000 * s.filament_price_kg;
  const partsSum = parts.reduce((a, pp) => a + (+pp.qty || 0) * (+pp.unit_price || 0), 0);
  const energy = printH * s.energy_rate_h;
  const material = filament + partsSum + energy;
  const labor = (+p.labor_hours || 0) * s.labor_rate_h;
  const cost = material + labor;
  const free = p.margin_tier === 'kostenlos';
  const tier = (s.tiers || []).find(t => t.name === p.margin_tier);
  const margin = tier ? tier.margin : ((s.tiers && s.tiers[0]?.margin) ?? 0.6);
  const roundUp = (x, st) => st > 0 ? Math.ceil(x / st) * st : x;
  const exclusiveFee = p.no_upload ? (+p.no_upload_fee || 0) : 0;
  const suggestion = (free ? 0 : roundUp(cost * (1 + margin), s.round_to)) + exclusiveFee;
  const price = (p.price != null && p.price !== '') ? +p.price : suggestion;
  return { filament, partsSum, energy, material, labor, cost, margin, free, suggestion, price, profit: price - cost, contribution: price - material, loss: price <= 0 ? -material : 0, filamentG, printH, hasItems, exclusiveFee };
}
async function openProject(id) {
  const s = await api('/crm/settings');
  let full = await api('/project/' + id);
  const p = { ...full };                          // veraenderbarer Zustand
  let parts = full.parts || [];
  let items = full.items || [];                   // Druckpositionen (mehrere Modelle/Profile)
  const instCache = {};                           // design_id -> instances[]
  const loadInstances = async did => { if (!did) return []; if (instCache[did]) return instCache[did];
    try { const md = await api('/model/' + did); return instCache[did] = (md.instances || []); } catch { return instCache[did] = []; } };
  const inner = $('#drawer .drawer-inner'); inner.innerHTML = '';
  $('#drawer').classList.remove('hidden');
  let saveT;
  const persist = () => { clearTimeout(saveT); saveT = setTimeout(async () => {
    await jpost('/projects/' + id, { title: p.title, stage: p.stage, design_id: p.design_id, filament_g: +p.filament_g || null,
      print_hours: +p.print_hours || null, labor_hours: +p.labor_hours || null, margin_tier: p.margin_tier,
      price: (p.price === '' || p.price == null) ? null : +p.price, paid: p.paid ? 1 : 0, qty: +p.qty || 1,
      kind: p.kind || 'modell_print', no_upload: p.no_upload ? 1 : 0, no_upload_fee: +p.no_upload_fee || 0,
      close_date: p.close_date || null, due_date: p.due_date || null, priority: p.priority ?? 1 }, 'PUT');
    await loadOverview();
  }, 500); };

  const res = el('div', { class: 'stats' });
  const drawRes = () => { const c = calcClient(p, parts, s, items); res.innerHTML = '';
    syncManualInputs(c);
    const mwE = p.mw?.earned || 0;
    const total = +((c.price - c.material) + mwE).toFixed(2);
    const tile = (v, l, cls, d) => el('div', { class: 'stat' }, el('div', { class: 'v ' + (cls || '') }, v), el('div', { class: 'l' }, l), d ? el('div', { class: 'd muted' }, d) : null);
    if (p.self) {   // Eigenprojekt: eigene Kosten + MakerWorld-Ertrag, kein Kundenpreis
      const selfBal = +(mwE - c.cost).toFixed(2);
      res.append(
        tile(eur(c.material), 'Material (Sach)'),
        tile(eur(c.cost), 'Selbstkosten', '', 'inkl. Arbeitszeit'),
        tile(eur(mwE), 'MakerWorld-Ertrag', mwE > 0 ? 'pos' : 'muted', p.mw ? `${fmt(p.mw.download)} DL · ${fmt(p.mw.point)} P` : (p.design_id ? '' : 'noch nicht veröffentlicht')),
        tile(eur(selfBal), 'Bilanz', selfBal >= 0 ? 'pos' : 'neg', 'MakerWorld − Selbstkosten'));
      return;
    }
    const modelOnly = p.kind === 'modell';
    const tiles = [
      tile(eur(c.material), 'Material (Sach)'),
      c.free ? tile(eur(c.loss), 'Verlust', 'neg') : tile(eur(c.price), 'Preis', 'pos'),
      tile(eur(c.profit), 'Gewinn direkt', c.profit >= 0 ? 'pos' : 'neg')];
    if (!modelOnly || p.design_id) tiles.push(
      tile(eur(mwE), 'MakerWorld-Ertrag', mwE > 0 ? 'pos' : 'muted', p.mw ? `${fmt(p.mw.download)} DL · ${fmt(p.mw.point)} P` : 'kein Modell verknüpft'),
      tile(eur(total), 'Gesamtbilanz', total >= 0 ? 'pos' : 'neg', 'direkt + MakerWorld'));
    tiles.push(tile(c.free ? '–' : eur(c.suggestion), 'Preisvorschlag'));
    res.append(...tiles);
    priceHint.textContent = c.free ? 'kostenlos' : (p.price == null || p.price === '' ? 'leer = Vorschlag ' + eur(c.suggestion) : '');
  };

  const stageSel = mkSelect(stagesOf(p), p.stage);
  stageSel.onchange = () => setStage(stageSel.value);
  // Art des Projekts (nur Kundenprojekte): Modell + Druck oder nur Modellarbeit.
  const kindSel = mkSelect([['modell_print', 'Modell + Druck'], ['modell', 'nur Modellarbeit']], p.kind || 'modell_print');
  const rebuildStages = () => { stageSel.innerHTML = '';
    stagesOf(p).forEach(([v, l]) => stageSel.append(el('option', { value: v }, l)));
    if (![...stageSel.options].some(o => o.value === p.stage)) p.stage = stagesOf(p)[0][0];
    stageSel.value = p.stage; };
  kindSel.onchange = () => { p.kind = kindSel.value; rebuildStages(); applyKind(); persist(); drawRes(); drawPath(); };
  // Stufen-Pfad (Path) — Chevrons + "Stufe abschließen" (Abbrechen bleibt im Dropdown)
  const pathWrap = el('div', { style: 'flex:1;min-width:220px' });
  const markBtn = el('button', { class: 'btn primary sm' }, 'Stufe abschließen');
  const closeDateI = el('input', { type: 'date', value: p.close_date || '' });
  closeDateI.onchange = () => { p.close_date = closeDateI.value || null; persist(); };
  const pathStages = () => stagesOf(p).filter(sd => sd[0] !== 'abgebrochen');
  const lastStage = () => pathStages().slice(-1)[0][0];   // 'fertig' bzw. 'publish' (Eigenprojekt)
  const setStage = (v) => { p.stage = v; stageSel.value = v; applyKind(); persist(); drawPath();
    if (v === lastStage() && !p.close_date) { p.close_date = today(); closeDateI.value = p.close_date; } };
  function drawPath() { const st = pathStages(); pathWrap.innerHTML = ''; pathWrap.append(stagePath(st, p.stage, setStage));
    const done = p.stage === lastStage(); markBtn.disabled = done; markBtn.textContent = done ? 'Abgeschlossen' : 'Stufe abschließen'; }
  markBtn.onclick = () => { const order = pathStages().map(s => s[0]); const i = order.indexOf(p.stage); if (i > -1 && i < order.length - 1) setStage(order[i + 1]); };
  // Priorität + Deadline (alle Projekte) — zum Strukturieren, was wann drankommt.
  const prioSel = mkSelect(PRIORITIES, String(p.priority ?? 1));
  prioSel.onchange = () => { p.priority = +prioSel.value; persist(); };
  const dueI = el('input', { type: 'date', value: p.due_date || '' });
  dueI.onchange = () => { p.due_date = dueI.value || null; persist(); };
  const titleI = el('input', { value: p.title || '', style: 'font-size:14px;font-weight:600;flex:1;min-width:200px' });
  titleI.oninput = () => { p.title = titleI.value; persist(); };
  inner.append(el('div', { class: 'dh' },
    el('div', { style: 'flex:1' }, el('div', { class: 'row', style: 'margin:0 0 4px' }, titleI),
      el('div', { class: 'muted' }, (p.self ? 'Eigenprojekt' : (p.contact_name || '')) + (p.model_title ? ' · Modell: ' + p.model_title : ''))),
    el('div', { class: 'row', style: 'margin:0;align-items:center' }, el('label', {}, 'Phase'), stageSel),
    el('span', { class: 'close', onclick: closeDrawer }, '✕')));
  const body = el('div', { class: 'dbody' }); inner.append(body);
  body.append(res);

  // Stufen-Pfad (Path) + Priorität/Deadline/Abschlussdatum
  body.append(el('div', { class: 'card' }, el('div', { class: 'bd' },
    el('div', { class: 'row', style: 'align-items:center;gap:12px;flex-wrap:wrap' }, pathWrap, markBtn),
    el('div', { class: 'row', style: 'margin-top:6px;flex-wrap:wrap' },
      el('label', { style: 'min-width:96px' }, 'Priorität'), prioSel,
      el('label', { style: 'margin-left:12px' }, 'Deadline'), dueI,
      el('label', { style: 'margin-left:12px' }, 'Abschluss'), closeDateI))));
  drawPath();

  // Eingaben
  const num = (key, label, ph, w) => { const i = el('input', { type: 'number', step: '0.01', value: p[key] ?? '', placeholder: ph, style: `width:${w || 90}px` });
    i.oninput = () => { p[key] = i.value; drawRes(); persist(); }; return el('div', { class: 'row', style: 'margin:0' }, el('label', { style: 'min-width:96px' }, label), i); };
  const tierSel = mkSelect([...(s.tiers || []).map(t => [t.name, t.name + ' (' + Math.round(t.margin * 100) + '%)']), ['kostenlos', 'Kostenlos (nur Material)']], p.margin_tier || (s.tiers?.[0]?.name || 'Standard'));
  tierSel.onchange = () => { p.margin_tier = tierSel.value; drawRes(); persist(); };
  const priceI = el('input', { type: 'number', step: '0.5', value: p.price ?? '', placeholder: 'Vorschlag', style: 'width:100px' });
  const priceHint = el('span', { class: 'muted', style: 'font-size:11px' });
  priceI.oninput = () => { p.price = priceI.value; drawRes(); persist(); };
  const refreshMw = async () => { if (!p.design_id) { p.mw = null; drawRes(); return; }
    try { const md = await api('/model/' + p.design_id); const sn = md.snaps?.[md.snaps.length - 1] || {}; p.mw = { earned: md.model.earned ?? 0, point: sn.point ?? 0, download: sn.download ?? 0, view: sn.view ?? 0 }; } catch { p.mw = null; } drawRes(); };
  const modelSel = modelSelect(p.design_id); modelSel.onchange = () => { p.design_id = modelSel.value || null; applyKind(); persist(); refreshMw(); };
  const fillFromModel = el('button', { class: 'btn sm ghost', title: 'Filament & Druckzeit aus dem Standard-Druckprofil (× Stückzahl)', onclick: async () => {
    if (!p.design_id) return toast('Erst ein Modell wählen.');
    const md = await api('/model/' + p.design_id);
    const inst = (md.instances || [])[0];
    if (!inst || (!inst.weight && !inst.print_min)) return toast('Kein Druckprofil mit Gewicht/Zeit im Modell.');
    const q = +p.qty || 1; const msg = [];
    if (inst.weight) { p.filament_g = Math.round(inst.weight * q); gInput.querySelector('input').value = p.filament_g; msg.push(p.filament_g + ' g'); }
    if (inst.print_min) { p.print_hours = +((inst.print_min / 60) * q).toFixed(2); phInput.querySelector('input').value = p.print_hours; msg.push(p.print_hours + ' h Druck'); }
    drawRes(); persist();
    toast('Übernommen: ' + msg.join(', ') + (q > 1 ? ' (×' + q + ')' : ''));
  } }, '⤵ aus Modell');
  const gInput = num('filament_g', 'Filament (g)', 'Gramm');
  const phInput = num('print_hours', 'Druckzeit (h)', 'Stunden');
  const lhInput = num('labor_hours', 'Arbeitszeit (h)', 'Stunden');
  const qtyI = el('input', { type: 'number', value: p.qty ?? 1, style: 'width:70px' });
  qtyI.oninput = () => { p.qty = qtyI.value; persist(); };
  const paidCb = el('input', { type: 'checkbox' }); paidCb.checked = !!p.paid;
  paidCb.onchange = () => { p.paid = paidCb.checked; persist(); loadOverview(); };
  // Modell-Vorschlag / Veröffentlichen
  const modelLabel = el('label', { style: 'min-width:96px' }, 'Modell');
  const modelRow = el('div', { class: 'row' }, modelLabel, modelSel, fillFromModel);
  const suggestBtn = el('button', { class: 'btn sm ghost', onclick: async () => {
    const sug = await api('/crm/model-suggestions?q=' + encodeURIComponent(p.title || ''));
    if (!sug.length) return toast('Kein passendes Modell gefunden.');
    const box = el('div', { class: 'row', style: 'margin-top:4px' }, el('span', { class: 'muted' }, 'Vorschlag:'),
      ...sug.map(m => el('button', { class: 'btn sm', onclick: () => { p.design_id = m.design_id; modelSel.value = m.design_id; applyKind(); persist(); refreshMw(); box.remove(); toast('verknüpft: ' + m.title); } }, (m.title || '').slice(0, 28))));
    modelRow.after(box);
  } }, 'Vorschlag');
  const pubBtn = el('button', { class: 'btn sm', onclick: async () => {
    const r = await jpost('/crm/projects/' + id + '/publish', {}); p.design_id = r.design_id; p.published = 1; modelSel.value = r.design_id || '';
    applyKind(); refreshMw(); await loadOverview(); toast(r.design_id?.startsWith('plan_') ? 'Als geplantes Produkt angelegt (erscheint unter Produkte)' : 'Als veröffentlicht markiert'); } },
    p.published ? '✓ veröffentlicht' : '↗ MakerWorld-Upload');
  const mwRow = el('div', { class: 'row', style: 'margin:0' }, suggestBtn, pubBtn);
  // Exklusiv: Kunde zahlt Aufpreis dafür, dass das Modell NICHT hochgeladen wird
  // (blendet die MakerWorld-Zuordnung aus + unterdrückt die Upload-Aufgabe).
  const exclCb = el('input', { type: 'checkbox' }); exclCb.checked = !!p.no_upload;
  const exclFee = el('input', { type: 'number', step: '0.5', value: p.no_upload_fee ?? 5, style: 'width:64px' });
  exclFee.disabled = !exclCb.checked;
  exclCb.onchange = () => { p.no_upload = exclCb.checked; exclFee.disabled = !exclCb.checked; applyKind(); drawRes(); persist(); };
  exclFee.oninput = () => { p.no_upload_fee = exclFee.value; drawRes(); persist(); };
  const exclRow = el('div', { class: 'row', style: 'margin:0' },
    el('label', { style: 'display:flex;align-items:center;gap:6px;min-width:96px' }, exclCb, 'Exklusiv'),
    el('span', { class: 'muted', style: 'font-size:11px' }, 'Kunde zahlt für „nicht hochladen":'), exclFee, el('span', { class: 'muted' }, '€'));
  // .3mf-Datei an den Statuslink hängen (nur Modellarbeit) — Kunde kann sie herunterladen
  const fileInfo = el('span', { class: 'muted', style: 'font-size:11px' }, p.file_name || 'keine Datei');
  const fileIn = el('input', { type: 'file', accept: '.3mf', style: 'font-size:11px;max-width:150px' });
  fileIn.onchange = async () => { const f = fileIn.files[0]; if (!f) return;
    if (!/\.3mf$/i.test(f.name)) return toast('Nur .3mf-Dateien.');
    fileInfo.textContent = 'lädt …';
    const data = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
    const r = await jpost('/projects/' + id + '/file', { name: f.name, data });
    if (r.error) { fileInfo.textContent = p.file_name || 'keine Datei'; return toast(r.error); }
    p.file_name = r.file_name; fileInfo.textContent = p.file_name + ' (' + Math.round(r.size / 1024) + ' KB)'; fileIn.value = ''; toast('3mf angehängt'); };
  const fileDel = el('button', { class: 'btn sm ghost', onclick: async () => { await api('/projects/' + id + '/file', { method: 'DELETE' }); p.file_name = null; fileInfo.textContent = 'keine Datei'; toast('Datei entfernt'); } }, 'entfernen');
  const fileRow = el('div', { class: 'row', style: 'margin:0' },
    el('label', { style: 'min-width:96px' }, '3mf-Datei'), fileIn, fileInfo, fileDel,
    el('span', { class: 'muted', style: 'font-size:11px' }, '— zum Download im Statuslink'));
  const artRow = el('div', { class: 'row', style: 'margin:0' }, el('label', { style: 'min-width:96px' }, 'Art'), kindSel,
    el('span', { class: 'muted', style: 'font-size:11px' }, 'nur Modellarbeit = kein Druck (Statuslink ohne Druck-Schritt)'));
  const qtyMarginRow = el('div', { class: 'row' }, el('label', { style: 'min-width:96px' }, 'Stückzahl'), qtyI, el('label', { style: 'min-width:96px' }, 'Margen-Stufe'), tierSel);
  const priceRow = el('div', { class: 'row' }, el('label', { style: 'min-width:96px' }, 'Preis (€)'), priceI, priceHint,
    el('label', { style: 'margin-left:12px;display:flex;align-items:center;gap:6px' }, paidCb, 'bezahlt'));
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Kalkulation'),
    el('div', { class: 'bd' }, artRow, modelRow, mwRow, gInput, phInput, lhInput, qtyMarginRow, priceRow, exclRow, fileRow)));

  // ---- Druckpositionen (mehrere Modelle/Profile mit eigener Stückzahl) ----
  const posHint = el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, '');
  function syncManualInputs(c) {
    const gi = gInput.querySelector('input'), pi = phInput.querySelector('input');
    if (c.hasItems) {
      gi.value = Math.round(c.filamentG); pi.value = +c.printH.toFixed(2);
      gi.disabled = pi.disabled = true; gi.title = pi.title = 'Aus Druckpositionen berechnet';
      posHint.textContent = 'Filament & Druckzeit werden aus den Positionen summiert.';
    } else {
      gi.disabled = pi.disabled = false; gi.title = pi.title = '';
      posHint.textContent = 'Optional: mehrere Profile/Modelle je Projekt (z.B. 2× dasselbe Bett + 1× anderes).';
    }
  }
  const itemsList = el('div');
  const drawItems = () => { itemsList.innerHTML = '';
    if (!items.length) { itemsList.append(el('div', { class: 'muted' }, 'Keine Positionen — es gelten die Felder „Filament/Druckzeit" oben.')); return; }
    items.forEach(it => {
      const qi = el('input', { type: 'number', step: '1', value: it.qty, style: 'width:52px' });
      const wi = el('input', { type: 'number', step: '1', value: it.weight_g ?? '', placeholder: 'g', style: 'width:60px' });
      const ti = el('input', { type: 'number', step: '1', value: it.print_min ?? '', placeholder: 'min', style: 'width:60px' });
      const save = async () => { const r = await jpost('/project-items/' + it.id, { qty: +qi.value || 1, weight_g: wi.value === '' ? null : +wi.value, print_min: ti.value === '' ? null : +ti.value }, 'PUT');
        items = r.items || items; drawItems(); drawRes(); loadOverview(); };
      qi.onchange = wi.onchange = ti.onchange = save;
      itemsList.append(el('div', { class: 'checkline', style: 'gap:6px;flex-wrap:wrap' },
        el('span', { style: 'flex:1;min-width:120px' }, el('b', {}, it.label || it.model_title || 'Position'),
          it.design_id ? el('span', { class: 'muted', style: 'font-size:11px' }, ' · Modell verknüpft') : el('span', { class: 'muted', style: 'font-size:11px' }, ' · eigener Druck')),
        qi, el('span', { class: 'muted', style: 'font-size:11px' }, '× Druck'),
        wi, el('span', { class: 'muted', style: 'font-size:11px' }, 'g'),
        ti, el('span', { class: 'muted', style: 'font-size:11px' }, 'min'),
        el('span', { class: 'num muted', style: 'font-size:11px' }, '= ' + fmt((+it.qty || 0) * (+it.weight_g || 0)) + ' g · ' + fmt1(((+it.qty || 0) * (+it.print_min || 0)) / 60) + ' h'),
        el('button', { class: 'btn sm ghost', onclick: async () => { const r = await api('/project-items/' + it.id, { method: 'DELETE' }); items = r.items || []; drawItems(); drawRes(); loadOverview(); } }, '✕')));
    });
  };
  const posModel = modelSelect();
  const posProfile = el('select', {}, el('option', { value: '' }, '— Profil / Standard —'));
  posModel.onchange = async () => { posProfile.innerHTML = ''; posProfile.append(el('option', { value: '' }, '— Profil / Standard —'));
    (await loadInstances(posModel.value)).forEach(ins => posProfile.append(el('option', { value: ins.instance_id },
      (ins.is_default ? '★ ' : '') + (ins.title || 'Profil') + (ins.weight ? ' · ' + Math.round(ins.weight) + 'g' : '')))); };
  const posQty = el('input', { type: 'number', value: 1, style: 'width:52px' });
  const addPos = async () => {
    const did = posModel.value || null; let label = 'Eigener Druck', weight = null, pmin = null, instId = null;
    if (did) { const insts = await loadInstances(did);
      const ins = posProfile.value ? insts.find(x => x.instance_id === posProfile.value) : (insts.find(x => x.is_default) || insts[0]);
      const mt = (STATE.overview?.models || []).find(m => m.design_id === did)?.title || did;
      if (ins) { instId = ins.instance_id; weight = ins.weight ?? null; pmin = ins.print_min ?? null; label = mt + (ins.title ? ' · ' + ins.title : ''); }
      else label = mt; }
    const r = await jpost('/projects/' + id + '/items', { design_id: did, instance_id: instId, label, qty: +posQty.value || 1, weight_g: weight, print_min: pmin });
    items = r.items || items; posQty.value = 1; drawItems(); drawRes(); loadOverview();
    toast('Position hinzugefügt' + (weight ? ' · ' + Math.round(weight) + ' g/Druck' : ''));
  };
  const posCard = el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Druckpositionen', posHint),
    el('div', { class: 'bd' }, itemsList,
      el('div', { class: 'row', style: 'margin-top:8px;flex-wrap:wrap' }, posModel, posProfile, el('span', { class: 'muted' }, '×'), posQty, el('button', { class: 'btn primary sm', onclick: addPos }, '+ Position'))));
  body.append(posCard);
  drawItems();
  // Sichtbarkeit je nach Projekt-Art: bei "nur Modellarbeit" Druck-Felder ausblenden.
  function applyKind() {
    const self = !!p.self;
    const modelOnly = !self && p.kind === 'modell';   // "nur Modellarbeit": kein Druck (nur Kundenprojekte)
    const showPrint = !modelOnly;
    gInput.style.display = phInput.style.display = fillFromModel.style.display = showPrint ? '' : 'none';
    posCard.style.display = showPrint ? '' : 'none';
    // Kundenspezifisches bei Eigenprojekten komplett ausblenden.
    artRow.style.display = self ? 'none' : '';
    qtyMarginRow.style.display = self ? 'none' : '';
    priceRow.style.display = self ? 'none' : '';
    exclRow.style.display = (!self && modelOnly) ? '' : 'none';
    fileRow.style.display = (!self && modelOnly) ? '' : 'none';
    const exclusive = !!p.no_upload;
    // MakerWorld-Zuordnung: Eigenprojekt immer (Veröffentlichen ist das Ziel);
    // bei Modellarbeit erst nach Fertigstellung; nie bei Exklusiv.
    const showUpload = self ? true : (modelOnly ? (!exclusive && (p.stage === 'fertig' || !!p.design_id)) : true);
    modelRow.style.display = mwRow.style.display = showUpload ? '' : 'none';
    modelLabel.textContent = (self || modelOnly) ? 'MW-Upload' : 'Modell';
  }
  rebuildStages(); applyKind(); drawPath();

  // Teile aus dem Katalog
  const catalog = await api('/parts');
  const plist = el('div');
  const drawParts = () => { plist.innerHTML = ''; if (!parts.length) plist.append(el('div', { class: 'muted' }, 'Keine Teile.'));
    parts.forEach(pp => { const q = el('input', { type: 'number', step: '0.5', value: pp.qty, style: 'width:60px' });
      q.onchange = async () => { const r = await jpost('/project-parts/' + pp.id, { qty: +q.value }, 'PUT'); parts = r.parts || parts; drawParts(); drawRes(); loadOverview(); };
      plist.append(el('div', { class: 'checkline' }, q, el('span', { style: 'flex:1' }, pp.name, el('span', { class: 'muted' }, ' · ' + eur(pp.unit_price) + '/' + (pp.unit || 'Stk'))),
        el('span', { class: 'num' }, eur((pp.qty || 0) * (pp.unit_price || 0))),
        el('button', { class: 'btn sm ghost', onclick: async () => { const r = await api('/project-parts/' + pp.id, { method: 'DELETE' }).then(x => x); parts = r.parts || []; drawParts(); drawRes(); loadOverview(); } }, '✕'))); }); };
  drawParts();
  const partSel = el('select', {}, el('option', { value: '' }, catalog.length ? '— Teil wählen —' : 'Katalog leer → unter „Teile" anlegen'), catalog.map(c => el('option', { value: c.id }, `${c.name} · ${eur(c.unit_price)}`)));
  const partQty = el('input', { type: 'number', step: '0.5', value: 1, style: 'width:60px' });
  const addPart = async () => { if (!partSel.value) return; const r = await jpost('/projects/' + id + '/parts', { part_id: +partSel.value, qty: +partQty.value || 1 }); parts = r.parts || parts; drawParts(); drawRes(); loadOverview(); };
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Einzelteile', el('a', { onclick: () => { closeDrawer(); go('teile'); }, style: 'font-weight:400;text-transform:none;font-size:11px' }, 'Katalog verwalten →')),
    el('div', { class: 'bd' }, plist, el('div', { class: 'row', style: 'margin-top:8px' }, partSel, partQty, el('button', { class: 'btn primary sm', onclick: addPart }, '+ Teil')))));

  // Aufgaben zum Projekt
  const tl = el('ul', { class: 'todolist' });
  const drawTodos = ts => { tl.innerHTML = ''; if (!ts.length) tl.append(el('li', { class: 'muted' }, 'Keine Aufgaben.'));
    ts.forEach(t => tl.append(todoRow(t, async () => { const nd = await api('/project/' + id); drawTodos(nd.todos || []); }))); };
  drawTodos(full.todos || []);
  const tIn = el('input', { placeholder: 'Aufgabe zum Projekt …', style: 'flex:1' });
  const tDue = el('input', { type: 'date' });
  const addT = async () => { if (!tIn.value.trim()) return; await jpost('/todos', { project_id: id, contact_id: p.contact_id, title: tIn.value.trim(), due_date: tDue.value || null }); tIn.value = ''; tDue.value = ''; const nd = await api('/project/' + id); drawTodos(nd.todos || []); loadOverview(); };
  tIn.addEventListener('keydown', e => { if (e.key === 'Enter') addT(); });
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Aufgaben'),
    el('div', { class: 'bd' }, tl, el('div', { class: 'row', style: 'margin-top:8px' }, tIn, tDue, el('button', { class: 'btn primary sm', onclick: addT }, '+')))));

  const actionBtns = [];
  if (!p.self) {   // Beleg + Statuslink nur bei Kundenprojekten
    actionBtns.push(el('button', { class: 'btn sm', onclick: () => openInvoice(id) }, 'Beleg / Rechnung'),
      el('button', { class: 'btn sm', title: 'Read-only Status-Seite zum Verschicken (WhatsApp/Mail)', onclick: async () => {
        const r = await jpost('/crm/projects/' + id + '/share', {});
        const cfg = await api('/settings').catch(() => ({}));
        const base = cfg.public_base_url || location.origin;
        const url = base + '/p/' + r.token;
        if (!cfg.public_base_url) toast('Tipp: öffentliche Adresse unter „Daten & Pull" setzen — sonst nur lokal erreichbar.');
        try { await navigator.clipboard.writeText(url); toast('Statuslink kopiert'); } catch { prompt('Statuslink (kopieren & verschicken):', url); }
        window.open(url, '_blank');
      } }, 'Statuslink'));
  }
  actionBtns.push(el('button', { class: 'btn sm ghost', onclick: async () => { if (!confirm('Projekt löschen?')) return; const cid = p.contact_id; const self = p.self; await api('/projects/' + id, { method: 'DELETE' }); if (self) { closeDrawer(); go('selbst'); } else if (cid) openContact(cid); else closeDrawer(); } }, 'Projekt löschen'));
  body.append(el('div', { class: 'card' }, el('div', { class: 'bd row' }, ...actionBtns)));
  drawRes();
}

// ---- Projekt-Pipeline (Kanban) ----
async function renderProjekte() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Projekte', 'Von der Anfrage bis Fertig. Die Phase „Modellieren" lässt sich überspringen (direkt auf Drucken).');
  const list = await api('/crm/projects');
  const board = el('div', { class: 'board' });
  PROJECT_STAGES.forEach(([sv, sl]) => {
    const members = list.filter(p => (p.stage || 'anfrage') === sv).sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
    const col = el('div', { class: 'col' }, el('div', { class: 'colhd', style: `border-top:3px solid ${PSTAGE_COLOR[sv]}` }, sl, el('span', { class: 'cnt' }, members.length)));
    dndColumn(col, sv, async (id, stage) => { await jpost('/projects/' + id, { stage }, 'PUT'); renderProjekte(); });
    members.forEach(p => { const c = p.calc || {};
      const sel = mkSelect(PROJECT_STAGES, sv, 'sm'); sel.onclick = e => e.stopPropagation();
      sel.onchange = async e => { e.stopPropagation(); await jpost('/projects/' + p.id, { stage: sel.value }, 'PUT'); renderProjekte(); };
      const card = el('div', { class: 'kcard', onclick: () => openProject(p.id) },
        el('div', { class: 'kt' }, p.title),
        el('div', { class: 'krow' }, prioBadge(p.priority), deadlineBadge(p.due_date)),
        el('div', { class: 'muted', style: 'font-size:11px' }, p.contact_name + (p.model_title ? ' · ' + p.model_title : '')),
        el('div', { class: 'muted num', style: 'font-size:11px' }, c.free ? 'gratis · Verlust ' + eur(c.loss) : `${eur(c.price)} · Kosten ${eur(c.cost)}`), sel);
      dndCard(card, p.id);
      col.append(card);
    });
    if (!members.length) col.append(el('div', { class: 'muted', style: 'padding:8px' }, '—'));
    board.append(col);
  });
  w.append(board);
}

// ---- Eigenprojekte (kein Kunde): Modellieren → Drucken → Fotos → MW-Eintrag → Veröffentlicht ----
async function renderSelfProjects() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Eigenprojekte', 'Eigene Produkte planen: modellieren, drucken, fotografieren, MakerWorld-Eintrag erstellen und veröffentlichen. Ohne Kunde.');
  const nameI = el('input', { placeholder: 'Neues Eigenprojekt …', style: 'flex:1;min-width:160px' });
  const prioI = mkSelect(PRIORITIES, '1', 'sm'); const dueI = el('input', { type: 'date' });
  const add = async () => { if (!nameI.value.trim()) return; const np = await jpost('/projects', { self: 1, title: nameI.value.trim(), priority: +prioI.value, due_date: dueI.value || null }); nameI.value = ''; dueI.value = ''; openProject(np.id); };
  nameI.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  w.append(el('div', { class: 'toolbar' }, nameI, el('span', { class: 'muted', style: 'font-size:11px' }, 'Prio'), prioI, el('span', { class: 'muted', style: 'font-size:11px' }, 'Deadline'), dueI, el('button', { class: 'btn primary sm', onclick: add }, '+ Eigenprojekt')));
  const list = await api('/crm/self-projects');
  const cols = SELF_STAGES.filter(s => s[0] !== 'abgebrochen');
  const board = el('div', { class: 'board' });
  cols.forEach(([sv, sl]) => {
    const members = list.filter(p => (p.stage || 'idee') === sv).sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
    const col = el('div', { class: 'col' }, el('div', { class: 'colhd', style: `border-top:3px solid ${SSTAGE_COLOR[sv]}` }, sl, el('span', { class: 'cnt' }, members.length)));
    dndColumn(col, sv, async (id, stage) => { await jpost('/projects/' + id, { stage }, 'PUT'); renderSelfProjects(); });
    members.forEach(p => { const c = p.calc || {};
      const sel = mkSelect(SELF_STAGES, sv, 'sm'); sel.onclick = e => e.stopPropagation();
      sel.onchange = async e => { e.stopPropagation(); await jpost('/projects/' + p.id, { stage: sel.value }, 'PUT'); renderSelfProjects(); };
      const card = el('div', { class: 'kcard', onclick: () => openProject(p.id) },
        el('div', { class: 'kt' }, p.title),
        el('div', { class: 'krow' }, prioBadge(p.priority), deadlineBadge(p.due_date)),
        el('div', { class: 'muted', style: 'font-size:11px' }, (p.model_title ? p.model_title + ' · ' : '') + 'Kosten ' + eur(c.cost) + (p.mw && p.mw.earned ? ' · MW ' + eur(p.mw.earned) : '')), sel);
      dndCard(card, p.id);
      col.append(card);
    });
    if (!members.length) col.append(el('div', { class: 'muted', style: 'padding:8px' }, '—'));
    board.append(col);
  });
  w.append(board);
}

// ---- Teile-Katalog + Kalkulations-Einstellungen ----
async function renderParts() {
  const w = pagehead('Teile & Kalkulation', 'Bauteil-Katalog und globale Kalkulationsparameter für die Preisbildung.');
  const s = await api('/crm/settings');
  // Kalkulations-Einstellungen
  const fI = el('input', { type: 'number', step: '0.5', value: s.filament_price_kg, style: 'width:80px' });
  const eI = el('input', { type: 'number', step: '0.01', value: s.energy_rate_h, style: 'width:80px' });
  const lI = el('input', { type: 'number', step: '0.5', value: s.labor_rate_h, style: 'width:80px' });
  const rI = mkSelect([['0.5','auf 0,50 €'],['1','auf 1,00 €'],['0','keine Rundung']], String(s.round_to));
  const tierWrap = el('div');
  let tiers = JSON.parse(JSON.stringify(s.tiers || []));
  const drawTiers = () => { tierWrap.innerHTML = '';
    tiers.forEach((t, i) => { const nm = el('input', { value: t.name, placeholder: 'Name', style: 'width:140px' });
      const mg = el('input', { type: 'number', step: '5', value: Math.round(t.margin * 100), style: 'width:70px' });
      nm.oninput = () => t.name = nm.value; mg.oninput = () => t.margin = (+mg.value || 0) / 100;
      tierWrap.append(el('div', { class: 'row', style: 'margin:2px 0' }, nm, mg, el('span', { class: 'muted' }, '% Marge'),
        el('button', { class: 'btn sm ghost', onclick: () => { tiers.splice(i, 1); drawTiers(); } }, '✕'))); });
    tierWrap.append(el('button', { class: 'btn sm', onclick: () => { tiers.push({ name: 'Neu', margin: 0.5 }); drawTiers(); } }, '+ Stufe')); };
  drawTiers();
  const saveSettings = async () => { await jpost('/crm/settings', { filament_price_kg: +fI.value, energy_rate_h: +eI.value, labor_rate_h: +lI.value, round_to: +rI.value, tiers }); toast('Kalkulation gespeichert.'); };
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Kalkulations-Parameter'),
    el('div', { class: 'bd' },
      el('div', { class: 'row' }, el('label', { style: 'min-width:150px' }, 'Filamentpreis (€/kg)'), fI,
        el('label', { style: 'min-width:130px;margin-left:16px' }, 'Strom/Verschleiß (€/h)'), eI),
      el('div', { class: 'row' }, el('label', { style: 'min-width:150px' }, 'Arbeitslohn (€/h)'), lI,
        el('label', { style: 'min-width:130px;margin-left:16px' }, 'Preis runden'), rI),
      el('div', { style: 'margin-top:10px' }, el('label', { class: 'muted' }, 'Margen-Stufen (eine für Freunde niedriger):'), tierWrap),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn primary sm', onclick: saveSettings }, 'Speichern')))));

  // Teile-Katalog
  const parts = await api('/parts');
  const nName = el('input', { placeholder: 'Teil (z.B. Neodym-Magnet 8×3)', style: 'flex:1;min-width:180px' });
  const nCat = mkSelect(PART_CATEGORIES, 'magnet'); const nUnit = el('input', { value: 'Stk', style: 'width:60px' });
  const nPrice = el('input', { type: 'number', step: '0.01', placeholder: '€/Einheit', style: 'width:90px' });
  const addPart = async () => { if (!nName.value.trim()) return; await jpost('/parts', { name: nName.value.trim(), category: nCat.value, unit: nUnit.value, unit_price: +nPrice.value || 0 }); nName.value = ''; nPrice.value = ''; renderParts(); };
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Teile-Katalog (${parts.length})`),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, nName, nCat, nUnit, nPrice, el('button', { class: 'btn primary sm', onclick: addPart }, '+ Teil')))));
  if (parts.length) {
    const wrap = el('div', { class: 'tablewrap' }); w.append(wrap);
    wrap.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Teil'), el('th', {}, 'Kategorie'), el('th', {}, 'Einheit'), el('th', { class: 'n' }, 'Preis'), el('th', {}, ''))),
      el('tbody', {}, parts.map(pt => { const pr = el('input', { type: 'number', step: '0.01', value: pt.unit_price, style: 'width:80px' });
        pr.onchange = () => jpost('/parts/' + pt.id, { unit_price: +pr.value }, 'PUT').then(() => toast('Preis aktualisiert.'));
        return el('tr', {}, el('td', { class: 'title' }, pt.name), el('td', {}, labelOf(PART_CATEGORIES, pt.category)), el('td', {}, pt.unit),
          el('td', { class: 'n' }, pr), el('td', {}, el('button', { class: 'btn sm ghost', onclick: async () => { await api('/parts/' + pt.id, { method: 'DELETE' }); renderParts(); } }, '✕'))); }))));
  }
}

// ============ DATEN & PULL ============
// ---- Druckplan (offene Druckpositionen über alle Projekte) ----
async function renderDruckplan() {
  const w = pagehead('Druckplan', 'Alle offenen Druckpositionen über alle Projekte — was als Nächstes zu drucken ist. Nutzt die Druckpositionen der Projekte.');
  const d = await api('/crm/production');
  const sp = await api('/spools');
  const stat = (v, l, cls, dd) => el('div', { class: 'stat' }, el('div', { class: 'v ' + (cls || '') }, v), el('div', { class: 'l' }, l), dd ? el('div', { class: 'd muted' }, dd) : null);
  w.append(el('div', { class: 'stats' },
    stat(fmt(d.summary.prints), 'Drucke offen'),
    stat(fmt(d.summary.jobs), 'Positionen'),
    stat(fmt(d.summary.g) + ' g', 'Filament nötig', d.enoughStock ? '' : 'neg'),
    stat(fmt1(d.summary.h) + ' h', 'Druckzeit gesamt'),
    stat(fmt(d.stockG) + ' g', 'Lagerbestand', d.enoughStock ? 'pos' : 'neg', d.enoughStock ? 'reicht' : 'zu wenig')));
  if (!d.jobs.length) { w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Keine offenen Drucke'), el('div', { class: 'bd muted' }, 'Alles gedruckt — oder es sind noch keine Druckpositionen in Projekten angelegt (Projekt öffnen → „Druckpositionen").'))); return; }
  const wrap = el('div', { class: 'tablewrap' });
  const tb = el('table', {}, el('thead', {}, el('tr', {}, ['Projekt', 'Position', 'offen', 'g/Druck', 'Zeit/Druck', 'Σ Filament', 'Spule abbuchen', '', ''].map((h, i) => el('th', { class: (i > 1 && i < 6) ? 'n' : '' }, h)))));
  const body = el('tbody', {}); tb.append(body);
  d.jobs.forEach(j => {
    const spoolSel = el('select', {}, el('option', { value: '' }, 'ohne Abbuchung'),
      ...sp.spools.map(s => el('option', { value: s.id }, `${s.material} ${s.color} · ${Math.round(s.remaining_g)}g`)));
    body.append(el('tr', {},
      el('td', { class: 'title', style: 'cursor:pointer', onclick: () => openProject(j.project_id) }, j.project_title, el('span', { class: 'muted' }, ' · ' + j.contact_name)),
      el('td', {}, j.label || j.model_title || 'Position', j.need_ams ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'AMS') : null),
      el('td', { class: 'n' }, `${j.remaining}/${j.qty}`),
      el('td', { class: 'n' }, j.weight_g ? fmt(j.weight_g) + ' g' : '–'),
      el('td', { class: 'n' }, j.print_min ? fmt1(j.print_min / 60) + ' h' : '–'),
      el('td', { class: 'n' }, fmt(j.g_total) + ' g'),
      el('td', {}, spoolSel),
      el('td', {}, el('button', { class: 'btn sm primary', onclick: async () => {
        const r = await jpost('/crm/production/print', { item_id: j.id, spool_id: spoolSel.value || null });
        toast('Druck verbucht' + (r.spool ? ` · ${Math.round(r.spool.remaining_g)} g Rest auf Spule` : '')); renderDruckplan();
      } }, '✓ gedruckt')),
      el('td', {}, el('button', { class: 'btn sm ghost', title: 'Zurücknehmen', onclick: async () => { await jpost('/crm/production/unprint', { item_id: j.id }); renderDruckplan(); } }, '−'))));
  });
  wrap.append(tb);
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Offene Drucke', el('a', { onclick: () => go('material'), style: 'font-weight:400;text-transform:none;font-size:11px' }, 'Filament-Lager →')), wrap));
}

// ---- Filament-Lager (Spulen) ----
async function renderMaterial() {
  const w = pagehead('Filament-Lager', 'Spulen mit Restgewicht. Beim Verbuchen eines Drucks im Druckplan wird automatisch abgebucht.');
  const d = await api('/spools');
  const totRem = d.spools.reduce((a, s) => a + (s.remaining_g || 0), 0);
  const low = d.spools.filter(s => (s.remaining_g || 0) <= d.low_g);
  w.append(el('div', { class: 'stats' },
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(d.spools.length)), el('div', { class: 'l' }, 'Spulen')),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(Math.round(totRem)) + ' g'), el('div', { class: 'l' }, 'Rest gesamt'), el('div', { class: 'd muted' }, fmt1(totRem / 1000) + ' kg')),
    el('div', { class: 'stat' }, el('div', { class: 'v ' + (low.length ? 'neg' : 'pos') }, fmt(low.length)), el('div', { class: 'l' }, 'niedrig'), el('div', { class: 'd muted' }, '≤ ' + d.low_g + ' g'))));
  const list = el('div');
  const draw = () => { list.innerHTML = ''; if (!d.spools.length) list.append(el('div', { class: 'muted' }, 'Noch keine Spulen erfasst. Unten eine Spule anlegen.'));
    d.spools.forEach(s => {
      const pctv = s.total_g ? Math.max(0, Math.min(100, Math.round((s.remaining_g / s.total_g) * 100))) : 0;
      const isLow = (s.remaining_g || 0) <= d.low_g;
      const remI = el('input', { type: 'number', value: Math.round(s.remaining_g || 0), style: 'width:74px' });
      remI.onchange = async () => { await jpost('/spools/' + s.id, { remaining_g: +remI.value }, 'PUT'); s.remaining_g = +remI.value; draw(); };
      list.append(el('div', { class: 'checkline', style: 'gap:10px;flex-wrap:wrap' + (isLow ? ';background:rgba(193,51,45,.06)' : '') },
        el('span', { style: `width:16px;height:16px;border-radius:50%;border:1px solid #bbb;background:${s.hex || '#ddd'}` }),
        el('span', { style: 'min-width:150px;flex:1' }, el('b', {}, s.material + ' · ' + s.color), s.brand ? el('span', { class: 'muted' }, ' · ' + s.brand) : null,
          isLow ? el('span', { class: 'tag', style: 'background:var(--neg);margin-left:6px' }, 'niedrig') : null),
        el('div', { class: 'goalbar', style: 'width:120px' }, el('i', { style: `width:${pctv}%;background:${isLow ? 'var(--neg)' : 'var(--pos)'}` }), el('span', {}, pctv + '%')),
        remI, el('span', { class: 'muted', style: 'font-size:11px' }, '/ ' + Math.round(s.total_g || 0) + ' g'),
        el('button', { class: 'btn sm ghost', onclick: async () => { if (!confirm('Spule „' + s.material + ' ' + s.color + '" löschen?')) return; await api('/spools/' + s.id, { method: 'DELETE' }); renderMaterial(); } }, '✕')));
    }); };
  draw();
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Bestand', el('a', { onclick: () => go('druckplan'), style: 'font-weight:400;text-transform:none;font-size:11px' }, '← Druckplan')), el('div', { class: 'bd' }, list)));
  // Neue Spule
  const mat = mkSelect([['PLA', 'PLA'], ['PETG', 'PETG'], ['ABS', 'ABS'], ['ASA', 'ASA'], ['TPU', 'TPU'], ['PLA-CF', 'PLA-CF'], ['Sonstiges', 'Sonstiges']], 'PLA');
  const col = el('input', { placeholder: 'Farbe (z.B. Schwarz)', style: 'flex:1;min-width:120px' });
  const hex = el('input', { type: 'color', value: '#222222', style: 'width:40px;padding:0' });
  const brand = el('input', { placeholder: 'Marke', style: 'width:110px' });
  const tot = el('input', { type: 'number', value: 1000, style: 'width:80px' });
  const cost = el('input', { type: 'number', step: '0.01', placeholder: '€', style: 'width:70px' });
  const add = async () => { if (!col.value.trim()) return toast('Farbe angeben.');
    await jpost('/spools', { material: mat.value, color: col.value.trim(), hex: hex.value, brand: brand.value || null, total_g: +tot.value || 1000, remaining_g: +tot.value || 1000, cost: +cost.value || 0 });
    renderMaterial(); };
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Spule hinzufügen'),
    el('div', { class: 'bd' }, el('div', { class: 'row', style: 'flex-wrap:wrap' }, mat, col, hex, brand, tot, el('span', { class: 'muted' }, 'g'), cost, el('span', { class: 'muted' }, '€'), el('button', { class: 'btn primary sm', onclick: add }, '+ Spule')))));
}

async function renderData() {
  const s = await api('/settings');
  const login = await api('/login/status').catch(() => ({ error: 'x' }));
  const w = pagehead('Daten & Pull', 'Datenabruf, Zeitplanung und Import.');
  // Sprache / Language
  const langSel = mkSelect([['de', 'Deutsch'], ['en', 'English']], LANG.cur);
  langSel.onchange = () => setLang(langSel.value);
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Sprache / Language'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, el('label', { style: 'min-width:150px' }, 'Sprache'), langSel,
      el('span', { class: 'muted', style: 'font-size:11px' }, 'Umschalten zwischen Deutsch (Fachbegriffe) und Englisch.')))));
  const loginBadge = login.loggedIn ? el('span', { class: 'tag ok' }, 'eingeloggt' + (login.handle ? ' @' + login.handle : '')) : el('span', { class: 'tag err' }, 'nicht eingeloggt');
  const loginLog = el('div', { class: 'log', style: 'display:none' });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '1) MakerWorld-Login', loginBadge),
    el('div', { class: 'bd' }, el('p', { class: 'muted' }, 'Öffnet ein echtes Chrome-Fenster. Oben rechts „Sign In", normal anmelden (Passkey funktioniert). Login wird gespeichert.'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async e => { e.target.disabled = true; loginLog.style.display = 'block'; loginLog.textContent = 'Öffne Fenster …';
        await api('/login/start', { method: 'POST' });
        const iv = setInterval(async () => { const p = await api('/login/progress'); loginLog.textContent = p.log.join('\n'); if (!p.running) { clearInterval(iv); e.target.disabled = false; renderData(); } }, 1500); } }, 'Login-Fenster öffnen')), loginLog)));

  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '2) Live-Pull'),
    el('div', { class: 'bd' }, el('p', { class: 'muted' }, 'Zieht Analytics + Beschreibung, Tags, Kommentare, Sammlungen und Bilder. Läuft in sichtbarem Chrome (off-screen).'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: triggerPull }, 'Jetzt ziehen')), el('div', { id: 'pullLog', class: 'log', style: 'display:none' }))));

  const timeI = el('input', { type: 'time', value: s.schedule_time });
  const enI = el('input', { type: 'checkbox' }); enI.checked = s.schedule_enabled;
  const startI = el('input', { type: 'date', value: s.start_date });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '3) Automatischer Tages-Pull'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, enI, el('span', {}, 'aktiv, täglich um'), timeI, el('label', { style: 'margin-left:12px' }, 'Historie ab'), startI,
      el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { schedule_time: timeI.value, schedule_enabled: enI.checked, start_date: startI.value }); toast('Gespeichert.'); } }, 'Speichern')),
      el('p', { class: 'muted' }, 'Läuft solange der Server läuft. Auf dem Pi als Dienst dauerhaft.'))));

  // Digest / Benachrichtigung
  const notifyI = el('input', { value: s.notify_url || '', placeholder: 'z.B. https://ntfy.sh/mein-geheimes-thema', style: 'flex:1;min-width:220px' });
  const dg = await api('/digest');
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '4) Täglicher Digest / Benachrichtigung'),
    el('div', { class: 'bd' },
      el('p', { class: 'muted' }, 'Nach jedem Pull wird eine Zusammenfassung erstellt. Für Push aufs Handy eine ntfy.sh-Themen-URL (App „ntfy" installieren, Thema abonnieren) oder einen eigenen Webhook eintragen — leer = nur hier anzeigen.'),
      el('div', { class: 'row' }, el('label', { style: 'min-width:110px' }, 'Push-URL'), notifyI,
        el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { notify_url: notifyI.value }); toast('Gespeichert.'); } }, 'Speichern'),
        el('button', { class: 'btn ghost', onclick: async () => { const r = await api('/digest/send', { method: 'POST' }); toast('Digest gesendet.'); } }, 'Jetzt senden')),
      el('div', { class: 'log', style: 'margin-top:8px' }, dg.current))));

  // Wochen-Report (Insights) + Meilensteine
  const wkEn = el('input', { type: 'checkbox' }); wkEn.checked = s.weekly_enabled;
  const wkDay = el('select', {}, [[1, 'Montag'], [2, 'Dienstag'], [3, 'Mittwoch'], [4, 'Donnerstag'], [5, 'Freitag'], [6, 'Samstag'], [0, 'Sonntag']].map(([v, l]) => el('option', { value: v }, l)));
  wkDay.value = String(s.weekly_day ?? 1);
  const wkTime = el('input', { type: 'time', value: s.weekly_time || '08:00' });
  const lowI = el('input', { type: 'number', value: s.spool_low_g ?? 150, style: 'width:80px' });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '5) Wochen-Report & Alerts'),
    el('div', { class: 'bd' },
      el('p', { class: 'muted' }, 'Wöchentliche Insights (Zugpferd, CTR-Chancen, Gutschein-Prognose, stärkste Tags) als Push. Meilensteine (1000 Downloads, Gutschein-Schwelle, „kalt gewordene" Modelle) werden nach jedem Pull automatisch gepusht.'),
      el('div', { class: 'row' }, wkEn, el('span', {}, 'Wochen-Report aktiv —'), wkDay, el('span', {}, 'um'), wkTime,
        el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { weekly_enabled: wkEn.checked, weekly_day: +wkDay.value, weekly_time: wkTime.value }); toast('Gespeichert.'); } }, 'Speichern'),
        el('button', { class: 'btn ghost', onclick: async () => { const r = await api('/insights/send', { method: 'POST' }); toast(r.sent ? 'Wochen-Report gesendet.' : 'Erstellt (keine Push-URL — Vorschau unten).'); } }, 'Jetzt senden')),
      el('div', { class: 'row' }, el('label', { style: 'min-width:180px' }, 'Filament-Warnung ab (g)'), lowI,
        el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { spool_low_g: +lowI.value }); toast('Gespeichert.'); } }, 'Speichern')))));

  // Öffentlicher Statuslink (Basis-Adresse für verschickte Links)
  const pubI = el('input', { value: s.public_base_url || '', placeholder: 'z.B. https://dein-host.dein-tailnet.ts.net:8443', style: 'flex:1;min-width:260px' });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '6) Öffentlicher Statuslink'),
    el('div', { class: 'bd' },
      el('p', { class: 'muted' }, 'Adresse, unter der die Auftrags-Statusseite von außen erreichbar ist (nur die Statusseite, nicht das Dashboard). Wird für die „Statuslink"-Buttons verwendet. Leer = nur lokal.'),
      el('div', { class: 'row' }, el('label', { style: 'min-width:110px' }, 'Basis-URL'), pubI,
        el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { public_base_url: pubI.value }); toast('Gespeichert.'); } }, 'Speichern')))));

  // Punkte-Wert (Verdienst-Umrechnung)
  const curRate = s.eur_per_point || (40 / 524);
  const ptsI = el('input', { type: 'number', value: 524, style: 'width:90px' });
  const eurI = el('input', { type: 'number', step: '0.01', value: (524 * curRate).toFixed(2), style: 'width:90px' });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Punkte-Wert (Verdienst)'),
    el('div', { class: 'bd' }, el('p', { class: 'muted' }, `Wie viel € ergibt eine Menge Punkte? Aktuell: ${eur(curRate)} pro Punkt.`),
      el('div', { class: 'row' }, ptsI, el('span', {}, 'Punkte ='), eurI, el('span', {}, '€'),
        el('button', { class: 'btn', onclick: async () => {
          const p = +ptsI.value, e = +eurI.value;
          if (!(p > 0) || !(e > 0)) return toast('Bitte gültige Werte.');
          await jpost('/settings', { eur_per_point: e / p }); STATE.overview = null; await loadOverview();
          toast(`Gespeichert: ${eur(e / p)} pro Punkt`); renderData();
        } }, 'Speichern')))));

  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Alt-Export importieren'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async e => { e.target.disabled = true; const r = await jpost('/import', {}); e.target.disabled = false; toast(r.ok ? `Import: ${r.models} Modelle, ${r.daily} Tageszeilen` : 'Fehler: ' + r.error); STATE.overview = null; } }, 'Standard-Export importieren')))));
}

async function triggerPull() { const box = $('#pullLog'); if (box) { box.style.display = 'block'; box.textContent = 'starte …'; } const r = await api('/pull/start', { method: 'POST' }); if (!r.started) toast(r.reason || 'läuft schon'); pollPull(); }

// ---- Pull-Status ----
let pollTimer = null, wasRunning = false;
async function pollPull() {
  const st = await api('/pull/status');
  const side = $('#pullStatus'), btn = $('#pullBtn'), box = $('#pullLog');
  if (st.running) { wasRunning = true; btn.disabled = true; btn.textContent = t('Pull läuft …'); side.textContent = st.log.slice(-4).join('\n'); if (box) box.textContent = st.log.join('\n'); if (!pollTimer) pollTimer = setInterval(pollPull, 1500); }
  else { btn.disabled = false; btn.textContent = t('Live-Pull starten'); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (st.lastResult) side.textContent = st.lastResult.ok ? `✓ ${st.lastResult.ok} ${t('Modelle aktualisiert')}` : ('✗ ' + st.lastResult.error);
    if (box && st.log.length) box.textContent = st.log.join('\n');
    if (wasRunning) { wasRunning = false; await loadOverview(); const cur = location.hash.slice(1) || 'overview'; if (routes[cur]) go(cur); } else renderLastPull();
  }
}
$('#pullBtn').addEventListener('click', triggerPull);
function renderLastPull() { const lp = STATE.overview?.lastPull; $('#lastPull').textContent = lp ? `${t('Pull')} ${nice(lp.finished_at || lp.started_at)}\n${lp.status} · ${lp.models_ok ?? 0}/${(lp.models_ok ?? 0) + (lp.models_failed ?? 0)}` : t('Kein Pull'); }

// ---- Helpers ----
function chartOpts() {
  return { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#1a1c1f', boxWidth: 10, font: { size: 11 } } }, tooltip: { backgroundColor: '#fff', titleColor: '#1a1c1f', bodyColor: '#1a1c1f', borderColor: '#c3c7cc', borderWidth: 1 } },
    scales: { x: { type: 'category', ticks: { color: '#5b6169', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: '#e3e5e8' } }, y: { ticks: { color: '#5b6169', font: { size: 10 } }, grid: { color: '#e3e5e8' } } } };
}
function toast(msg) { const t = el('div', { style: 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1a1c1f;color:#fff;border:1px solid #000;padding:8px 16px;z-index:99;font-size:12px' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }

// ---- Wörterbuch Deutsch -> Englisch (Quelle im Code ist Deutsch) ----------
const TR = {
  // Seitentitel
  'Übersicht': 'Overview', 'Momentum': 'Momentum', 'Vergleich': 'Comparison', 'Kategorien & Gruppen': 'Categories & Groups',
  'Punkte-Ökonomie': 'Points Economy', 'Bericht': 'Report', 'Aufgaben': 'Tasks', 'Pipeline': 'Pipeline',
  'Änderungs-Historie': 'Change History', 'Heute': 'Today', 'Kunden': 'Customers', 'Leads': 'Leads',
  'Finanzen': 'Finance', 'Projekte': 'Projects', 'Teile & Kalkulation': 'Parts & Costing', 'Druckplan': 'Print Queue',
  'Filament-Lager': 'Filament Stock', 'Daten & Pull': 'Data & Sync', 'Produkte': 'Products', 'Kategorien': 'Categories', 'Punkte': 'Points',
  // Untertitel
  'Was gerade läuft — 7/30-Tage-Aktivität, Trend gegenüber Vorwoche.': 'Current activity — 7/30-day performance, trend vs. previous week.',
  'Modelle überlagern — nach Datum oder nach Alter seit Release.': 'Overlay models — by date or by age since release.',
  'Aggregierte Leistung nach Kategorie, Tag oder eigener Gruppe.': 'Aggregated performance by category, tag or custom group.',
  'Echter Kontostand, Punkte über die Zeit und je Modell. Punkte = Basis der Auszahlung.': 'Actual balance, points over time and per model. Points are the payout basis.',
  'Wochenrückblick — Bewegung der letzten 7 Tage, Prognose und offene Punkte.': 'Weekly review — last 7 days, forecast and open items.',
  'Aufgaben je Modell und global — zentral gebündelt.': 'Tasks per model and global — in one place.',
  'Von der Idee bis Archiviert. Geplante Produkte werden beim Pull automatisch mit dem echten Modell verschmolzen (Titel-Abgleich).': 'From idea to archived. Planned products merge with the real model on sync (title match).',
  'Alle erfassten Upload-Änderungen chronologisch. Einträge pro Modell im Detail.': 'All recorded upload changes in chronological order. Per-model detail.',
  'Tagesübersicht: offene Zahlungen, fällige Aufgaben, Hinweise und Änderungen.': 'Daily overview: open payments, due tasks, alerts and changes.',
  'Kontakte, Projekte und Aufträge im CRM.': 'Contacts, projects and orders in the CRM.',
  'Pipeline von Neu bis Gewonnen/Verloren — Stufe je Karte änderbar.': 'Pipeline from New to Won/Lost — stage editable per card.',
  'Umsatz aus Projekten, MakerWorld-Auszahlungen, Ausgaben und Gewinn/Verlust.': 'Revenue from projects, MakerWorld payouts, expenses and profit/loss.',
  'Von der Anfrage bis Fertig. Die Phase „Modellieren" lässt sich überspringen (direkt auf Drucken).': 'From request to done. The "Modeling" stage can be skipped (straight to printing).',
  'Bauteil-Katalog und globale Kalkulationsparameter für die Preisbildung.': 'Parts catalog and global costing parameters for pricing.',
  'Alle offenen Druckpositionen über alle Projekte — was als Nächstes zu drucken ist. Nutzt die Druckpositionen der Projekte.': 'All open print items across projects — what to print next. Uses the projects\' print items.',
  'Spulen mit Restgewicht. Beim Verbuchen eines Drucks im Druckplan wird automatisch abgebucht.': 'Spools with remaining weight. Booking a print in the queue deducts automatically.',
  'Datenabruf, Zeitplanung und Import.': 'Data sync, scheduling and import.',
  // Navigation / Sidebar
  'Analyse': 'Analysis', 'CRM': 'CRM', 'Produktion': 'Production', 'System': 'System',
  'Suche (Modelle, Kunden, Projekte)': 'Search (models, customers, projects)',
  'Live-Pull starten': 'Start live sync', 'Pull läuft …': 'Sync running …', 'Kein Pull': 'No sync yet', 'Pull': 'Sync', 'Modelle aktualisiert': 'models updated',
  // Status / Phasen / Quellen / Kategorien
  'Idee': 'Idea', 'In Arbeit': 'In progress', 'Live': 'Live', 'Update geplant': 'Update planned', 'Archiviert': 'Archived',
  'Neu': 'New', 'Kontaktiert': 'Contacted', 'Angebot': 'Quote', 'Gewonnen': 'Won', 'Verloren': 'Lost',
  'Freund': 'Friend', 'Empfehlung': 'Referral', 'Manuell': 'Manual',
  'Anfrage': 'Request', 'Modellieren': 'Modeling', 'Drucken': 'Printing', 'Fertig': 'Done', 'Abgebrochen': 'Cancelled',
  'Angefragt': 'Requested', 'Bestätigt': 'Confirmed', 'Versendet': 'Shipped', 'Bezahlt': 'Paid', 'Storniert': 'Cancelled', 'Offen': 'Open',
  'Magnet': 'Magnet', 'Schraube': 'Screw', 'Metallteil': 'Metal part', 'Elektronik': 'Electronics', 'Sonstiges': 'Other',
  'Filament': 'Filament', 'Drucker': 'Printer', 'Zubehör': 'Accessories', 'Versand': 'Shipping',
  'Standard': 'Standard', 'Freunde': 'Friends', 'Kostenlos (nur Material)': 'Free (material only)',
  'nur Modellarbeit': 'Modeling only', 'Modell + Druck': 'Model + Print',
  'Gesammelt': 'Collected', 'Drucke': 'Prints',
  // Wochentage
  'Montag': 'Monday', 'Dienstag': 'Tuesday', 'Mittwoch': 'Wednesday', 'Donnerstag': 'Thursday', 'Freitag': 'Friday', 'Samstag': 'Saturday', 'Sonntag': 'Sunday',
  // Karten-Überschriften
  'Insights': 'Insights', 'Meilensteine': 'Milestones', 'Alerts': 'Alerts', 'Kalkulation': 'Costing', 'Druckpositionen': 'Print items',
  'Einzelteile': 'Parts', 'Stammdaten': 'Master data', 'Aufgaben / Follow-ups': 'Tasks / follow-ups', 'Ziele & Gruppe': 'Goals & group',
  'Notizen': 'Notes', 'Verlauf': 'Trend', 'Prognose (Trend, letzte 90 Tage)': 'Forecast (trend, last 90 days)', 'Beschreibung': 'Description',
  'Quelle des Datenverkehrs': 'Traffic source', 'Wirkung von Änderungen (CTR ±21 Tage)': 'Effect of changes (CTR ±21 days)',
  'Kalkulations-Parameter': 'Costing parameters', 'Bestand': 'Stock', 'Spule hinzufügen': 'Add spool', 'Offene Drucke': 'Open prints',
  'Gewinn & Verlust': 'Profit & Loss', 'Ausgaben': 'Expenses', 'Punkte-Auszahlungen (Gutscheine)': 'Point payouts (vouchers)',
  'Rechnungs-Absender (für Belege)': 'Invoice sender (for documents)', 'Punkte-Wert (Verdienst)': 'Point value (earnings)',
  'Monatsumsatz (bezahlt)': 'Monthly revenue (paid)', 'Nach Quelle': 'By source', 'Top-Kunden': 'Top customers', 'Umsatz je Modell': 'Revenue per model',
  'Projekte → MakerWorld-Ertrag': 'Projects → MakerWorld earnings', 'Gratis-Projekte, die auf MakerWorld verdienen': 'Free projects earning on MakerWorld',
  'Sprache / Language': 'Language', 'Sprache': 'Language', 'Automatischer Tages-Pull': 'Automatic daily sync',
  'Täglicher Digest / Benachrichtigung': 'Daily digest / notification', 'Wochen-Report & Alerts': 'Weekly report & alerts',
  'Öffentlicher Statuslink': 'Public status link', 'Alt-Export importieren': 'Import legacy export', 'Keine Aufgaben.': 'No tasks.',
  // Kennzahlen / Stat-Labels
  'Material (Sach)': 'Material (cash)', 'Preis': 'Price', 'Gewinn direkt': 'Direct profit', 'MakerWorld-Ertrag': 'MakerWorld earnings',
  'Gesamtbilanz': 'Total result', 'Preisvorschlag': 'Suggested price', 'Verlust': 'Loss', 'Materialkosten': 'Material cost',
  'Direkteinnahmen': 'Direct revenue', 'Umsatz bezahlt': 'Revenue (paid)', 'offen (Pipeline)': 'open (pipeline)', 'gesamt': 'total',
  'Kontakte': 'Contacts', 'Drucke offen': 'Prints open', 'Positionen': 'Items', 'Filament nötig': 'Filament needed',
  'Druckzeit gesamt': 'Total print time', 'Lagerbestand': 'Stock', 'Spulen': 'Spools', 'Rest gesamt': 'Remaining total', 'niedrig': 'low',
  'Einnahmen (Projekte)': 'Revenue (projects)', 'MakerWorld-Auszahlungen': 'MakerWorld payouts', 'Netto-Gewinn': 'Net profit',
  'Punkte offen': 'Points open', 'Verlust (Gratis)': 'Loss (free)', 'aus verknüpften Modellen': 'from linked models',
  'direkt + MakerWorld': 'direct + MakerWorld', 'direkt − Material + MW': 'direct − material + MW', 'noch nicht ausgezahlt': 'not yet paid out',
  // Spalten
  'Name': 'Name', 'Quelle': 'Source', 'Stufe': 'Stage', 'Best.': 'Ord.', 'Umsatz': 'Revenue', 'bezahlt': 'paid', 'letzte Best.': 'last order',
  'Datum': 'Date', 'Kategorie': 'Category', 'Betrag': 'Amount', 'Notiz': 'Note', 'Menge': 'Qty', 'Position': 'Item', 'Modell': 'Model',
  'Kunde': 'Customer', 'Proj.': 'Proj.', 'Einheit': 'Unit', 'Marke': 'Brand', 'Farbe': 'Color', 'MakerWorld €': 'MakerWorld €', 'netto': 'net',
  // Buttons
  'Speichern': 'Save', 'Beleg / Rechnung': 'Receipt / Invoice', 'Statuslink': 'Status link', 'Projekt löschen': 'Delete project',
  'Kunde löschen': 'Delete customer', 'Vorschlag': 'Suggest', '+ Position': '+ Item', '+ Teil': '+ Part', '+ Projekt': '+ Project',
  '+ Ausgabe': '+ Expense', '+ Auszahlung': '+ Payout', '+ Spule': '+ Spool', 'Jetzt senden': 'Send now', 'Jetzt ziehen': 'Sync now',
  'Login-Fenster öffnen': 'Open login window', 'Standard-Export importieren': 'Import standard export', 'Zurücknehmen': 'Undo',
  'Katalog verwalten →': 'Manage catalog →', 'Filament-Lager →': 'Filament stock →', '← Druckplan': '← Print queue',
  'Spule abbuchen': 'Deduct spool', 'ohne Abbuchung': 'no deduction', '⤵ aus Modell': '⤵ from model',
  '↗ MakerWorld-Upload': '↗ MakerWorld upload', '✓ veröffentlicht': '✓ published', '✓ gedruckt': '✓ printed',
  '＋ Kunde': '＋ Customer', '＋ Lead': '＋ Lead', 'Bericht →': 'Report →', 'CSV': 'CSV',
  // Toasts / Meldungen
  'Gespeichert.': 'Saved.', 'Absender gespeichert.': 'Sender saved.', 'Kalkulation gespeichert.': 'Costing saved.', 'Preis aktualisiert.': 'Price updated.',
  'Statuslink kopiert': 'Status link copied', 'Position hinzugefügt': 'Item added', 'Druck verbucht': 'Print booked', 'Digest gesendet.': 'Digest sent.',
  'Wochen-Report gesendet.': 'Weekly report sent.', 'Erst ein Modell wählen.': 'Select a model first.', 'Kein passendes Modell gefunden.': 'No matching model found.',
  'Farbe angeben.': 'Enter a color.', 'Bitte gültige Werte.': 'Please enter valid values.', 'Keine Tabelle gefunden.': 'No table found.',
  'Popup blockiert — bitte Popups erlauben.': 'Popup blocked — please allow popups.', 'läuft schon': 'already running',
  'Als geplantes Produkt angelegt (erscheint unter Produkte)': 'Created as a planned product (appears under Products)', 'Als veröffentlicht markiert': 'Marked as published',
  // Leerzustände / Hinweise
  'Keine Ausgaben.': 'No expenses.', 'Keine Auszahlungen.': 'No payouts.', 'Keine Projekte.': 'No projects.', 'Keine Teile.': 'No parts.',
  'Keine offenen Drucke': 'No open prints', 'Noch keine Spulen erfasst. Unten eine Spule anlegen.': 'No spools yet. Add one below.', 'kein Modell verknüpft': 'no model linked',
  'Aus Druckpositionen berechnet': 'Calculated from print items', 'Filament & Druckzeit werden aus den Positionen summiert.': 'Filament & print time are summed from the items.',
  'nur Modellarbeit = kein Druck (Statuslink ohne Druck-Schritt)': 'modeling only = no print (status link without print step)', 'Klick = Kalkulation': 'Click = costing',
  // Einstellungen
  'Push-URL': 'Push URL', 'Basis-URL': 'Base URL', 'Filament-Warnung ab (g)': 'Filament warning below (g)', 'Wochen-Report aktiv —': 'Weekly report active —',
  'aktiv, täglich um': 'active, daily at', 'Historie ab': 'History from', 'Umschalten zwischen Deutsch (Fachbegriffe) und Englisch.': 'Switch between German (technical terms) and English.',
  'eingeloggt': 'logged in', 'nicht eingeloggt': 'not logged in', '1) MakerWorld-Login': '1) MakerWorld login', '2) Live-Pull': '2) Live sync',
  '3) Automatischer Tages-Pull': '3) Automatic daily sync', '4) Täglicher Digest / Benachrichtigung': '4) Daily digest / notification',
  '5) Wochen-Report & Alerts': '5) Weekly report & alerts', '6) Öffentlicher Statuslink': '6) Public status link',
  // Formular-Labels / Diverses
  'Art': 'Type', 'Handle': 'Handle', 'E-Mail': 'Email', 'Telefon': 'Phone', 'Tags': 'Tags', 'Tags, Komma': 'Tags, comma', 'Adresse': 'Address',
  'Steuer-Hinweis': 'Tax note', 'Stückzahl': 'Quantity', 'Margen-Stufe': 'Margin tier', 'Arbeitszeit (h)': 'Labor time (h)', 'Druckzeit (h)': 'Print time (h)',
  'Filament (g)': 'Filament (g)', 'Preis (€)': 'Price (€)', 'Exklusiv': 'Exclusive', 'Profil': 'Profile', 'Gramm': 'Grams', 'Stunden': 'Hours',
  'Eigener Druck': 'Own print', 'Summe': 'Total', 'Phase': 'Phase', 'MW-Upload': 'MW upload', 'Gratis-Projekt': 'Free project', 'offene Leads': 'open leads',
  'gratis': 'free', 'zu wenig': 'not enough', '— Modell (optional) —': '— Model (optional) —', '— Teil wählen —': '— Select part —', 'Teil': 'Part',
  'Neues Projekt …': 'New project …', 'Aufgabe zum Projekt …': 'Task for project …', 'z.B. Rückruf, Lieferung …': 'e.g. callback, delivery …',
  'Farbe (z.B. Schwarz)': 'Color (e.g. black)', 'Notizen …': 'Notes …', 'Öffne Fenster …': 'Opening window …', 'starte …': 'starting …',
  'Rest gesamt': 'Remaining total', 'Preis runden': 'Round price', 'keine Rundung': 'no rounding', 'Kalkulations-Parameter': 'Costing parameters',
  'Projekt löschen?': 'Delete project?', 'Kunde inkl. Projekte & Bestellungen löschen?': 'Delete customer incl. projects & orders?',
  'Öffnet ein echtes Chrome-Fenster. Oben rechts „Sign In", normal anmelden (Passkey funktioniert). Login wird gespeichert.': 'Opens a real Chrome window. Click "Sign In" top right and log in normally (passkey works). The login is saved.',
  'Läuft solange der Server läuft. Auf dem Pi als Dienst dauerhaft.': 'Runs while the server runs. Permanent as a service on the Pi.',
  // Präfixe für "Label (N …)"-Überschriften (siehe t()-Fallback)
  'Druckprofile': 'Print profiles', 'Verknüpfte Projekte': 'Linked projects', 'Bilder': 'Images',
  'Projekt-Kalkulation': 'Project costing', 'Wirkung von Änderungen': 'Effect of changes', 'Modelle': 'models',
  'Monatlich: Einnahmen/Auszahlungen vs. Ausgaben': 'Monthly: revenue/payouts vs. expenses', 'Summe': 'Total',
  // Modell-Detail
  'Todos': 'Tasks', 'täglich': 'daily', 'kumuliert': 'cumulative', 'autospeichern': 'auto-save', 'Gesamt': 'Total',
  'Änderungs-Timeline': 'Change timeline', 'Umrechnungskurse': 'Conversion rates', 'Impr': 'Impr', 'DL': 'DL',
  'Verdient (Lifetime)': 'Earned (lifetime)', 'Kommentare': 'Comments', '1 Jahr': '1 year', '1 Monat': '1 month',
  'Was geändert?': 'What changed?', 'Notiz (optional)': 'Note (optional)', '+ Eintrag': '+ Entry',
  'automatisch erkannt': 'auto-detected', 'öffnen': 'open', 'Ziele & Gruppe': 'Goals & group', 'Gruppe': 'Group',
  'Speichern': 'Save', 'Status': 'Status', 'Release': 'Release', 'zuletzt bearbeitet': 'last edited',
  // Heute-Kacheln + Insight-Titel (Fließtext dahinter bleibt datengetrieben)
  'offene Zahlungen': 'open payments', 'überfällige Aufgaben': 'overdue tasks', 'offene Aufgaben': 'open tasks',
  'Zugpferd': 'Top performer', 'CTR-Chance': 'CTR opportunity', 'Nächster Gutschein': 'Next voucher',
  'Stärkster Tag': 'Strongest tag', 'Top-Verdiener': 'Top earner', 'Verliert an Fahrt': 'Losing momentum',
  // Path-Leiste / Produkt-Detail-Aktionen
  'Stufe abschließen': 'Complete stage', 'Abgeschlossen': 'Completed', 'Abschlussdatum': 'Close date',
  'Duplizieren': 'Clone', 'Löschen': 'Delete', 'Dupliziert': 'Cloned', 'Gelöscht': 'Deleted',
  'Abschlussdatum gespeichert': 'Close date saved', 'Geplantes Produkt löschen?': 'Delete planned product?',
  'Modell samt lokaler Daten löschen? (Kommt beim nächsten Pull ggf. wieder.)': 'Delete model incl. local data? (May return on the next sync.)',
  'Klicken zum Bearbeiten': 'Click to edit', 'Als geplantes Produkt duplizieren': 'Clone as a planned product',
  // Punkte-Matrix
  'Punkte-Matrix (Reverse Engineering)': 'Points Matrix (Reverse Engineering)', 'Punkte / Download': 'Points / download',
  'Punkte / Druck': 'Points / print', 'Prognose Punkte · 30 T': 'Forecast points · 30 d', 'Datenpunkte (Tage)': 'Data points (days)',
  'Herkunft der Punkte (Lifetime)': 'Source of points (lifetime)', 'Modell (Downloads)': 'Model (downloads)',
  'Druckprofil (Drucke)': 'Print profile (prints)', 'Bewertungen': 'Ratings', 'Sonstige': 'Other',
  'Punkte-Timing & Prognose je Modell': 'Point timing & forecast per model', 'Punkte-Tage': 'Point days',
  'Ø Abstand': 'Avg. gap', 'letzter': 'last', 'Tage her': 'days ago', 'Prognose 30 T': 'Forecast 30 d',
  'zu wenig Daten': 'not enough data', 'wird mit jedem Pull genauer': 'improves with every sync',
  // .3mf-Anhang
  '3mf-Datei': '3MF file', 'keine Datei': 'no file', 'entfernen': 'remove', '3mf angehängt': '3MF attached',
  'Datei entfernt': 'File removed', 'Nur .3mf-Dateien.': 'Only .3mf files.', '— zum Download im Statuslink': '— for download in the status link',
  // Eigenprojekte + Prioritäten/Deadlines
  'Eigenprojekt': 'Own project', 'Eigenprojekte': 'Own Projects', '+ Eigenprojekt': '+ Own project', 'Neues Eigenprojekt …': 'New own project …',
  'Eigene Produkte planen: modellieren, drucken, fotografieren, MakerWorld-Eintrag erstellen und veröffentlichen. Ohne Kunde.': 'Plan your own products: model, print, photograph, create the MakerWorld entry and publish. No customer.',
  'Idee': 'Idea', 'Fotos': 'Photos', 'MW-Eintrag': 'MW entry', 'Veröffentlicht': 'Published',
  'Priorität': 'Priority', 'Prio': 'Prio', 'Deadline': 'Deadline', 'Abschluss': 'Closed',
  'Dringend': 'Urgent', 'Hoch': 'High', 'Normal': 'Normal', 'Niedrig': 'Low',
  'Selbstkosten': 'Cost', 'Bilanz': 'Balance', 'MakerWorld − Selbstkosten': 'MakerWorld − cost', 'inkl. Arbeitszeit': 'incl. labor',
  'noch nicht veröffentlicht': 'not yet published', 'Kosten ': 'Cost ', 'heute': 'today', 'überfällig': 'overdue'
};

// ---- Start ----
setupSearch();
applyNavLang();
(async () => { await loadOverview(); const route = location.hash.slice(1) || 'heute'; go(routes[route] ? route : 'heute'); pollPull(); })();
