// Aufgaben-Seite, Zeile (todoRow) und Drag & Drop fuer Kanban-Boards.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
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
  const cb = el('input', { type: 'checkbox', 'aria-label': 'Erledigt: ' + (t.title || '') }); cb.checked = !!t.done;
  cb.onchange = async () => { await jpost('/todos/' + t.id, { done: cb.checked }, 'PUT'); await loadOverview(); after && after(); };
  const overdue = t.due_date && !t.done && t.due_date < today();
  const link = t.contact_name ? el('span', { class: 'pill', onclick: () => openContact(t.contact_id) }, '' + t.contact_name + (t.project_title ? ' · ' + t.project_title : ''))
    : t.project_title ? el('span', { class: 'pill', onclick: () => openProject(t.project_id) }, t.project_title)
    : t.model_title ? el('span', { class: 'pill', onclick: () => openModel(t.design_id) }, t.model_title)
    : el('span', { class: 'pill' }, 'global');
  return el('li', { class: 'todo' + (t.done ? ' done' : '') },
    el('span', { class: 'prio p' + (t.priority ?? 1) }), cb,
    el('span', { class: 't' }, t.title), link,
    t.due_date ? el('span', { class: 'due' + (overdue ? ' over' : '') }, t.due_date) : null,
    el('button', { class: 'btn sm ghost', onclick: async () => { await delWithUndo('/todos/' + t.id, 'Aufgabe', async () => { await loadOverview(); after && after(); }); await loadOverview(); after && after(); } }, '✕'));
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
