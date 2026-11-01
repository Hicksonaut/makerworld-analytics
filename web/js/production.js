// Produktion: Druckplan und Filament-Lager.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
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
      el('td', {}, el('button', { class: 'btn sm ghost', title: 'Zurücknehmen', onclick: async () => { const r = await jpost('/crm/production/unprint', { item_id: j.id }); if (r.spool) toast(`Zurückgenommen · ${Math.round(r.spool.remaining_g)} g Rest auf Spule`); renderDruckplan(); } }, '−'))));
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
        el('button', { class: 'btn sm ghost', onclick: async () => { await delWithUndo('/spools/' + s.id, 'Spule', () => renderMaterial()); renderMaterial(); } }, '✕')));
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
