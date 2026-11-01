// Barrierefreiheit: automatische Labels/Tooltips, Dialog-Fokus.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
// ---- Barrierefreiheit: Labels, Dialog-Fokus ------------------------------------
// Felder ohne Beschriftung bekommen automatisch ein aria-label (Placeholder, Titel, Label in der Zeile oder
// Spaltenkopf); Diagramme einen Text aus der Kartenueberschrift. Laeuft nach jedem Rendern (gedrosselt).
function autoLabel() {
  document.querySelectorAll('input:not([type=hidden]):not([aria-label]), select:not([aria-label]), textarea:not([aria-label])').forEach(f => {
    if ((f.labels && f.labels.length) || f.closest('label')) return;
    let txt = f.getAttribute('placeholder') || f.getAttribute('title') || '';
    if (!txt) { let p = f.previousElementSibling; while (p && p.tagName !== 'LABEL') p = p.previousElementSibling; txt = p ? p.textContent : ''; }
    if (!txt) { const row = f.closest('.row, .checkline'); const lb = row && row.querySelector('label'); txt = lb ? lb.textContent : ''; }
    if (!txt && f.closest('td')) { const td = f.closest('td'), th = td.closest('table')?.querySelectorAll('thead th')[td.cellIndex]; txt = th ? th.textContent : ''; }
    if (!txt) { const card = f.closest('.card'); txt = card?.querySelector('.hd')?.textContent || ''; }
    if (!txt) { const kc = f.closest('.kcard'); if (kc) txt = t('Stufe von ' + (kc.querySelector('.kt')?.textContent || t('Karte'))); }
    if (!txt) { const ps = f.previousElementSibling; txt = ps && ps.tagName !== 'INPUT' && ps.tagName !== 'SELECT' ? ps.textContent : ''; }
    if (!txt && f.type === 'date') txt = t('Datum');
    if (txt) f.setAttribute('aria-label', txt.replace(/\s+/g, ' ').trim().slice(0, 80));
  });
  document.querySelectorAll('canvas:not([aria-label])').forEach(cv => { cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', (cv.closest('.card')?.querySelector('.hd')?.textContent || 'Diagramm').replace(/\s+/g, ' ').trim()); });
  document.querySelectorAll('th:not([title])').forEach(th => { const k = th.textContent.replace(/[▾▴]/g, '').trim(); if (COL_TIPS[k]) th.title = t(COL_TIPS[k]); });
  document.querySelectorAll('.stat .l:not([title])').forEach(l => { const k = l.textContent.trim(); const tip = STAT_TIPS[k]; if (tip) l.title = t(tip); });
  document.querySelectorAll('.close:not([aria-label])').forEach(c => c.setAttribute('aria-label', t('Schließen')));
  const di = document.querySelector('#drawer .drawer-inner'); const h = di && (di.querySelector('.dh h1') || di.querySelector('.dh input'));
  if (di && h) di.setAttribute('aria-label', (h.textContent || h.value || 'Details').trim().slice(0, 80));
}
let _alRaf = 0;
new MutationObserver(() => { if (!_alRaf) _alRaf = requestAnimationFrame(() => { _alRaf = 0; autoLabel(); }); }).observe(document.body, { childList: true, subtree: true });

// Drawer = modaler Dialog: Fokus hinein beim Oeffnen, zurueck beim Schliessen, Tab bleibt im Dialog.
let _drawerReturn = null;
new MutationObserver(() => {
  const d = document.getElementById('drawer'), open = !d.classList.contains('hidden');
  if (open && !d.dataset.open) { d.dataset.open = '1'; _drawerReturn = document.activeElement; setTimeout(() => d.querySelector('.drawer-inner').focus({ preventScroll: true }), 30); }
  else if (!open && d.dataset.open) { delete d.dataset.open; if (_drawerReturn && document.contains(_drawerReturn)) _drawerReturn.focus({ preventScroll: true }); _drawerReturn = null; }
}).observe(document.getElementById('drawer'), { attributes: true, attributeFilter: ['class'] });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMenu();
  const d = document.getElementById('drawer');
  if (e.key !== 'Tab' || d.classList.contains('hidden') || document.querySelector('.modal-scrim')) return;
  const f = [...d.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(x => x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1], inside = d.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside || document.activeElement === d.querySelector('.drawer-inner'))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
});
