// "Heute"-Dashboard und globale Suche.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
// ============ HEUTE (Aktions-Dashboard) ============
async function renderHeute() {
  const d = await api('/today');
  const w = pagehead('Heute', 'Tagesübersicht: offene Zahlungen, fällige Aufgaben, Hinweise und Änderungen.');
  const tile = (v, l, cls) => el('div', { class: 'stat' }, el('div', { class: 'v ' + (cls || '') }, fmt(v)), el('div', { class: 'l' }, l));
  if (d.issues && d.issues.length) {   // Systemhinweise nur, wenn etwas nicht stimmt
    const bx = el('div', { class: 'card issues' }, el('div', { class: 'hd' }, 'Systemhinweise', el('a', { onclick: () => go('data'), style: 'font-weight:400;text-transform:none;font-size:11px' }, 'Details →')));
    d.issues.forEach(i => bx.append(el('div', { class: 'issue ' + i.level }, i.text)));
    w.append(bx);
  }
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
      el('span', { class: 'muted' }, '•'), el('span', { style: 'flex:1' }, m.title), el('span', { class: 'muted num', style: 'font-size:11px' }, dmy(m.date)))));
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
      el('span', { class: 'tag ' + a.type }, ALERT_LABELS[a.type] || a.type), el('b', {}, a.title || 'Global'), el('span', { class: 'muted' }, '— ' + a.text))));
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Alerts (${d.alerts.length})`), al)); }
  if (d.recentChanges.length) { const list = el('ul', { class: 'timeline' });
    d.recentChanges.forEach(c => list.append(el('li', {}, el('span', { class: 'date' }, dmy(c.date)), el('span', { class: 'pill' }, c.type),
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
