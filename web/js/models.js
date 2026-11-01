// Modell-Pipeline (Kanban), geplante Modelle und Modell-Detail (Drawer).
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
// ============ PIPELINE (Kanban) ============
// Lange Spalten (z.B. "Live" mit 20 Karten) zeigen zunaechst die ersten 8; per Knopf alle.
const PIPE_LIMIT = 8, pipeExpanded = {};
async function renderPipeline() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Modell-Pipeline', 'Von der Idee bis Archiviert. Geplante Modelle werden beim Pull automatisch mit dem echten Modell verschmolzen (Titel-Abgleich).');
  w.append(el('div', { class: 'toolbar' },
    el('button', { class: 'btn primary sm', onclick: planProduct }, '＋ Modell planen'),
    el('span', { class: 'muted' }, 'Neue Idee anlegen — Titel exakt wie später auf MakerWorld, dann verschmilzt der Pull automatisch.')));
  const all = [...STATE.overview.models, ...(STATE.overview.planned || [])];
  const board = el('div', { class: 'board' });
  STATUSES.forEach(([sv, sl]) => {
    const members = all.filter(m => stOf(m) === sv).sort((a, b) => (b.download || 0) - (a.download || 0));
    const col = el('div', { class: 'col' }, el('div', { class: 'colhd', style: `border-top:3px solid ${STATUS_COLOR[sv]}` }, sl, el('span', { class: 'cnt' }, members.length)));
    dndColumn(col, sv, async (id, stage) => { const mm = all.find(x => x.design_id === id); if (mm) mm.status = stage;
      await jpost('/model/' + id + '/status', { status: stage }, 'PUT'); renderPipeline(); });
    (pipeExpanded[sv] ? members : members.slice(0, PIPE_LIMIT)).forEach(m => {
      const planned = !!m.planned;
      const sel = el('select', { class: 'sm', onclick: e => e.stopPropagation() }, STATUSES.map(([v, l]) => el('option', { value: v }, l)));
      sel.value = sv;
      sel.onchange = async e => { e.stopPropagation(); m.status = sel.value; await jpost('/model/' + m.design_id + '/status', { status: sel.value }, 'PUT'); renderPipeline(); };
      const card = el('div', { class: 'kcard', onclick: () => planned ? openPlanned(m.design_id) : openModel(m.design_id) },
        el('div', { class: 'kt' }, planned ? el('span', { class: 'tag', style: 'background:#6b7280;margin-right:5px' }, 'GEPLANT') : null, m.title || m.design_id),
        planned ? el('div', { class: 'muted', style: 'font-size:11px' }, m.group_label ? 'Kategorie: ' + m.group_label : 'zum Planen anklicken')
          : el('div', { class: 'muted num', style: 'font-size:11px' }, `${fmt(m.download)} Downloads · ${fmt(m.view)} Views · ${eur(m.earned)}`),
        sel);
      dndCard(card, m.design_id);   // alle Stufen erlaubt (auch geplante -> Live)
      col.append(card);
    });
    if (!members.length) col.append(el('div', { class: 'muted', style: 'padding:8px' }, '—'));
    if (members.length > PIPE_LIMIT) col.append(el('button', { class: 'btn sm ghost colmore', onclick: () => { pipeExpanded[sv] = !pipeExpanded[sv]; renderPipeline(); } },
      pipeExpanded[sv] ? 'weniger anzeigen' : `${members.length - PIPE_LIMIT} weitere anzeigen`));
    board.append(col);
  });
  w.append(board);
}
async function planProduct() {
  const title = await askText({ title: 'Modell planen', text: 'Titel möglichst exakt wie später auf MakerWorld — dann verschmilzt der Pull das Modell automatisch.', okText: 'Planen' });
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

  const titleI = el('input', { value: m.title || '', 'aria-label': 'Titel des geplanten Modells', style: 'font-size:14px;font-weight:600;flex:1;min-width:220px' });
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
  const tagsI = el('input', { style: 'width:100%', placeholder: 'Tags, mit Komma getrennt (z.B. untersetzer, geschenk, magnet)', value: (Array.isArray(m.tags) ? m.tags : []).join(', ') });
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
  const grpI = el('input', { value: m.group_label || '', placeholder: 'z.B. Untersetzer', style: 'width:180px' });
  grpI.addEventListener('change', () => jpost('/model/' + id + '/group', { group_label: grpI.value || null }, 'PUT').then(() => { loadOverview(); toast('Kategorie gespeichert.'); }));
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Kategorie'), el('div', { class: 'bd row' }, el('label', {}, 'Gruppe'), grpI)));

  // Todos
  const tl = el('ul', { class: 'todolist' });
  const drawTodos = todos => { tl.innerHTML = ''; if (!todos.length) tl.append(el('li', { class: 'muted' }, 'Keine Aufgaben.'));
    todos.forEach(tdo => tl.append(todoRow(tdo, async () => { drawTodos(await api('/model/' + id + '/todos')); }))); };
  const tIn = el('input', { placeholder: 'Aufgabe …', style: 'flex:1' });
  const tPrio = el('select', {}, [['1','normal'],['2','hoch'],['0','niedrig']].map(([v, l]) => el('option', { value: v }, l)));
  const tDue = el('input', { type: 'date' });
  const addTodo = async () => { if (!tIn.value.trim()) return; await jpost('/todos', { design_id: id, title: tIn.value.trim(), priority: +tPrio.value, due_date: tDue.value || null }); tIn.value = ''; tDue.value = ''; drawTodos(await api('/model/' + id + '/todos')); loadOverview(); };
  tIn.addEventListener('keydown', e => { if (e.key === 'Enter') addTodo(); });
  drawTodos(d.todos || []);
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Aufgaben'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, tIn, tPrio, tDue, el('button', { class: 'btn primary sm', onclick: addTodo }, '+')), tl)));

  body.append(el('div', { class: 'card' }, el('div', { class: 'bd' },
    el('button', { class: 'btn ghost sm', onclick: async () => { await delWithUndo('/products/' + id, 'Geplantes Modell', async () => { await loadOverview(); renderPipeline(); }); closeDrawer(); await loadOverview(); renderPipeline(); } }, 'Geplantes Modell löschen'))));
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
      el('div', { class: 'muted' }, `${m.publish_date ? 'Release ' + dmy(m.publish_date) + ' · ' : ''}${m.mw_update_time ? 'zuletzt bearbeitet ' + dmy(m.mw_update_time.slice(0, 10)) + ' · ' : ''}ID ${id} · ${m.category || '—'} · `,
        el('a', { href: m.url || `https://makerworld.com/en/models/${id}`, target: '_blank' }, 'MakerWorld ↗')),
      el('div', { class: 'tags' }, (m.tags || []).map(tt => el('span', { class: 'pill' }, tt)))),
    el('div', { class: 'row', style: 'margin:0;align-items:center' }, el('label', {}, 'Status'), statusSel),
    el('span', { class: 'close', onclick: closeDrawer }, '✕')));

  const body = el('div', { class: 'dbody' }); inner.append(body);

  // KPI-Strip
  const kp = [['view','Views'],['impression','Impressionen'],['download','Downloads'],['print','Drucke'],['collect','Gesammelt'],['like','Likes'],['point','Punkte'],['boost','Boost']];
  const strip = el('div', { class: 'stats' });
  kp.forEach(([k, l]) => strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(snap[k])), el('div', { class: 'l' }, l))));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v pos' }, eur((snap.point || 0) * rate())), el('div', { class: 'l' }, 'Verdient gesamt')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, snap.ctr_pct != null ? fmt1(snap.ctr_pct) + '%' : '–'), el('div', { class: 'l' }, 'CTR')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(snap.comment_count)), el('div', { class: 'l' }, 'Kommentare')));
  strip.append(el('div', { class: 'stat' }, el('div', { class: 'v' }, fmt(m.dl30)), el('div', { class: 'l' }, 'Downloads · 30 T'), el('div', { class: 'd ' + (m.v_trend > 0 ? 'pos' : m.v_trend < 0 ? 'neg' : 'muted') }, m.v_trend != null ? (m.v_trend > 0 ? '+' : '') + m.v_trend + '% Views' : '')));
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
  const notesTa = el('textarea', { style: 'width:100%;height:120px', placeholder: 'Notizen zu diesem Modell …' }, m.notes || '');
  let noteTimer;
  const saveNote = () => { clearTimeout(noteTimer); noteTimer = setTimeout(() => jpost('/model/' + id + '/notes', { notes: notesTa.value }, 'PUT').then(() => flash(noteHd)), 600); };
  notesTa.addEventListener('input', saveNote);
  const noteHd = el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, 'autospeichern');
  left.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Notizen', noteHd), el('div', { class: 'bd' }, notesTa)));

  // Todos
  const tl = el('ul', { class: 'todolist' });
  const drawTodos = (todos) => { tl.innerHTML = ''; if (!todos.length) tl.append(el('li', { class: 'muted' }, 'Keine Aufgaben.'));
    todos.forEach(tdo => tl.append(todoRow(tdo, async () => { drawTodos(await api('/model/' + id + '/todos')); }))); };
  const tIn = el('input', { placeholder: 'Aufgabe …', style: 'flex:1' });
  const tPrio = el('select', {}, [['1','normal'],['2','hoch'],['0','niedrig']].map(([v, l]) => el('option', { value: v }, l)));
  const tDue = el('input', { type: 'date' });
  const addTodo = async () => { if (!tIn.value.trim()) return; await jpost('/todos', { design_id: id, title: tIn.value.trim(), priority: +tPrio.value, due_date: tDue.value || null }); tIn.value = ''; tDue.value = ''; drawTodos(await api('/model/' + id + '/todos')); await loadOverview(); };
  tIn.addEventListener('keydown', e => { if (e.key === 'Enter') addTodo(); });
  drawTodos(d.todos || []);
  left.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Aufgaben'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, tIn, tPrio, tDue, el('button', { class: 'btn primary sm', onclick: addTodo }, '+')), tl)));

  // Ziele & Gruppe
  const gDl = el('input', { type: 'number', value: m.goal_download || '', placeholder: 'Downloads', style: 'width:90px' });
  const gView = el('input', { type: 'number', value: m.goal_view || '', placeholder: 'Views', style: 'width:90px' });
  const gPt = el('input', { type: 'number', value: m.goal_point || '', placeholder: 'Punkte', style: 'width:90px' });
  const gGrp = el('input', { value: m.group_label || '', placeholder: 'z.B. Untersetzer', style: 'width:140px' });
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
      goalWrap.append(el('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' }, `Ziel-Prognose: in ~${days} Tagen erreicht (bei ${fmt1(perDay)} Downloads/Tag)`));
    } };
  drawGoals();
  const saveGoals = async () => { m.goal_download = +gDl.value || null; m.goal_view = +gView.value || null; m.goal_point = +gPt.value || null; m.group_label = gGrp.value || null;
    await jpost('/model/' + id + '/goals', { goal_download: m.goal_download, goal_view: m.goal_view, goal_point: m.goal_point, group_label: m.group_label }, 'PUT'); drawGoals(); flash(goalHd); };
  const goalHd = el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, '');
  right.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Ziele & Gruppe', goalHd),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, el('label', {}, 'Downloads'), gDl, el('label', {}, 'Views'), gView, el('label', {}, 'Punkte'), gPt),
      el('div', { class: 'row' }, el('label', {}, 'Gruppe'), gGrp, el('button', { class: 'btn sm', onclick: saveGoals }, 'Speichern')), goalWrap)));

  // Traffic-Quellen als Donut (gesamt) + Conversion-Funnel
  if (d.traffic && d.traffic.length) {
    const lt = d.traffic.find(t => t.window === 'lifetime') || d.traffic[0];
    right.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Quelle des Datenverkehrs'),
      el('div', { class: 'bd' }, trafficDonut(lt, snap.view, id))));
  }
  body.append(funnelCard(id, snap, d.daily));

  // Druckprofile (Instanzen) inkl. Bewertungen
  if (d.instances && d.instances.length) {
    const cols = [['title','Druckprofil'],['download_count','Downloads'],['print_count','Drucke'],['rating','★ (Anz.)'],['weight','Filament'],['time','Druckzeit'],['ams','AMS']];
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
    const tb = el('table', {}, el('thead', {}, el('tr', {}, ['Datum','Änderung','CTR vorher','CTR nachher','Δ','Impressionen/Tag vorher→nachher','Downloads vorher→nachher'].map((h, i) => el('th', { class: i ? 'n' : '' }, h)))),
      el('tbody', {}, ci.impacts.map(im => el('tr', {},
        el('td', {}, dmy(im.date)), el('td', {}, TLBL[im.type] || im.type),
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
  const SRC = [['recommend','Empfehlen','#1a7f37'],['search','Suchen','#1f5c8f'],['browse','Durchsuchen','#b4620a'],['direct','Direkte URL','#6b4fa1'],['other','Andere','#6b7280']];
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
      el('div', { class: 'fstage', style: 'width:100%;background:#6b7280' }, 'Eindrücke', el('b', {}, fmt(imp))),
      el('div', { class: 'fconv' }, `▼ ${fmt1(c1)} %  (Eindrücke → Aufrufe)`),
      el('div', { class: 'fstage', style: 'width:64%;background:#1f5c8f' }, 'Aufrufe', el('b', {}, fmt(view))),
      el('div', { class: 'fconv' }, `▼ ${fmt1(c2)} %  (Aufrufe → ${label})`),
      el('div', { class: 'fstage', style: 'width:42%;background:#1a7f37' }, label, el('b', {}, fmt(out))));
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
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').classList.contains('hidden')) closeDrawer(); });
function flash(node) { node.textContent = t('✓ gespeichert'); node.classList.add('pos'); setTimeout(() => { node.textContent = ''; node.classList.remove('pos'); }, 1500); }

function renderEventEditor(design_id, events) {
  const list = el('ul', { class: 'timeline' });
  let exps = {};   // Experiment-Urteile je Ereignis
  const loadExps = () => api('/experiments?design_id=' + encodeURIComponent(design_id)).then(r => { exps = Object.fromEntries((r.items || []).map(x => [x.id, x])); draw(events); }).catch(() => {});
  const draw = evs => { list.innerHTML = ''; if (!evs.length) list.append(el('li', { class: 'muted' }, 'Noch keine Änderungen erfasst.'));
    evs.forEach(ev => list.append(el('li', {}, el('span', { class: 'date' }, dmy(ev.date)), el('span', { class: 'pill' }, EVT_LABEL[ev.type] || ev.type || 'Sonstiges'),
      el('div', { style: 'flex:1' }, el('b', {}, ev.title || '(ohne Titel)'), exps[ev.id] ? verdictBadge(exps[ev.id]) : null, ev.note ? el('div', { class: 'muted' }, ev.note) : null,
        ev.hypothesis ? el('div', { class: 'muted' }, t('Hypothese') + ': ' + ev.hypothesis) : null,
        exps[ev.id] ? el('a', { href: '#', class: 'muted', style: 'font-size:11px', onclick: async e => { e.preventDefault();
          const h = await askText({ title: 'Hypothese', text: 'Was soll die Änderung bewirken? Nach der Frist wird sie automatisch gegen die CTR geprüft.', value: ev.hypothesis || '', placeholder: 'z. B. Neues Cover steigert die CTR', okText: 'Speichern' });
          if (h == null) return; const nv = await jpost('/events/' + ev.id, { hypothesis: h }, 'PUT'); ev.hypothesis = nv.hypothesis; loadExps(); } }, ev.hypothesis ? t('Hypothese ändern') : t('Hypothese ergänzen')) : null),
      el('button', { class: 'btn sm ghost', onclick: async () => { await delWithUndo('/events/' + ev.id, 'Eintrag', async () => { const nd = await api('/events?design_id=' + design_id); events.splice(0, events.length, ...nd); draw(events); }); draw(evs = evs.filter(x => x.id !== ev.id)); } }, '✕')))); };
  draw(events);
  const dateI = el('input', { type: 'date', value: today() });
  const typeI = el('select', {}, ['thumbnail','title','description','tags','price','files','other'].map(k => el('option', { value: k }, EVT_LABEL[k])));
  const titleI = el('input', { placeholder: 'Was geändert?', style: 'flex:1;min-width:160px' });
  const noteI = el('input', { placeholder: 'Notiz (optional)', style: 'flex:1;min-width:160px' });
  const hypI = el('input', { placeholder: 'Hypothese (optional), z. B. „Neues Cover steigert die CTR“', style: 'flex:2;min-width:220px' });
  const daysI = el('select', { title: 'Auswertung nach …' }, [7, 14, 21, 28].map(n => el('option', { value: n, selected: n === 14 }, n + ' ' + t('Tage'))));
  const add = async () => { if (!titleI.value && !noteI.value) return;
    const ev = await jpost('/events', { design_id, date: dateI.value, type: typeI.value, title: titleI.value, note: noteI.value, hypothesis: hypI.value, eval_days: +daysI.value });
    events.unshift(ev); titleI.value = ''; noteI.value = ''; hypI.value = ''; loadExps(); };
  loadExps();
  return el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Änderungs-Timeline'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, dateI, typeI, titleI, noteI, el('button', { class: 'btn primary sm', onclick: add }, '+ Eintrag')),
      el('div', { class: 'row', style: 'margin-top:6px' }, hypI, daysI), list));
}
