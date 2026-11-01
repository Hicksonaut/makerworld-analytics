// System: Daten & Pull, Pull-Status, Aktualisierung nach dem Pull.
// (Teil der MakerWorld-Analytics-Oberflaeche; klassische Skripte teilen sich den globalen Namensraum, Ladereihenfolge siehe index.html.)
async function renderData() {
  const s = await api('/settings');
  const login = await api('/login/status').catch(() => ({ error: 'x' }));
  const w = pagehead('Daten & Pull', 'Datenabruf, Zeitplanung und Import.');
  // Sprache / Language
  const langSel = mkSelect([['de', 'Deutsch'], ['en', 'English']], LANG.cur);
  langSel.onchange = () => setLang(langSel.value);
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Sprache / Language'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, el('label', { style: 'min-width:150px' }, 'Sprache'), langSel,
      el('span', { class: 'muted', style: 'font-size:11px' }, 'Umschalten zwischen Deutsch (Fachbegriffe) und Englisch.')))));
  // Systemstatus (Pull, Backup, Speicher) — damit Probleme auffallen, bevor Zahlen veralten.
  const hl = await api('/health').catch(() => null);
  if (hl) {
    const row = (k, v, cls) => el('div', { class: 'checkline' }, el('span', { style: 'flex:1' }, k), el('span', { class: 'num ' + (cls || '') }, v));
    const ageTxt = h => h == null ? '–' : h < 1 ? Math.max(1, Math.round(h * 60)) + ' Min' : h < 48 ? (Math.round(h * 10) / 10) + ' h' : Math.round(h / 24) + ' Tage';
    const mb = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB';
    const lr = hl.lastRun;
    w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Systemstatus', hl.issues.length ? el('span', { class: 'tag err' }, hl.issues.length + ' Hinweis(e)') : el('span', { class: 'tag ok' }, 'alles in Ordnung')),
      el('div', { class: 'bd' },
        ...hl.issues.map(i => el('div', { class: 'issue ' + i.level }, i.text)),
        row('Letzter Pull', lr ? `${nice(lr.finished_at || lr.started_at)} · ${lr.status} · ${lr.models_ok ?? 0} ok / ${lr.models_failed ?? 0} Fehler` : '–', lr && lr.status === 'error' ? 'neg' : ''),
        row('Letzter erfolgreicher Pull', hl.pullAgeH != null ? `vor ${ageTxt(hl.pullAgeH)}` : '–', hl.pullAgeH > 36 ? 'neg' : ''),
        row('Letztes Backup', hl.backup ? `${nice(hl.backup.at)} · ${hl.backup.count} Dateien (${mb(hl.backup.bytes)})` : 'keins gefunden', hl.backup && hl.backup.ageH <= 36 ? '' : 'neg'),
        row('Datenbank', mb(hl.dbBytes), hl.dbBytes > 1e9 ? 'neg' : ''),
        row('Freier Speicherplatz', hl.diskFreeGb != null ? hl.diskFreeGb + ' GB' : '–', hl.diskFreeGb != null && hl.diskFreeGb < 5 ? 'neg' : ''),
        row('Freier Arbeitsspeicher', hl.memAvailableMb != null ? hl.memAvailableMb + ' MB' : '–', hl.memAvailableMb != null && hl.memAvailableMb < 300 ? 'neg' : ''),
        row('Dienst läuft seit', ageTxt(hl.uptimeH)))));
  }
  // Papierkorb: Geloeschtes ist 30 Tage wiederherstellbar.
  const trash = await api('/trash').catch(() => []);
  const KIND = { todo: 'Aufgabe', event: 'Änderungseintrag', view: 'Segment', expense: 'Ausgabe', payout: 'Auszahlung', part: 'Bauteil', spool: 'Spule', item: 'Druckposition', partlink: 'Teil im Projekt', model: 'Geplantes Modell', project: 'Projekt', contact: 'Kunde inkl. Projekten' };
  const trashBody = el('div', { class: 'bd' });
  if (!trash.length) trashBody.append(el('span', { class: 'muted' }, 'Leer. Gelöschte Kunden, Projekte, Aufgaben usw. liegen hier 30 Tage und lassen sich wiederherstellen.'));
  trash.forEach(tr => trashBody.append(el('div', { class: 'checkline' },
    el('span', { class: 'tag', style: 'background:#6b7280' }, KIND[tr.kind] || tr.kind), el('span', { style: 'flex:1' }, tr.label || '—'),
    el('span', { class: 'muted', style: 'font-size:11px' }, 'noch ' + tr.days_left + ' Tage'),
    el('button', { class: 'btn sm', onclick: async () => { const r = await api('/trash/' + tr.id + '/restore', { method: 'POST' }); toast(r.ok ? 'Wiederhergestellt: ' + (r.label || '') : (r.error || 'Nicht möglich.')); renderData(); } }, 'Wiederherstellen'),
    el('button', { class: 'btn sm ghost', title: 'Endgültig löschen', onclick: async () => { await api('/trash/' + tr.id, { method: 'DELETE' }); renderData(); } }, '✕'))));
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, `Papierkorb (${trash.length})`), trashBody));
  const loginBadge = login.loggedIn ? el('span', { class: 'tag ok' }, 'eingeloggt' + (login.handle ? ' @' + login.handle : '')) : el('span', { class: 'tag err' }, 'nicht eingeloggt');
  const loginLog = el('div', { class: 'log', style: 'display:none' });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '1) MakerWorld-Login', loginBadge),
    el('div', { class: 'bd' }, el('p', { class: 'muted' }, 'Öffnet ein echtes Chrome-Fenster. Oben rechts „Sign In", normal anmelden (Passkey funktioniert). Login wird gespeichert.'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async e => { e.target.disabled = true; loginLog.style.display = 'block'; loginLog.textContent = t('Öffne Fenster …');
        await api('/login/start', { method: 'POST' });
        const iv = setInterval(async () => { const p = await api('/login/progress'); loginLog.textContent = p.log.join('\n'); if (!p.running) { clearInterval(iv); e.target.disabled = false; renderData(); } }, 1500); } }, 'Login-Fenster öffnen')), loginLog)));

  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '2) Live-Pull'),
    el('div', { class: 'bd' }, el('p', { class: 'muted' }, 'Zieht Analytics + Beschreibung, Tags, Kommentare, Sammlungen und Bilder. Läuft in sichtbarem Chrome (off-screen).'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: triggerPull }, 'Jetzt ziehen'),
        el('button', { class: 'btn ghost', title: 'Laufenden Pull abbrechen', onclick: async () => { const r = await api('/pull/cancel', { method: 'POST' }); toast(r.ok ? 'Abbruch angefordert.' : (r.reason || 'Kein Pull aktiv.')); pollPull(); } }, 'Abbrechen')), el('div', { id: 'pullLog', class: 'log', style: 'display:none' }))));

  const timeI = el('input', { type: 'time', value: s.schedule_time });
  const enI = el('input', { type: 'checkbox' }); enI.checked = s.schedule_enabled;
  const startI = el('input', { type: 'date', value: s.start_date });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '3) Automatischer Tages-Pull'),
    el('div', { class: 'bd' }, el('div', { class: 'row' }, enI, el('span', {}, 'aktiv, täglich um'), timeI, el('label', { style: 'margin-left:12px' }, 'Historie ab'), startI,
      el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { schedule_time: timeI.value, schedule_enabled: enI.checked, start_date: startI.value }); toast('Gespeichert.'); } }, 'Speichern')),
      el('p', { class: 'muted' }, 'Läuft solange der Server läuft. Auf dem Pi als Dienst dauerhaft.'))));

  // Digest / Benachrichtigung
  const notifyI = el('input', { value: s.notify_url || '', placeholder: 'z.B. https://ntfy.sh/mein-geheimes-thema', style: 'flex:1;min-width:220px' });
  const dg = await api('/digest');
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '4) Täglicher Digest / Benachrichtigung'),
    el('div', { class: 'bd' },
      el('p', { class: 'muted' }, 'Nach jedem Pull wird eine Zusammenfassung erstellt. Für Push aufs Handy eine ntfy.sh-Themen-URL (App „ntfy" installieren, Thema abonnieren) oder einen eigenen Webhook eintragen — leer = nur hier anzeigen.'),
      el('div', { class: 'row' }, el('label', { style: 'min-width:110px' }, 'Push-URL'), notifyI,
        el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { notify_url: notifyI.value }); toast('Gespeichert.'); } }, 'Speichern'),
        el('button', { class: 'btn ghost', onclick: async () => { const r = await api('/digest/send', { method: 'POST' }); toast('Digest gesendet.'); } }, 'Jetzt senden')),
      el('div', { class: 'log', style: 'margin-top:8px' }, dg.current))));

  // Wochen-Report (Insights) + Meilensteine
  const wkEn = el('input', { type: 'checkbox' }); wkEn.checked = s.weekly_enabled;
  const wkDay = el('select', {}, [[1, 'Montag'], [2, 'Dienstag'], [3, 'Mittwoch'], [4, 'Donnerstag'], [5, 'Freitag'], [6, 'Samstag'], [0, 'Sonntag']].map(([v, l]) => el('option', { value: v }, l)));
  wkDay.value = String(s.weekly_day ?? 1);
  const wkTime = el('input', { type: 'time', value: s.weekly_time || '08:00' });
  const lowI = el('input', { type: 'number', value: s.spool_low_g ?? 150, style: 'width:80px' });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '5) Wochen-Report & Alerts'),
    el('div', { class: 'bd' },
      el('p', { class: 'muted' }, 'Wöchentliche Insights (Zugpferd, CTR-Chancen, Gutschein-Prognose, stärkste Tags) als Push. Meilensteine (1000 Downloads, Gutschein-Schwelle, „kalt gewordene" Modelle) werden nach jedem Pull automatisch gepusht.'),
      el('div', { class: 'row' }, wkEn, el('span', {}, 'Wochen-Report aktiv —'), wkDay, el('span', {}, 'um'), wkTime,
        el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { weekly_enabled: wkEn.checked, weekly_day: +wkDay.value, weekly_time: wkTime.value }); toast('Gespeichert.'); } }, 'Speichern'),
        el('button', { class: 'btn ghost', onclick: async () => { const r = await api('/insights/send', { method: 'POST' }); toast(r.sent ? 'Wochen-Report gesendet.' : 'Erstellt (keine Push-URL — Vorschau unten).'); } }, 'Jetzt senden')),
      el('div', { class: 'row' }, el('label', { style: 'min-width:180px' }, 'Filament-Warnung ab (g)'), lowI,
        el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { spool_low_g: +lowI.value }); toast('Gespeichert.'); } }, 'Speichern')))));

  // Öffentlicher Statuslink (Basis-Adresse für verschickte Links)
  const pubI = el('input', { value: s.public_base_url || '', placeholder: 'z.B. https://raspberrypi.your-tailnet.ts.net:8443', style: 'flex:1;min-width:260px' });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, '6) Öffentlicher Statuslink'),
    el('div', { class: 'bd' },
      el('p', { class: 'muted' }, 'Adresse, unter der die Auftrags-Statusseite von außen erreichbar ist (nur die Statusseite, nicht das Dashboard). Wird für die „Statuslink"-Buttons verwendet. Leer = nur lokal.'),
      el('div', { class: 'row' }, el('label', { style: 'min-width:110px' }, 'Basis-URL'), pubI,
        el('button', { class: 'btn', onclick: async () => { await jpost('/settings', { public_base_url: pubI.value }); toast('Gespeichert.'); } }, 'Speichern')))));

  // Punkte-Wert (Verdienst-Umrechnung)
  const curRate = s.eur_per_point || (40 / 524);
  const ptsI = el('input', { type: 'number', value: 524, style: 'width:90px' });
  const eurI = el('input', { type: 'number', step: '0.01', value: (524 * curRate).toFixed(2), style: 'width:90px' });
  w.append(el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Punkte-Wert (Verdienst)'),
    el('div', { class: 'bd' }, el('p', { class: 'muted' }, `Wie viel € ergibt eine Menge Punkte? Aktuell: ${eur(curRate)} pro Punkt.`),
      el('div', { class: 'row' }, ptsI, el('span', {}, 'Punkte ='), eurI, el('span', {}, '€'),
        el('button', { class: 'btn', onclick: async () => {
          const p = +ptsI.value, e = +eurI.value;
          if (!(p > 0) || !(e > 0)) return toast('Bitte gültige Werte.');
          await jpost('/settings', { eur_per_point: e / p }); STATE.overview = null; await loadOverview();
          toast(`Gespeichert: ${eur(e / p)} pro Punkt`); renderData();
        } }, 'Speichern')))));
}

async function triggerPull() { const box = $('#pullLog'); if (box) { box.style.display = 'block'; box.textContent = t('starte …'); } const r = await api('/pull/start', { method: 'POST' }); if (!r.started) toast(r.reason || 'läuft schon'); pollPull(); }

// ---- Pull-Status ----
let pollTimer = null, wasRunning = false;
// Nach einem Pull die aktuelle Seite mit frischen Daten neu zeichnen - aber nichts zerstoeren:
//  - offener Detail-Drawer oder Eingabe in Arbeit (Feld hat Fokus): NICHT neu rendern, nur Hinweis
//    (beim naechsten Seitenwechsel sind die Daten ohnehin neu);
//  - sonst neu rendern und die Scroll-Position wiederherstellen.
async function softRefresh() {
  const drawerOpen = !$('#drawer').classList.contains('hidden');
  const ae = document.activeElement, typing = ae && ae.closest && ae.closest('#view') && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);
  if (drawerOpen || typing) { toast('Pull abgeschlossen — neue Daten sind geladen (Anzeige aktualisiert sich beim nächsten Seitenwechsel).'); return; }
  const main = $('main'), y = Math.max(window.scrollY, main ? main.scrollTop : 0);
  try { await routes[CUR_ROUTE](); } catch { return; }
  requestAnimationFrame(() => { window.scrollTo(0, y); if (main) main.scrollTop = y; });
}
async function pollPull() {
  const st = await api('/pull/status');
  const side = $('#pullStatus'), btn = $('#pullBtn'), box = $('#pullLog');
  if (st.running) { wasRunning = true; btn.disabled = true; btn.textContent = t('Pull läuft …'); side.textContent = st.log.slice(-4).join('\n'); if (box) box.textContent = st.log.join('\n'); if (!pollTimer) pollTimer = setInterval(pollPull, 1500); }
  else { btn.disabled = false; btn.textContent = t('Live-Pull starten'); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (st.lastResult) side.textContent = st.lastResult.ok ? `✓ ${st.lastResult.ok} ${t('Modelle aktualisiert')}` : ('✗ ' + st.lastResult.error);
    if (box && st.log.length) box.textContent = st.log.join('\n');
    if (wasRunning) { wasRunning = false; await loadOverview(); softRefresh(); } else renderLastPull();
  }
}
$('#pullBtn').addEventListener('click', triggerPull);
function renderLastPull() { const lp = STATE.overview?.lastPull; $('#lastPull').textContent = lp ? `${t('Pull')} ${nice(lp.finished_at || lp.started_at)}\n${lp.status} · ${lp.models_ok ?? 0}/${(lp.models_ok ?? 0) + (lp.models_failed ?? 0)}` : t('Kein Pull'); }
