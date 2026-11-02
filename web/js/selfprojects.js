// Eigenprojekt = Planung des spaeteren MakerWorld-Uploads (Server: plan.js). Beim Anlegen entsteht ein geplantes Modell; Beschreibung, Tags
// und Upload-Paket gehoeren dazu. Eine Verknuepfung mit MakerWorld gibt es erst nach dem Veroeffentlichen (Pull verschmilzt per Titel).
const isPlanId = x => String(x || '').startsWith('plan_');
const SELF_INFO = 'Planung für den späteren MakerWorld-Upload. Eine Verbindung zu MakerWorld gibt es erst nach dem Veröffentlichen (der Pull verknüpft per Titel automatisch). Bis dahin trägst du Gewicht und Druckzeit aus deinem Slicer selbst ein.';

async function openSelfProject(id, full) {
  const s = await api('/crm/settings');
  const p = { ...full }; let parts = full.parts || [];
  const isPlan = isPlanId(p.design_id), isLive = !!p.design_id && !isPlan;
  const md = isPlan ? (await api('/model/' + p.design_id).catch(() => ({}))).model : null;
  const inner = $('#drawer .drawer-inner'); inner.innerHTML = ''; $('#drawer').classList.remove('hidden');
  const debounce = (fn, ms = 500) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
  const persist = debounce(async () => {
    const saved = await jpost('/projects/' + id, { title: p.title, stage: p.stage, filament_g: +p.filament_g || null, print_hours: +p.print_hours || null, labor_hours: +p.labor_hours || null,
      close_date: p.close_date || null, due_date: p.due_date || null, priority: p.priority ?? 1 }, 'PUT');
    if (saved && saved.error) toast('Nicht gespeichert: ' + saved.error);
    await loadOverview();
  });

  // ---- Kopf: Titel, Phase ----
  const stageSel = mkSelect(SELF_STAGES, p.stage || 'idee'); stageSel.onchange = () => setStage(stageSel.value);
  const titleI = el('input', { value: p.title || '', 'aria-label': 'Projekttitel', style: 'font-size:14px;font-weight:600;flex:1;min-width:200px' });
  titleI.oninput = () => { p.title = titleI.value; persist(); };
  inner.append(el('div', { class: 'dh' },
    el('div', { style: 'flex:1' }, el('div', { class: 'row', style: 'margin:0 0 4px' }, el('span', { class: 'tag', style: 'background:#7c3aed' }, 'UPLOAD-PLAN'), titleI),
      el('div', { class: 'muted' }, 'Eigenprojekt' + (isLive && full.model_title ? ' · Modell: ' + full.model_title : ''))),
    el('div', { class: 'row', style: 'margin:0;align-items:center' }, el('label', {}, 'Phase'), stageSel),
    el('span', { class: 'close', onclick: closeDrawer }, '✕')));
  const body = el('div', { class: 'dbody' }); inner.append(body);

  // ---- Kennzahlen (Kosten vom Server, Ertrag erst nach dem Veroeffentlichen) ----
  const res = el('div', { class: 'stats' }); body.append(res);
  let calcSeq = 0, calcT;
  const tile = (v, l, cls, d) => el('div', { class: 'stat' }, el('div', { class: 'v ' + (cls || '') }, v), el('div', { class: 'l' }, l), d ? el('div', { class: 'd muted' }, d) : null);
  const mwE = full.mw?.earned || 0;
  const renderRes = c => { res.innerHTML = '';
    res.append(tile(eur(c.material), 'Material (Sach)'), tile(eur(c.cost), 'Selbstkosten', '', 'inkl. Arbeitszeit'),
      isLive ? tile(eur(mwE), 'MakerWorld-Ertrag', mwE > 0 ? 'pos' : 'muted', full.mw ? `${fmt(full.mw.download)} Downloads · ${fmt(full.mw.point)} Punkte` : '') : tile('–', 'MakerWorld-Ertrag', 'muted', 'noch nicht veröffentlicht'),
      isLive ? tile(eur(+(mwE - c.cost).toFixed(2)), 'Bilanz', mwE - c.cost >= 0 ? 'pos' : 'neg', 'MakerWorld − Selbstkosten') : tile('–', 'Bilanz', 'muted', 'nach dem Upload')); };
  const drawRes = () => { clearTimeout(calcT); calcT = setTimeout(async () => { const my = ++calcSeq;
    const r = await jpost('/crm/calc', { project: { filament_g: p.filament_g, print_hours: p.print_hours, labor_hours: p.labor_hours, margin_tier: 'kostenlos' }, parts, items: [] }).catch(() => null);
    if (my === calcSeq && r && !r.error) renderRes(r); }, 120); };
  renderRes(full.calc);

  // ---- Phasen-Pfad ----
  const pathWrap = el('div', { style: 'flex:1;min-width:220px' }), markBtn = el('button', { class: 'btn primary sm' }, 'Phase abschließen');
  const closeDateI = el('input', { type: 'date', value: p.close_date || '' }); closeDateI.onchange = () => { p.close_date = closeDateI.value || null; persist(); };
  const path = () => SELF_STAGES.filter(sd => sd[0] !== 'abgebrochen'), last = () => path().slice(-1)[0][0];
  const setStage = v => { p.stage = v; stageSel.value = v; persist(); drawPath(); if (v === last() && !p.close_date) { p.close_date = today(); closeDateI.value = p.close_date; } };
  const drawPath = () => { pathWrap.innerHTML = ''; pathWrap.append(stagePath(path(), p.stage, setStage)); const done = p.stage === last(); markBtn.disabled = done; markBtn.textContent = t(done ? 'Abgeschlossen' : 'Phase abschließen'); };
  markBtn.onclick = () => { const o = path().map(x => x[0]), i = o.indexOf(p.stage); if (i > -1 && i < o.length - 1) setStage(o[i + 1]); };
  const prioSel = mkSelect(PRIORITIES, String(p.priority ?? 1)); prioSel.onchange = () => { p.priority = +prioSel.value; persist(); };
  const dueI = el('input', { type: 'date', value: p.due_date || '' }); dueI.onchange = () => { p.due_date = dueI.value || null; persist(); };
  body.append(el('div', { class: 'card' }, el('div', { class: 'bd' },
    el('div', { class: 'row', style: 'align-items:center;gap:12px;flex-wrap:wrap' }, pathWrap, markBtn),
    el('div', { class: 'row', style: 'margin-top:6px;flex-wrap:wrap' }, el('label', { style: 'min-width:96px' }, 'Priorität'), prioSel, el('label', { style: 'margin-left:12px' }, 'Deadline'), dueI, el('label', { style: 'margin-left:12px' }, 'Abschluss'), closeDateI),
    el('div', { class: 'muted', style: 'font-size:11px;margin-top:6px' }, SELF_INFO))));
  drawPath();

  // ---- Plan: Beschreibung, Tags, Notizen (am geplanten Modell) ----
  if (isPlan && md) {
    const metaHd = el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, 'autospeichern');
    const descTa = el('textarea', { style: 'width:100%;height:130px', placeholder: 'Beschreibung für MakerWorld entwerfen …' }, md.description || '');
    const tagsI = el('input', { style: 'width:100%', placeholder: 'Tags, mit Komma getrennt (der Tag-Assistent schlägt bis zu 50 vor)', value: (Array.isArray(md.tags) ? md.tags : []).join(', ') });
    const tagList = () => tagsI.value.split(',').map(x => x.trim()).filter(Boolean);
    const notesTa = el('textarea', { style: 'width:100%;height:80px', placeholder: 'Notizen (Ideen, Maße, offene Punkte) …' }, md.notes || '');
    const saveMeta = debounce(async () => { await jpost('/model/' + md.design_id + '/meta', { title: p.title, description: descTa.value, tags: tagsI.value }, 'PUT'); flash(metaHd); });
    descTa.addEventListener('input', saveMeta);
    notesTa.addEventListener('input', debounce(() => jpost('/model/' + md.design_id + '/notes', { notes: notesTa.value }, 'PUT').then(() => flash(metaHd))));
    body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Plan für den MakerWorld-Eintrag', metaHd),
      el('div', { class: 'bd' }, el('div', { class: 'muted', style: 'font-size:11px;margin-bottom:4px' }, 'Beschreibung'), descTa,
        el('div', { class: 'muted', style: 'font-size:11px;margin:8px 0 4px' }, 'Tags'), tagsI, el('div', { class: 'muted', style: 'font-size:11px;margin:8px 0 4px' }, 'Notizen'), notesTa)));
    const tagCard = tagAssistantCard({ design_id: md.design_id, title: () => p.title, description: () => descTa.value, tags: tagList,
      apply: list => { tagsI.value = list.join(', '); saveMeta(); tagCard.refreshCount(); } });
    tagsI.addEventListener('input', () => { saveMeta(); tagCard.refreshCount(); });
    body.append(tagCard);
    uploadCard(md, tagList).then(c => body.append(c)).catch(() => {});
  }
  // ---- Nach dem Veroeffentlichen: Verknuepfung ----
  if (isLive) body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Veröffentlicht'), el('div', { class: 'bd row' },
    el('span', { style: 'flex:1' }, el('b', {}, full.model_title || p.design_id), el('span', { class: 'muted' }, ' · verknüpft mit dem MakerWorld-Modell')),
    el('button', { class: 'btn sm', onclick: () => { closeDrawer(); openModel(p.design_id); } }, 'Modell öffnen'))));
  if (isPlan && (p.stage === 'publish' || p.stage === 'entwurf')) {
    const sel = el('select', {}, el('option', { value: '' }, '— veröffentlichtes Modell wählen —'), (STATE.overview?.models || []).filter(m => !m.planned).map(m => el('option', { value: m.design_id }, m.title)));
    body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Mit MakerWorld verknüpfen'), el('div', { class: 'bd' },
      el('div', { class: 'muted', style: 'font-size:11px;margin-bottom:6px' }, 'Nach dem Veröffentlichen verknüpft der nächste Pull automatisch (gleicher Titel). Ist der Titel bei MakerWorld ein anderer, wähle das Modell hier.'),
      el('div', { class: 'row' }, sel, el('button', { class: 'btn primary sm', onclick: async () => { if (!sel.value) return toast('Erst ein Modell wählen.');
        const r = await jpost('/crm/projects/' + id + '/link', { design_id: sel.value }); if (r.error) return toast(r.error); await loadOverview(); toast('Verknüpft.'); openProject(id); } }, 'Verknüpfen')))));
  }

  // ---- Testdruck & Kosten (manuell, bis das Modell veroeffentlicht ist) ----
  const num = (key, label, ph) => { const i = el('input', { type: 'number', step: '0.01', value: p[key] ?? '', placeholder: ph, style: 'width:90px' }); i.oninput = () => { p[key] = i.value; drawRes(); persist(); }; return el('div', { class: 'row', style: 'margin:0' }, el('label', { style: 'min-width:96px' }, label), i); };
  const catalog = await api('/parts'); const plist = el('div');
  const drawParts = () => { plist.innerHTML = ''; if (!parts.length) plist.append(el('div', { class: 'muted' }, 'Keine Teile.'));
    parts.forEach(pp => { const q = el('input', { type: 'number', step: '0.5', value: pp.qty, style: 'width:60px' });
      q.onchange = async () => { const r = await jpost('/project-parts/' + pp.id, { qty: +q.value }, 'PUT'); parts = r.parts || parts; drawParts(); drawRes(); };
      plist.append(el('div', { class: 'checkline' }, q, el('span', { style: 'flex:1' }, pp.name, el('span', { class: 'muted' }, ' · ' + eur(pp.unit_price) + '/' + (pp.unit || 'Stk'))), el('span', { class: 'num' }, eur((pp.qty || 0) * (pp.unit_price || 0))),
        el('button', { class: 'btn sm ghost', onclick: async () => { const r = await api('/project-parts/' + pp.id, { method: 'DELETE' }); parts = r.parts || []; drawParts(); drawRes(); } }, '✕'))); }); };
  drawParts();
  const partSel = el('select', {}, el('option', { value: '' }, catalog.length ? '— Teil wählen —' : 'Katalog leer → unter „Bauteile" anlegen'), catalog.map(c => el('option', { value: c.id }, c.name)));
  const partQty = el('input', { type: 'number', step: '0.5', value: 1, style: 'width:60px' });
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Testdruck & Kosten'),
    el('div', { class: 'bd' }, el('div', { class: 'muted', style: 'font-size:11px;margin-bottom:6px' }, 'Gewicht und Druckzeit aus deinem Slicer (Testdruck). Nach dem Upload kommen die echten Druckprofile und der MakerWorld-Ertrag automatisch dazu.'),
      num('filament_g', 'Filament (g)', 'Gramm'), num('print_hours', 'Druckzeit (h)', 'Stunden'), num('labor_hours', 'Arbeitszeit (h)', 'Stunden'),
      el('div', { class: 'muted', style: 'font-size:11px;margin:8px 0 4px' }, 'Einzelteile'), plist,
      el('div', { class: 'row', style: 'margin-top:8px' }, partSel, partQty, el('button', { class: 'btn primary sm', onclick: async () => { if (!partSel.value) return;
        const r = await jpost('/projects/' + id + '/parts', { part_id: +partSel.value, qty: +partQty.value || 1 }); parts = r.parts || parts; drawParts(); drawRes(); } }, '+ Teil')))));

  // ---- Aufgaben + Loeschen ----
  const tl = el('ul', { class: 'todolist' });
  const drawTodos = ts => { tl.innerHTML = ''; if (!ts.length) tl.append(el('li', { class: 'muted' }, 'Keine Aufgaben.')); ts.forEach(x => tl.append(todoRow(x, async () => { drawTodos((await api('/project/' + id)).todos || []); }))); };
  drawTodos(full.todos || []);
  const tIn = el('input', { placeholder: 'Aufgabe zum Projekt …', style: 'flex:1' }), tDue = el('input', { type: 'date' });
  const addT = async () => { if (!tIn.value.trim()) return; await jpost('/todos', { project_id: id, title: tIn.value.trim(), due_date: tDue.value || null }); tIn.value = ''; tDue.value = ''; drawTodos((await api('/project/' + id)).todos || []); loadOverview(); };
  tIn.addEventListener('keydown', e => { if (e.key === 'Enter') addT(); });
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Aufgaben'), el('div', { class: 'bd' }, tl, el('div', { class: 'row', style: 'margin-top:8px' }, tIn, tDue, el('button', { class: 'btn primary sm', onclick: addT }, '+')))));
  body.append(el('div', { class: 'card' }, el('div', { class: 'bd row' }, el('button', { class: 'btn sm ghost', onclick: async () => { await delWithUndo('/projects/' + id, 'Projekt', () => openProject(id)); closeDrawer(); loadOverview(); if (CUR_ROUTE === 'selbst') renderSelfProjects(); } }, 'Projekt löschen'))));
}
