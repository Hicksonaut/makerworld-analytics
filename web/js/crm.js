// CRM: Rechnung, Konstanten, Kunden, Leads, Finanzen.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
// ---- Rechnung / Beleg (druckbar) ----
async function openInvoice(pid) {
  const s = await api('/crm/settings'); const seller = s.seller || {};
  if (!seller.name) { if (await askConfirm('Kein Rechnungs-Absender hinterlegt', 'Der Absender gehört auf die Rechnung. Jetzt unter Finanzen eintragen?', 'Zu Finanzen')) { closeDrawer(); go('revenue'); } return; }
  const p = await api('/project/' + pid);
  const c = p.contact_id ? await api('/contact/' + p.contact_id).then(x => x.contact) : {};
  const inv = await jpost('/crm/projects/' + pid + '/invoice-number', {});   // je Projekt stabil, verbraucht beim erneuten Öffnen keine Nummer
  const num = inv.number;
  const qty = p.qty || 1; const total = p.calc?.price || 0; const unit = qty ? total / qty : total;
  const esc = x => String(x || '').replace(/[<>&"']/g, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[m]));
  const dt = dmy(inv.date || today());
  const custName = c.name || p.contact_name || '';
  // Druckpositionen (falls vorhanden) als Detailzeilen unter der Hauptposition.
  const posLines = (p.items || []).map(it => `<div class=detail>• ${esc(it.label || it.model_title || t('Position'))} — ${it.qty}×</div>`).join('');
  const fnameSafe = s2 => String(s2 || '').replace(/[^\w äöüÄÖÜß.-]/g, '').trim().replace(/\s+/g, '_');
  const title = `${t('Rechnung')}_${num}_${fnameSafe(custName) || t('Kunde')}`;
  const html = `<!doctype html><html lang=${LANG.cur}><head><meta charset=utf-8><title>${esc(title)}</title>
  <style>body{font:13px/1.5 -apple-system,system-ui,sans-serif;color:#1a1c1f;max-width:720px;margin:0 auto;padding:40px 24px}
  h1{font-size:22px;margin:0 0 2px}.muted{color:#666}.row{display:flex;justify-content:space-between;margin-top:24px}
  table{width:100%;border-collapse:collapse;margin-top:24px}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;vertical-align:top}
  td.n,th.n{text-align:right}.tot{font-weight:700;font-size:16px}.foot{margin-top:30px;color:#666;font-size:12px}
  .detail{color:#666;font-size:11px;margin-top:2px}
  .bar{position:sticky;top:0;display:flex;gap:8px;align-items:center;background:#f4f5f6;border:1px solid #dcdfe3;border-radius:8px;padding:10px 12px;margin-bottom:20px;font-size:12px}
  .bar b{font-size:13px}.bar button{font:inherit;padding:6px 12px;border:1px solid #c3c7cc;background:#fff;border-radius:6px;cursor:pointer}
  .bar .pri{background:#1f5c8f;color:#fff;border-color:#1f5c8f;font-weight:600}
  @media print{body{margin:0;padding:0}.bar{display:none}}</style></head><body>
  <div class=bar><b>${t('Rechnung')} ${num}</b><span class=muted style="flex:1">${t('→ „Als PDF speichern" und dann selbst per WhatsApp / Mail / AirDrop verschicken.')}</span>
    <button class=pri onclick="window.print()">${t('Als PDF speichern')}</button><button onclick="window.close()">${t('Schließen')}</button></div>
  <div class=row><div><h1>${esc(seller.name)}</h1><div class=muted>${esc(seller.address || '')}<br>${esc(seller.email || '')} ${esc(seller.phone || '')}</div></div>
  <div style="text-align:right"><b>${t('Rechnung')}</b><br>${t('Nr.')} ${num}<br>${dt}</div></div>
  <div style="margin-top:24px"><div class=muted>${t('Rechnung an')}</div><b>${esc(custName)}</b><br>${esc(c.email || '')}</div>
  <table><thead><tr><th>${t('Position')}</th><th class=n>${t('Menge')}</th><th class=n>${t('Einzel')}</th><th class=n>${t('Betrag')}</th></tr></thead>
  <tbody><tr><td>${esc(p.title)}${posLines}</td><td class=n>${qty}</td><td class=n>${unit.toFixed(2)} €</td><td class=n>${total.toFixed(2)} €</td></tr></tbody>
  <tfoot><tr><td colspan=3 class="n tot">${t('Gesamt')}</td><td class="n tot">${total.toFixed(2)} €</td></tr></tfoot></table>
  ${seller.taxnote ? '<div class=foot>' + esc(seller.taxnote) + '</div>' : ''}
  ${seller.iban ? '<div class=foot>' + t('Zahlbar auf: ') + esc(seller.iban) + '</div>' : ''}</body></html>`;
  const wnd = window.open('', '_blank');
  if (!wnd) return toast('Popup blockiert — bitte Popups erlauben.');
  wnd.document.write(html); wnd.document.close(); wnd.focus();
}

// ============ CRM ============
const CONTACT_STAGES = [['neu','Neu'],['kontaktiert','Kontaktiert'],['angebot','Angebot'],['gewonnen','Gewonnen'],['verloren','Verloren']];
const STAGE_COLOR = { neu: '#6b7280', kontaktiert: '#1f5c8f', angebot: '#9a6a00', gewonnen: '#1a7f37', verloren: '#c1332d' };
const SOURCES = [['makerworld','MakerWorld'],['freund','Freund'],['empfehlung','Empfehlung'],['manuell','Manuell']];
const PROJECT_STAGES = [['anfrage','Anfrage'],['modellierung','Modellieren'],['druck','Drucken'],['fertig','Fertig'],['abgebrochen','Abgebrochen'],['ausgeliefert','Ausgeliefert / Archiviert']];
const PSTAGE_COLOR = { anfrage: '#6b7280', modellierung: '#9a6a00', druck: '#1f5c8f', fertig: '#1a7f37', abgebrochen: '#c1332d', ausgeliefert: '#4b5563' };
// beglichen = bezahlt oder kostenlos; Voraussetzung für "ausgeliefert"/archiviert.
const isSettled = p => !!p.paid || p.margin_tier === 'kostenlos' || (p.price != null && p.price <= 0);
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
async function newContact() { const name = await askText({ title: 'Neuer Kunde / Lead', placeholder: 'Name', okText: 'Anlegen' }); if (!name || !name.trim()) return;
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
  const cols = [['Name'],['Quelle'],['Stufe'],['Projekte'],['Umsatz'],['bezahlt'],['offen'],['letztes Projekt']];
  wrap.append(el('table', {},
    el('thead', {}, el('tr', {}, cols.map(([l], i) => el('th', { class: i ? 'n' : '' }, l)))),
    el('tbody', {}, list.map(c => el('tr', { onclick: () => openContact(c.id) },
      el('td', { class: 'title' }, c.name),
      el('td', {}, labelOf(SOURCES, c.source)),
      el('td', {}, el('span', { class: 'tag', style: `background:${STAGE_COLOR[c.stage] || '#6b7280'}` }, labelOf(CONTACT_STAGES, c.stage))),
      el('td', { class: 'n' }, fmt(c.project_count)),
      el('td', { class: 'n' }, eur(c.revenue_total)),
      el('td', { class: 'n pos' }, eur(c.revenue_paid)),
      el('td', { class: 'n' + (c.revenue_open > 0 ? ' neg' : ' muted') }, eur(c.revenue_open)),
      el('td', { class: 'n muted' }, dmy(c.last_project)))))));
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
        el('button', { class: 'btn sm ghost', onclick: async () => { await delWithUndo('/contacts/' + id, 'Kunde inkl. Projekten', () => renderContacts()); closeDrawer(); renderContacts(); } }, 'Kunde löschen')))));

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
        el('button', { class: 'btn sm ghost', onclick: async e => { e.stopPropagation(); await delWithUndo('/projects/' + p.id, 'Projekt', reload); reload(); } }, '✕'))); }); };
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
        el('div', { class: 'muted', style: 'font-size:11px' }, `${labelOf(SOURCES, c.source)} · ${c.project_count} Proj. · ${eur(c.revenue_total)}`), sel);
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
  // Projekte, deren Modell auf MakerWorld Geld/Credits macht ("hat sich gelohnt?")
  if (d.projectModels && d.projectModels.length) {
    // Eine Tabelle; "nur Gratis-Projekte" zeigt die kostenlos modellierten, die trotzdem verdienen.
    let onlyFree = false;
    const tbody = el('tbody');
    const drawPM = () => { tbody.innerHTML = '';
      d.projectModels.filter(r => !onlyFree || r.free).forEach(r => tbody.append(el('tr', r.counted ? {} : { class: 'muted', title: 'Dieses Modell ist oben bereits gezählt (mehrere Projekte nutzen dasselbe Modell) und geht nicht in die Summe ein.' },
        el('td', { class: 'title', style: 'cursor:pointer', onclick: () => openProject(r.project_id) }, r.title,
          r.free ? el('span', { class: 'tag', style: 'background:#9a6a00;margin-left:6px' }, 'gratis') : (r.paid ? el('span', { class: 'tag', style: 'background:#1a7f37;margin-left:6px' }, eur(r.price)) : '')),
        el('td', {}, r.contact_name),
        el('td', { style: 'cursor:pointer', onclick: () => openModel(r.design_id) }, r.model_title || r.design_id),
        el('td', { class: 'n' }, fmt(r.downloads)), el('td', { class: 'n' }, fmt(r.points)),
        el('td', { class: 'n ' + (r.counted ? 'pos' : 'muted') }, eur(r.mwEarned) + (r.counted ? '' : ' *')),
        el('td', { class: 'n ' + (r.net >= 0 ? 'pos' : 'neg') }, eur(r.net))))); };
    drawPM();
    const wrap = el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {},
      el('th', {}, 'Projekt'), el('th', {}, 'Kunde'), el('th', {}, 'Modell'),
      el('th', { class: 'n' }, 'Downloads'), el('th', { class: 'n' }, 'Punkte'),
      el('th', { class: 'n' }, 'MakerWorld €'), el('th', { class: 'n' }, 'netto'))), tbody));
    const freeCb = el('input', { type: 'checkbox' }); freeCb.onchange = () => { onlyFree = freeCb.checked; drawPM(); };
    w.append(el('div', { class: 'card' },
      el('div', { class: 'hd' }, 'Projekte → MakerWorld-Ertrag', el('span', { class: 'row', style: 'margin:0;font-weight:400;text-transform:none' },
        el('label', { class: 'checkline' }, freeCb, 'nur Gratis-Projekte'), el('span', { class: 'muted' }, t('Summe') + ' ' + eur(d.projectModelsTotal)))),
      el('div', { class: 'bd muted', style: 'padding-bottom:0' }, 'Privat entstandene Projekte, deren hochgeladenes Modell danach über Downloads/Punkte Geld einbringt. „netto" = MakerWorld-Ertrag − Materialeinsatz des Projekts. Zeilen mit * nutzen ein Modell, das weiter oben schon gezählt ist, und gehen nicht in die Summe ein. Gratis-Projekte: kostenlos modelliert, aber das Modell verdient über Punkte.'), wrap));
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
      el('tbody', {}, list.length ? list.map(e => el('tr', {}, el('td', { class: 'num' }, dmy(e.date)), el('td', {}, labelOf(EXP_CAT, e.category)), el('td', {}, e.description || '–'), el('td', { class: 'n neg' }, eur(e.amount)),
        el('td', {}, el('button', { class: 'btn sm ghost', onclick: async () => { await delWithUndo('/expenses/' + e.id, 'Ausgabe', () => renderRevenue()); renderRevenue(); } }, '✕'))))
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
      el('tbody', {}, list.length ? list.map(o => el('tr', {}, el('td', { class: 'num' }, dmy(o.date)), el('td', { class: 'n' }, fmt(o.points)), el('td', { class: 'n pos' }, eur(o.amount)), el('td', {}, o.note || '–'),
        el('td', {}, el('button', { class: 'btn sm ghost', onclick: async () => { await delWithUndo('/payouts/' + o.id, 'Auszahlung', () => renderRevenue()); renderRevenue(); } }, '✕'))))
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
