// Projekte: Kalkulations-Drawer, Projekt-Board, Eigenprojekte, Bauteile & Kalkulation.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
// ---- Projekt-Kalkulation (Drawer) ----
async function openProject(id) {
  const s = await api('/crm/settings');
  let full = await api('/project/' + id);
  const p = { ...full };                          // veraenderbarer Zustand
  let parts = full.parts || [];
  let items = full.items || [];                   // Druckpositionen (mehrere Modelle/Profile)
  const instCache = {};                           // design_id -> instances[]
  const loadInstances = async did => { if (!did) return []; if (instCache[did]) return instCache[did];
    try { return instCache[did] = (await api('/model/' + did + '/instances')); } catch { return instCache[did] = []; } };
  const inner = $('#drawer .drawer-inner'); inner.innerHTML = '';
  $('#drawer').classList.remove('hidden');
  let saveT;
  const persist = () => { clearTimeout(saveT); saveT = setTimeout(async () => {
    const saved = await jpost('/projects/' + id, { title: p.title, stage: p.stage, design_id: p.design_id, filament_g: +p.filament_g || null,
      print_hours: +p.print_hours || null, labor_hours: +p.labor_hours || null, margin_tier: p.margin_tier,
      price: (p.price === '' || p.price == null) ? null : +p.price, paid: p.paid ? 1 : 0, qty: +p.qty || 1,
      kind: p.kind || 'modell_print', no_upload: p.no_upload ? 1 : 0, no_upload_fee: +p.no_upload_fee || 0,
      close_date: p.close_date || null, due_date: p.due_date || null, priority: p.priority ?? 1 }, 'PUT');
    if (saved && saved.error) toast('Nicht gespeichert: ' + saved.error);
    await loadOverview();
  }, 500); };

  const res = el('div', { class: 'stats' });
  // Kalkulation kommt vom Server (computeProject); hier nur Anzeige. drawRes() holt nach kurzer Pause (Tippen) das Ergebnis.
  let calc = full.calc, calcSeq = 0, calcTimer;
  const drawRes = () => { clearTimeout(calcTimer); calcTimer = setTimeout(async () => {
      const my = ++calcSeq;
      const r = await jpost('/crm/calc', { project: { filament_g: p.filament_g, print_hours: p.print_hours, labor_hours: p.labor_hours, margin_tier: p.margin_tier,
        price: p.price, no_upload: p.no_upload, no_upload_fee: p.no_upload_fee }, parts, items }).catch(() => null);
      if (my === calcSeq && r && !r.error) { calc = r; renderRes(calc); } }, 120); };
  const renderRes = (c) => { res.innerHTML = '';
    syncManualInputs(c);
    const mwE = p.mw?.earned || 0;
    const total = +((c.price - c.material) + mwE).toFixed(2);
    const tile = (v, l, cls, d) => el('div', { class: 'stat' }, el('div', { class: 'v ' + (cls || '') }, v), el('div', { class: 'l' }, l), d ? el('div', { class: 'd muted' }, d) : null);
    if (p.self) {   // Eigenprojekt: eigene Kosten + MakerWorld-Ertrag, kein Kundenpreis
      const selfBal = +(mwE - c.cost).toFixed(2);
      res.append(
        tile(eur(c.material), 'Material (Sach)'),
        tile(eur(c.cost), 'Selbstkosten', '', 'inkl. Arbeitszeit'),
        tile(eur(mwE), 'MakerWorld-Ertrag', mwE > 0 ? 'pos' : 'muted', p.mw ? `${fmt(p.mw.download)} Downloads · ${fmt(p.mw.point)} Punkte` : (p.design_id ? '' : 'noch nicht veröffentlicht')),
        tile(eur(selfBal), 'Bilanz', selfBal >= 0 ? 'pos' : 'neg', 'MakerWorld − Selbstkosten'));
      return;
    }
    const modelOnly = p.kind === 'modell';
    const tiles = [
      tile(eur(c.material), 'Material (Sach)'),
      c.free ? tile(eur(c.loss), 'Verlust', 'neg') : tile(eur(c.price), 'Preis', 'pos'),
      tile(eur(c.profit), 'Gewinn direkt', c.profit >= 0 ? 'pos' : 'neg')];
    if (!modelOnly || p.design_id) tiles.push(
      tile(eur(mwE), 'MakerWorld-Ertrag', mwE > 0 ? 'pos' : 'muted', p.mw ? `${fmt(p.mw.download)} Downloads · ${fmt(p.mw.point)} Punkte` : 'kein Modell verknüpft'),
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
  const pathStages = () => stagesOf(p).filter(sd => sd[0] !== 'abgebrochen' && sd[0] !== 'ausgeliefert');
  const lastStage = () => pathStages().slice(-1)[0][0];   // 'fertig' bzw. 'publish' (Eigenprojekt)
  const setStage = (v) => {
    if (v === 'ausgeliefert' && !isSettled(p)) { toast('Erst nach Zahlung: „Bezahlt" setzen — Ausliefern läuft über die Aufgabe.'); stageSel.value = p.stage; return; }
    p.stage = v; stageSel.value = v; applyKind(); persist(); drawPath();
    if (v === lastStage() && !p.close_date) { p.close_date = today(); closeDateI.value = p.close_date; } };
  function drawPath() { const st = pathStages(); pathWrap.innerHTML = ''; pathWrap.append(stagePath(st, p.stage, setStage));
    const done = p.stage === lastStage(); markBtn.disabled = done; markBtn.textContent = t(done ? 'Abgeschlossen' : 'Stufe abschließen'); }
  markBtn.onclick = () => { const order = pathStages().map(s => s[0]); const i = order.indexOf(p.stage); if (i > -1 && i < order.length - 1) setStage(order[i + 1]); };
  // Priorität + Deadline (alle Projekte) — zum Strukturieren, was wann drankommt.
  const prioSel = mkSelect(PRIORITIES, String(p.priority ?? 1));
  prioSel.onchange = () => { p.priority = +prioSel.value; persist(); };
  const dueI = el('input', { type: 'date', value: p.due_date || '' });
  dueI.onchange = () => { p.due_date = dueI.value || null; persist(); };
  const titleI = el('input', { value: p.title || '', 'aria-label': 'Projekttitel', style: 'font-size:14px;font-weight:600;flex:1;min-width:200px' });
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
  const tierSel = mkSelect([...(s.tiers || []).map(t => [t.name, t.name + ' (' + Math.round(t.margin * 100) + '%)' + (t.default ? ' – Standard' : '')]), ['kostenlos', 'Kostenlos (nur Material)']], p.margin_tier || s.default_tier || 'Standard');
  tierSel.onchange = () => { p.margin_tier = tierSel.value; drawRes(); persist(); applyKind(); };
  const priceI = el('input', { type: 'number', step: '0.5', value: p.price ?? '', placeholder: 'Vorschlag', style: 'width:100px' });
  const priceHint = el('span', { class: 'muted', style: 'font-size:11px' });
  priceI.oninput = () => { p.price = priceI.value; drawRes(); persist(); applyKind(); };
  const refreshMw = async () => { if (!p.design_id) { p.mw = null; drawRes(); return; }
    try { p.mw = await api('/crm/model-earned/' + p.design_id); } catch { p.mw = null; } drawRes(); };
  const modelSel = modelSelect(p.design_id); modelSel.onchange = () => { p.design_id = modelSel.value || null; applyKind(); persist(); refreshMw(); };
  const fillFromModel = el('button', { class: 'btn sm ghost', title: 'Filament & Druckzeit aus dem Standard-Druckprofil (× Stückzahl)', onclick: async () => {
    if (!p.design_id) return toast('Erst ein Modell wählen.');
    const inst = (await api('/model/' + p.design_id + '/instances'))[0];
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
    applyKind(); refreshMw(); await loadOverview(); toast(r.design_id?.startsWith('plan_') ? 'Als geplantes Modell angelegt (erscheint unter Ideen & Entwürfe)' : 'Als veröffentlicht markiert'); } },
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
    fileInfo.textContent = t('lädt …');
    const data = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
    const r = await jpost('/projects/' + id + '/file', { name: f.name, data });
    if (r.error) { fileInfo.textContent = p.file_name || 'keine Datei'; return toast(r.error); }
    p.file_name = r.file_name; fileInfo.textContent = p.file_name + ' (' + Math.round(r.size / 1024) + ' KB)'; fileIn.value = ''; toast('3mf angehängt'); };
  const fileDel = el('button', { class: 'btn sm ghost', onclick: async () => { await api('/projects/' + id + '/file', { method: 'DELETE' }); p.file_name = null; fileInfo.textContent = t('keine Datei'); toast('Datei entfernt'); } }, 'entfernen');
  const fileRow = el('div', { class: 'row', style: 'margin:0' },
    el('label', { style: 'min-width:96px' }, '3mf-Datei'), fileIn, fileInfo, fileDel,
    el('span', { class: 'muted', style: 'font-size:11px' }, '— zum Download im Statuslink'));
  const artRow = el('div', { class: 'row', style: 'margin:0' }, el('label', { style: 'min-width:96px' }, 'Art'), kindSel,
    el('span', { class: 'muted', style: 'font-size:11px' }, 'nur Modellarbeit = kein Druck (Statuslink ohne Druck-Schritt)'));
  const qtyMarginRow = el('div', { class: 'row' }, el('label', { style: 'min-width:96px' }, 'Stückzahl'), qtyI, el('label', { style: 'min-width:96px' }, 'Margen-Stufe'), tierSel);
  const paidWrap = el('label', { style: 'margin-left:12px;display:flex;align-items:center;gap:6px' }, paidCb, 'bezahlt');
  const priceRow = el('div', { class: 'row' }, el('label', { style: 'min-width:96px' }, 'Preis (€)'), priceI, priceHint, paidWrap);
  body.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Kalkulation'),
    el('div', { class: 'bd' }, artRow, modelRow, mwRow, gInput, phInput, lhInput, qtyMarginRow, priceRow, exclRow, fileRow)));

  // ---- Druckpositionen (mehrere Modelle/Profile mit eigener Stückzahl) ----
  const posHint = el('span', { class: 'muted', style: 'font-weight:400;text-transform:none' }, '');
  function syncManualInputs(c) {
    const gi = gInput.querySelector('input'), pi = phInput.querySelector('input');
    if (c.hasItems) {
      gi.value = Math.round(c.filamentG); pi.value = +c.printH.toFixed(2);
      gi.disabled = pi.disabled = true; gi.title = pi.title = t('Aus Druckpositionen berechnet');
      posHint.textContent = t('Filament & Druckzeit werden aus den Positionen summiert.');
    } else {
      gi.disabled = pi.disabled = false; gi.title = pi.title = '';
      posHint.textContent = t('Optional: mehrere Profile/Modelle je Projekt (z.B. 2× dasselbe Bett + 1× anderes).');
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
        el('button', { class: 'btn sm ghost', onclick: async () => { const r = await api('/project-items/' + it.id, { method: 'DELETE' }); items = r.items || []; drawItems(); drawRes(); loadOverview(); if (r.trash_id) toastUndo('Position gelöscht', r.trash_id, async () => { const nd = await api('/project/' + id); items = nd.items || []; drawItems(); drawRes(); loadOverview(); }); } }, '✕')));
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
    // Kostenlos: es gibt nichts zu bezahlen -> „bezahlt"-Häkchen ausblenden.
    const free = p.margin_tier === 'kostenlos' || (p.price != null && p.price !== '' && +p.price <= 0);
    paidWrap.style.display = free ? 'none' : '';
    exclRow.style.display = (!self && modelOnly) ? '' : 'none';
    fileRow.style.display = (!self && modelOnly) ? '' : 'none';
    const exclusive = !!p.no_upload;
    // MakerWorld-Zuordnung: Eigenprojekt immer (Veröffentlichen ist das Ziel);
    // bei Modellarbeit erst nach Fertigstellung; nie bei Exklusiv.
    const showUpload = self ? true : (modelOnly ? (!exclusive && (p.stage === 'fertig' || !!p.design_id)) : true);
    modelRow.style.display = mwRow.style.display = showUpload ? '' : 'none';
    modelLabel.textContent = t((self || modelOnly) ? 'MW-Upload' : 'Modell');
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
        el('button', { class: 'btn sm ghost', onclick: async () => { const r = await api('/project-parts/' + pp.id, { method: 'DELETE' }); parts = r.parts || []; drawParts(); drawRes(); loadOverview(); if (r.trash_id) toastUndo('Teil entfernt', r.trash_id, async () => { const nd = await api('/project/' + id); parts = nd.parts || []; drawParts(); drawRes(); loadOverview(); }); } }, '✕'))); }); };
  drawParts();
  const partSel = el('select', {}, el('option', { value: '' }, catalog.length ? '— Teil wählen —' : 'Katalog leer → unter „Bauteile" anlegen'), catalog.map(c => el('option', { value: c.id }, `${c.name} · ${eur(c.unit_price)}`)));
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
        try { await navigator.clipboard.writeText(url); toast('Statuslink kopiert'); } catch { await askText({ title: 'Statuslink', text: 'Zum Kopieren und Verschicken:', value: url, readonly: true, okText: 'Schließen' }); }
        window.open(url, '_blank');
      } }, 'Statuslink'));
  }
  actionBtns.push(el('button', { class: 'btn sm ghost', onclick: async () => { const cid = p.contact_id; const self = p.self; await delWithUndo('/projects/' + id, 'Projekt', () => openProject(id)); if (self) { closeDrawer(); go('selbst'); } else if (cid) openContact(cid); else closeDrawer(); } }, 'Projekt löschen'));
  body.append(el('div', { class: 'card' }, el('div', { class: 'bd row' }, ...actionBtns)));
  renderRes(calc);   // erster Stand direkt aus der Server-Antwort; Aenderungen laufen ueber drawRes()
}

// ---- Projekt-Pipeline (Kanban) ----
async function renderProjekte() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Projekte', 'Von der Anfrage bis Fertig. Die Phase „Modellieren" lässt sich überspringen (direkt auf Drucken).');
  const list = await api('/crm/projects');
  const board = el('div', { class: 'board' });
  // Ziel-Stufe setzen (Drag & Drop / Dropdown); Server lehnt "ausgeliefert" ohne Zahlung ab.
  const moveTo = async (id, stage) => { const r = await jpost('/projects/' + id, { stage }, 'PUT'); if (r && r.error) toast(r.error); renderProjekte(); };
  const mkCard = p => { const c = p.calc || {};
    const sel = mkSelect(PROJECT_STAGES, p.stage || 'anfrage', 'sm'); sel.onclick = e => e.stopPropagation();
    sel.onchange = async e => { e.stopPropagation(); await moveTo(p.id, sel.value); };
    const card = el('div', { class: 'kcard', onclick: () => openProject(p.id) },
      el('div', { class: 'kt' }, p.title),
      el('div', { class: 'krow' }, prioBadge(p.priority), deadlineBadge(p.due_date)),
      el('div', { class: 'muted', style: 'font-size:11px' }, p.contact_name + (p.model_title ? ' · ' + p.model_title : '')),
      el('div', { class: 'muted num', style: 'font-size:11px' }, c.free ? 'gratis · Verlust ' + eur(c.loss) : `${eur(c.price)} · Kosten ${eur(c.cost)}`), sel);
    dndCard(card, p.id);
    return card;
  };
  let archOpen = localStorage.getItem('proj_arch_open') === '1';   // Archiv-Spalte per Default eingeklappt
  PROJECT_STAGES.forEach(([sv, sl]) => {
    const members = list.filter(p => (p.stage || 'anfrage') === sv).sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
    if (sv === 'ausgeliefert') {   // schlanke, standardmäßig eingeklappte Archiv-Spalte ganz rechts
      const col = el('div', { class: 'col arch' + (archOpen ? '' : ' collapsed') });
      const toggle = () => { archOpen = !archOpen; localStorage.setItem('proj_arch_open', archOpen ? '1' : '0'); renderProjekte(); };
      col.append(el('div', { class: 'colhd arch-hd', style: `border-top:3px solid ${PSTAGE_COLOR[sv]}`, title: archOpen ? 'Einklappen' : 'Ausklappen', onclick: toggle },
        el('span', { class: 'arch-caret' }, archOpen ? '▾' : '▸'), el('span', { class: 'arch-lbl' }, sl), el('span', { class: 'cnt' }, members.length)));
      dndColumn(col, sv, moveTo);
      if (archOpen) {
        members.forEach(p => col.append(mkCard(p)));
        if (!members.length) col.append(el('div', { class: 'muted', style: 'padding:8px' }, '—'));
      }
      board.append(col); return;
    }
    const col = el('div', { class: 'col' }, el('div', { class: 'colhd', style: `border-top:3px solid ${PSTAGE_COLOR[sv]}` }, sl, el('span', { class: 'cnt' }, members.length)));
    dndColumn(col, sv, moveTo);
    members.forEach(p => col.append(mkCard(p)));
    if (!members.length) col.append(el('div', { class: 'muted', style: 'padding:8px' }, '—'));
    board.append(col);
  });
  w.append(board);
}

// ---- Eigenprojekte (kein Kunde): Modellieren → Drucken → Fotos → MW-Eintrag → Veröffentlicht ----
async function renderSelfProjects() {
  if (!STATE.overview) await loadOverview();
  const w = pagehead('Eigenprojekte', 'Eigene Modelle planen: modellieren, drucken, fotografieren, MakerWorld-Eintrag erstellen und veröffentlichen. Ohne Kunde.');
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
  const w = pagehead('Bauteile & Kalkulation', 'Bauteil-Katalog und globale Kalkulationsparameter für die Preisbildung.');
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
      const df = el('input', { type: 'radio', name: 'deftier' }); df.checked = !!t.default;
      df.onchange = () => { tiers.forEach(x => { delete x.default; }); t.default = true; };
      tierWrap.append(el('div', { class: 'row', style: 'margin:2px 0' }, nm, mg, el('span', { class: 'muted' }, '% Marge'),
        el('label', { class: 'muted', style: 'display:flex;align-items:center;gap:4px', title: 'Wird für neue Projekte und Projekte ohne Stufe verwendet' }, df, 'Standard'),
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
      el('div', { style: 'margin-top:10px' }, el('label', { class: 'muted' }, 'Margen-Stufen (eine für Freunde niedriger). „Standard" gilt für neue Projekte und Projekte ohne Stufe:'), tierWrap),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn primary sm', onclick: saveSettings }, 'Speichern')))));

  // Bauteil-Katalog
  const parts = await api('/parts');
  const nName = el('input', { placeholder: 'Teil (z.B. Neodym-Magnet 8×3)', style: 'flex:1;min-width:180px' });
  const nCat = mkSelect(PART_CATEGORIES, 'magnet'); const nUnit = el('input', { value: 'Stk', style: 'width:60px' });
  const nPrice = el('input', { type: 'number', step: '0.01', placeholder: '€/Einheit', style: 'width:90px' });
  const addPart = async () => { if (!nName.value.trim()) return; await jpost('/parts', { name: nName.value.trim(), category: nCat.value, unit: nUnit.value, unit_price: +nPrice.value || 0 }); nName.value = ''; nPrice.value = ''; renderParts(); };
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Bauteil-Katalog (${parts.length})`),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, nName, nCat, nUnit, nPrice, el('button', { class: 'btn primary sm', onclick: addPart }, '+ Teil')))));
  if (parts.length) {
    const wrap = el('div', { class: 'tablewrap' }); w.append(wrap);
    wrap.append(el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Teil'), el('th', {}, 'Kategorie'), el('th', {}, 'Einheit'), el('th', { class: 'n' }, 'Preis'), el('th', {}, ''))),
      el('tbody', {}, parts.map(pt => { const pr = el('input', { type: 'number', step: '0.01', value: pt.unit_price, style: 'width:80px' });
        pr.onchange = () => jpost('/parts/' + pt.id, { unit_price: +pr.value }, 'PUT').then(() => toast('Preis aktualisiert.'));
        return el('tr', {}, el('td', { class: 'title' }, pt.name), el('td', {}, labelOf(PART_CATEGORIES, pt.category)), el('td', {}, pt.unit),
          el('td', { class: 'n' }, pr), el('td', {}, el('button', { class: 'btn sm ghost', onclick: async () => { await delWithUndo('/parts/' + pt.id, 'Bauteil', () => renderParts()); renderParts(); } }, '✕'))); }))));
  }
}
