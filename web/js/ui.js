// UI-Bausteine: Diagramm-Optionen, Hinweise (toast), Rueckgaengig, Eingabedialoge.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
// ---- Helpers ----
function chartOpts() {
  return { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#1a1c1f', boxWidth: 10, font: { size: 11 } } }, tooltip: { backgroundColor: '#fff', titleColor: '#1a1c1f', bodyColor: '#1a1c1f', borderColor: '#c3c7cc', borderWidth: 1 } },
    scales: { x: { type: 'category', ticks: { color: '#5b6169', maxTicksLimit: 12, font: { size: 10 } }, grid: { color: '#e3e5e8' } }, y: { ticks: { color: '#5b6169', font: { size: 10 } }, grid: { color: '#e3e5e8' } } } };
}
function toast(msg) { const t = el('div', { style: 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#1a1c1f;color:#fff;border:1px solid #000;padding:8px 16px;z-index:99;font-size:12px' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }

// ---- Papierkorb / Rueckgaengig -------------------------------------------------------------------------
// Geloeschtes landet 30 Tage im Papierkorb (Server). Der Hinweis bietet "Rückgängig"; danach laeuft `after` (Ansicht neu laden).
function toastUndo(msg, trashId, after) {
  const bar = el('div', { class: 'toast undo', role: 'status' }, el('span', {}, msg),
    el('button', { class: 'btn sm', onclick: async () => {
      bar.remove(); const r = await api('/trash/' + trashId + '/restore', { method: 'POST' });
      if (r && r.ok) { toast('Wiederhergestellt: ' + (r.label || '')); if (after) await after(); } else toast((r && r.error) || 'Wiederherstellen nicht möglich.');
    } }, 'Rückgängig'));
  // Mehrere Hinweise stapeln sich nach oben statt sich zu verdecken.
  bar.style.bottom = (16 + document.querySelectorAll('.toast.undo').length * 46) + 'px';
  document.body.append(bar); setTimeout(() => bar.remove(), 9000);
}
// DELETE ausfuehren und Rueckgaengig anbieten; liefert die Server-Antwort.
async function delWithUndo(path, label, after) {
  const r = await api(path, { method: 'DELETE' });
  if (r && r.trash_id) toastUndo(label + ' gelöscht', r.trash_id, after); else if (r && r.error) toast(r.error);
  return r;
}
// ---- Eingabedialoge (statt prompt/confirm des Browsers; mit Fokus, Enter/Esc, Tastatur) ------------------
function modalDialog({ title, text, value, placeholder, okText = 'OK', cancelText = 'Abbrechen', input = true, readonly = false }) {
  return new Promise(resolve => {
    const prev = document.activeElement;
    const inp = input ? el('input', { type: 'text', value: value || '', placeholder: placeholder || '', 'aria-label': title, readonly: readonly || null, style: 'width:100%' }) : null;
    const done = v => { scrim.remove(); if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); resolve(v); };
    const ok = el('button', { class: 'btn primary', onclick: () => done(input ? inp.value : true) }, okText);
    const cancel = readonly ? null : el('button', { class: 'btn', onclick: () => done(input ? null : false) }, cancelText);
    const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('h2', {}, title), text ? el('p', { class: 'muted' }, text) : null, inp, el('div', { class: 'row modal-btns' }, cancel, ok));
    const scrim = el('div', { class: 'modal-scrim' }, box);
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.stopPropagation(); done(input ? null : false); }
      else if (e.key === 'Enter' && e.target !== cancel) { e.preventDefault(); ok.click(); }
      else if (e.key === 'Tab') { const f = [...box.querySelectorAll('input,button')]; const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } }
    });
    scrim.addEventListener('mousedown', e => { if (e.target === scrim && !readonly) done(input ? null : false); });
    document.body.append(scrim); (inp || ok).focus(); if (inp) inp.select();
  });
}
const askText = o => modalDialog({ ...o, input: true });
const askConfirm = (title, text, okText) => modalDialog({ title, text, okText: okText || 'OK', input: false });
