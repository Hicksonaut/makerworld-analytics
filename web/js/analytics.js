// Analyse: Uebersicht, Momentum, Vergleich, Kategorien, Punkte, Wochenbericht.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
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

  const stats = [['view','Views'],['impression','Impressionen'],['download','Downloads'],['print','Drucke'],
    ['collect','Gesammelt'],['like','Likes'],['point','Punkte gesamt'],['boost','Boost']];
  const strip = el('div', { class: 'stats' });
  stats.forEach(([k, l]) => strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(t[k] || 0)), el('div', { class: 'l' }, l))));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(t.dl30)), el('div', { class: 'l' }, 'Downloads · 30 T'),
    el('div', { class: 'd muted' }, fmt(t.v30) + ' Views/30 T')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(t.pts30)), el('div', { class: 'l' }, 'Punkte · 30 T')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(t.earned)), el('div', { class: 'l' }, 'Verdient gesamt'),
    el('div', { class: 'd muted' }, eur(t.earned30) + ' /30T')));
  w.append(strip);

  // Prognose (Trend-Regression über 90 Tage)
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Prognose (Trend, letzte 90 Tage)'),
    el('div', { class: 'bd' }, el('div', { class: 'stats', style: 'border:0;margin:0' },
      fcTile('Downloads', t.proj_dl30, t.proj_dl90), fcTile('Views', t.proj_v30, t.proj_v90), fcTile('Punkte', t.proj_pts30, t.proj_pts90),
      el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(t.proj_eur30)), el('div', { class: 'l' }, '€ · +30 T'), el('div', { class: 'd muted' }, eur(t.proj_eur90) + ' · +90 T'))))));

  const search = el('input', { class: 'search', placeholder: 'Modell suchen …', value: searchTerm,
    oninput: e => { searchTerm = e.target.value; draw(); } });
  const stFilter = el('select', {}, el('option', { value: '' }, 'alle Status'), STATUSES.map(([v, l]) => el('option', { value: v }, l)));
  stFilter.value = statusFilter; stFilter.onchange = () => { statusFilter = stFilter.value; draw(); };
  const segSel = el('select', {}, el('option', { value: '' }, 'Segment laden …'), (segments || []).map(s => el('option', { value: s.id }, s.name)));
  segSel.onchange = () => { const s = segments.find(x => x.id == segSel.value); if (s) applySegment(s.config); };
  // Spaltenauswahl (gemerkt im Browser). Standard = die wichtigsten Spalten; mobil noch weniger.
  const cols = [
    ['title','Modell','str'],['status','Status','status'],['publish_date','Release','str'],['impression','Impressionen','n'],['view','Views','n'],
    ['ctr_pct','CTR%','pct'],['download','Downloads','n'],['dl30','Downloads 30 T','n'],['v_per_day','Views/Tag','n'],['v_trend','Trend','trend'],
    ['spark','Views-Verlauf 30 T','spark'],['collect','Gesammelt','n'],['like','Likes','n'],['comment_count','Kommentare','n'],
    ['point','Punkte','n'],['earned','Verdient','eur'],['boost','Boost','n'],['tag_count','Tags','n']];
  const DEFAULT_COLS = window.innerWidth < 800 ? ['view', 'download', 'v_trend', 'earned']
    : ['status', 'publish_date', 'impression', 'view', 'ctr_pct', 'download', 'dl30', 'v_trend', 'spark', 'point', 'earned'];
  let visibleCols = (() => { try { const j = JSON.parse(localStorage.getItem('ov_cols') || 'null'); if (Array.isArray(j) && j.length) return new Set(j); } catch {} return new Set(DEFAULT_COLS); })();
  const saveCols = () => { try { localStorage.setItem('ov_cols', JSON.stringify([...visibleCols])); } catch {} };
  const vcols = () => cols.filter(c => c[0] === 'title' || visibleCols.has(c[0]));
  const colBox = el('div', { class: 'colpick-box' });
  const drawColBox = () => { colBox.innerHTML = '';
    cols.filter(c => c[0] !== 'title').forEach(([k, l]) => { const cb = el('input', { type: 'checkbox' }); cb.checked = visibleCols.has(k);
      cb.onchange = () => { cb.checked ? visibleCols.add(k) : visibleCols.delete(k); saveCols(); draw(); };
      colBox.append(el('label', { class: 'checkline' }, cb, l)); });
    colBox.append(el('div', { class: 'row' },
      el('button', { class: 'btn sm', onclick: () => { visibleCols = new Set(DEFAULT_COLS); saveCols(); drawColBox(); draw(); } }, 'Standard'),
      el('button', { class: 'btn sm', onclick: () => { visibleCols = new Set(cols.map(c => c[0])); saveCols(); drawColBox(); draw(); } }, 'Alle'))); };
  const colPick = el('details', { class: 'colpick' }, el('summary', { class: 'btn sm' }, 'Spalten'), colBox);
  const closeColPick = e => { if (!colPick.isConnected) { document.removeEventListener('click', closeColPick); return; } if (e.target.isConnected && !colPick.contains(e.target)) colPick.open = false; };   // Ziel schon ersetzt (Neuaufbau der Liste) = kein Aussenklick
  document.addEventListener('click', closeColPick);
  const toolbar = el('div', { class: 'toolbar' }, search, el('label', {}, 'Status'), stFilter, segSel,
    el('button', { class: 'btn sm', onclick: saveSegment }, '＋ Segment'),
    el('button', { class: 'btn sm ghost', onclick: delSegment, title: 'gewähltes Segment löschen' }, '✕'),
    colPick, csvBtn('uebersicht.csv'), el('span', { class: 'muted', style: 'margin-left:auto' }, 'Klick = Details'));
  w.append(toolbar);
  const wrap = el('div', { class: 'tablewrap' }); w.append(wrap);
  drawColBox();

  function applySegment(c) { searchTerm = c.search || ''; statusFilter = c.status || ''; sortKey = c.sortKey || 'download'; sortDir = c.sortDir || -1; search.value = searchTerm; stFilter.value = statusFilter; draw(); }
  async function saveSegment() { const name = await askText({ title: 'Segment speichern', text: 'Speichert Suche, Status-Filter und Sortierung unter einem Namen.', placeholder: 'z. B. Bierdeckel live', okText: 'Speichern' }); if (!name || !name.trim()) return; const v = await jpost('/views', { name: name.trim(), config: { search: searchTerm, status: statusFilter, sortKey, sortDir } }); segments.push({ ...v, config: JSON.parse(v.config) }); segSel.append(el('option', { value: v.id }, v.name)); segSel.value = v.id; toast('Segment gespeichert.'); }
  async function delSegment() { const id = segSel.value; if (!id) return toast('Erst ein Segment wählen.'); await delWithUndo('/views/' + id, 'Segment', () => { segments = null; renderOverview(); }); segments = segments.filter(s => s.id != id); renderOverview(); }
  function draw() {
    let rows = o.models.filter(m => (!searchTerm || (m.title || '').toLowerCase().includes(searchTerm.toLowerCase())) && (!statusFilter || stOf(m) === statusFilter));
    rows.sort((a, b) => {
      let x = a[sortKey], y = b[sortKey];
      if (sortKey === 'title' || sortKey === 'publish_date') return sortDir * String(x || '').localeCompare(String(y || ''));
      return sortDir * (((x ?? -1)) - ((y ?? -1)));
    });
    const thead = el('tr', {}, vcols().map(([k, l]) => el('th', { class: k === 'title' ? '' : 'n',
      onclick: () => { if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = -1; } draw(); } },
      l + (sortKey === k ? (sortDir < 0 ? ' ▾' : ' ▴') : ''))));
    const tb = el('tbody', {}, rows.map(m => el('tr', { onclick: () => openModel(m.design_id) },
      vcols().map(([k, , type]) => {
        if (type === 'status') return el('td', {}, statusBadge(stOf(m)));
        if (type === 'str') return el('td', { class: k === 'title' ? 'title' : '' }, k === 'title' ? (m.title || m.design_id) : k === 'publish_date' ? dmy(m[k]) : (m[k] || '–'));
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
  const cols = [['Modell'],['Views 7 T'],['Views 30 T'],['Views/Tag'],['Trend'],['Downloads 7 T'],['Downloads 30 T'],['Downloads/Tag'],['Δ Downloads Woche'],['Views-Verlauf 30 T'],['Punkte 30 T']];
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
// Sortierbare Gruppen-Tabelle (Kategorien-Seite UND Vergleich): rows = Ergebnis von /analytics/groups.
function groupTable(rows, cols, onRow) {
  const wrap = el('div', { class: 'tablewrap' });
  const draw = () => {
    const sorted = [...rows].sort((x1, y1) => {
      const x = x1[grpSort.key], y = y1[grpSort.key];
      if (grpSort.key === 'key') return grpSort.dir * String(x || '').localeCompare(String(y || ''), 'de');
      return grpSort.dir * ((x ?? -1) - (y ?? -1));
    });
    wrap.innerHTML = '';
    wrap.append(el('table', {},
      el('thead', {}, el('tr', {}, cols.map(([k, l]) => el('th', { class: k === 'key' ? '' : 'n',
        onclick: () => { if (grpSort.key === k) grpSort.dir *= -1; else { grpSort.key = k; grpSort.dir = k === 'key' ? 1 : -1; } draw(); } },
        l + (grpSort.key === k ? (grpSort.dir < 0 ? ' ▾' : ' ▴') : ''))))),
      el('tbody', {}, sorted.map(r => el('tr', { onclick: () => onRow(r) },
        cols.map(([k]) => k === 'key' ? el('td', { class: 'title' }, r.key)
          : el('td', { class: 'n' }, k === 'ctr' ? (r.ctr != null ? fmt1(r.ctr) : '–') : fmt(r[k]))))))));
  };
  draw();
  return wrap;
}
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
  if (!q) { if (cmpChart) { cmpChart.destroy(); cmpChart = null; } if (window.__cmpTbl) { window.__cmpTbl.innerHTML = ''; window.__cmpTbl.append(el('div', { class: 'bd muted' }, 'Keine Modelle gewählt.')); } return; }
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
    const cols = [['key','Gruppe'],['count','#'],['view','Views'],['impression','Impressionen'],['ctr','CTR%'],['download','Downloads'],['dl30','Downloads 30 T'],['collect','Gesammelt'],['like','Likes'],['point','Punkte']];
    tbl.append(groupTable(rows, cols, r => openGroup(by, r.key)));
    return;
  }
  tbl.append(el('div', { class: 'hd' }, 'Kennzahlen im Vergleich'));
  const chosen = STATE.overview.models.filter(m => cmpSel.has(m.design_id));
  const cols = [['title','Modell'],['publish_date','Release'],['view','Views'],['impression','Impressionen'],['ctr_pct','CTR%'],['download','Downloads'],['dl30','Downloads 30 T'],['collect','Gesammelt'],['like','Likes'],['point','Punkte'],['earned','Verdient']];
  tbl.append(el('div', { class: 'tablewrap' }, el('table', {},
    el('thead', {}, el('tr', {}, cols.map(([k, l]) => el('th', { class: k === 'title' ? '' : 'n' }, l)))),
    el('tbody', {}, chosen.map(m => el('tr', { onclick: () => openModel(m.design_id) },
      cols.map(([k]) => k === 'title' ? el('td', { class: 'title' }, m.title || m.design_id)
        : k === 'earned' ? el('td', { class: 'n pos' }, eur(m.earned))
        : el('td', { class: 'n' }, k === 'publish_date' ? dmy(m.publish_date) : k === 'ctr_pct' ? (m.ctr_pct != null ? fmt1(m.ctr_pct) : '–') : fmt(m[k])))))))));
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
  w.append(el('p', { class: 'muted', style: 'margin:4px 0 8px' }, 'Klick auf eine Zeile → alle Modelle der Gruppe · Klick auf Spaltenkopf sortiert.'));
  const cols = [['key','Gruppe'],['count','#'],['view','Views'],['impression','Impressionen'],['ctr','CTR%'],['download','Downloads'],['dl30','Downloads 30 T'],['print','Drucke'],['collect','Gesammelt'],['like','Likes'],['point','Punkte'],['boost','Boost']];
  w.append(groupTable(rows, cols, r => openGroup(grpBy, r.key)));

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
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Eigene Kategorie je Modell zuordnen'), el('div', { class: 'bd' }, dl, list)));
  }

  // Tag-Empfehlungen: welche Tags bringen im Schnitt mehr Reichweite
  const tg = (await api('/analytics/groups?by=tag')).rows.filter(r => r.key !== '—')
    .map(r => ({ tag: r.key, models: r.count, views: r.view, viewsPerModel: Math.round(r.view / r.count), dlPerModel: +(r.download / r.count).toFixed(1) }))
    .sort((p, q) => q.viewsPerModel - p.viewsPerModel);
  const top = tg.slice(0, 15);
  const wrap2 = el('div', { class: 'tablewrap' });
  wrap2.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Tag'), el('th', { class: 'n' }, 'Modelle'), el('th', { class: 'n' }, 'Ø Views/Modell'), el('th', { class: 'n' }, 'Ø Downloads/Modell'), el('th', { class: 'n' }, 'Views gesamt'))),
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
    el('h1', {}, key), el('div', { class: 'muted' }, `${by === 'tag' ? 'Tag' : by === 'group' ? 'Eigene Kategorie' : 'MakerWorld-Kategorie'} · ${members.length} Modelle`)),
    el('span', { class: 'close', onclick: closeDrawer }, '✕')));
  const body = el('div', { class: 'dbody' }); inner.append(body);
  const strip = el('div', { class: 'stats' });
  [['view','Views'],['impression','Impressionen'],['download','Downloads'],['dl30','Downloads 30 T'],['print','Drucke'],['collect','Gesammelt'],['like','Likes'],['point','Punkte']]
    .forEach(([k, l]) => strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(sum(k))), el('div', { class: 'l' }, l))));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(sum('earned'))), el('div', { class: 'l' }, 'Verdient')));
  body.append(strip);
  // Chart: Downloads kumuliert je Produkt
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Downloads kumuliert je Modell'), el('div', { class: 'bd' }, el('div', { class: 'chartbox' }, el('canvas', { id: 'groupChart' })))));
  const { series } = await api(`/timeseries?ids=${members.map(m => m.design_id).join(',')}&metric=download&granularity=day&mode=date&cumulative=1`);
  if (groupChart) groupChart.destroy();
  groupChart = new Chart($('#groupChart'), { type: 'line', data: alignSeries(series, true), options: chartOpts() });
  // Produkt-Tabelle
  const cols = [['title','Modell'],['view','Views'],['ctr_pct','CTR%'],['download','Downloads'],['dl30','Downloads 30 T'],['collect','Gesammelt'],['like','Likes'],['point','Punkte'],['earned','Verdient']];
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
    el('div', { class: 'stat', style: 'border-right:2px solid var(--accent)' }, el('div', { class: 'v pos' }, fmt(ac.point) + ' P'), el('div', { class: 'l' }, 'Kontostand'), el('div', { class: 'd pos' }, '≈ ' + eur(ac.point * acc.rate))),
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt1(ac.point_exclusive)), el('div', { class: 'l' }, 'davon Exklusiv'), el('div', { class: 'd muted' }, 'Regulär ' + fmt1(ac.point_regular))));
  strip.append(
    el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(d.totals.point)), el('div', { class: 'l' }, 'Punkte gesamt')),
    el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur(d.totals.earned)), el('div', { class: 'l' }, 'Verdient gesamt')),
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
    el('thead', {}, el('tr', {}, el('th', {}, 'Modell'), el('th', { class: 'n' }, 'Punkte'), el('th', { class: 'n' }, 'Verdient'), el('th', { class: 'n' }, 'Punkte 30 T'), el('th', { class: 'n' }, '€·30T'), el('th', { class: 'n' }, 'Boost'))),
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
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Herkunft der Punkte (gesamt)'),
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
          el('td', { class: 'n muted' }, dmy(m.lastDate)),
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
  const w = pagehead('Wochenbericht', 'Wochenrückblick — Bewegung der letzten 7 Tage, Prognose und offene Punkte.');
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
    miniTable('Top Downloads-Zuwachs (Woche vs. Vorwoche)', gainers, m => (m.dl_delta > 0 ? '+' : '') + fmt1(m.dl_delta) + ' Downloads', 'pos'),
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

  // Letzte Änderungen
  const evs = await api('/events');
  const byId = Object.fromEntries(models.map(m => [m.design_id, m.title]));
  const recent = evs.slice(0, 12);
  const list = el('ul', { class: 'timeline' });
  if (!recent.length) list.append(el('li', { class: 'muted' }, 'keine Einträge'));
  recent.forEach(ev => list.append(el('li', {}, el('span', { class: 'date' }, dmy(ev.date)), el('span', { class: 'pill' }, ev.type || 'other'),
    el('div', { style: 'flex:1' }, el('b', {}, ev.title || ''), el('div', { class: 'muted' }, (ev.design_id ? (byId[ev.design_id] || ev.design_id) : 'Global') + (ev.note ? ' — ' + ev.note : ''))))));
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Letzte Änderungen'), el('div', { class: 'bd' }, list)));
}
