// Tag-Assistent (bis zu 50 Tags) und Upload-Paket fuer MakerWorld. Server: tags.js, upload.js, mwjobs.js.
const MAX_TAGS = 50;
const SRC_LABEL = { top: 'Top-Modelle', titel: 'Titel', nutzer: 'Nutzer-Eingaben', eigen: 'Eigene Daten' };
const TIER_LABEL = { broad: 'breit', mid: 'mittel', niche: 'Nische' };
// Kategorienamen: Deutsch aus MakerWorld, Englisch aus dem Slug ("hobby-and-diy" -> "Hobby & DIY")
const catName = o => LANG.cur === 'en' ? o.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/ And /g, ' & ').replace(/\bDiy\b/, 'DIY') : o.name;
// Zwischenablage: navigator.clipboard gibt es nur in sicheren Kontexten (https/localhost) - im LAN per http daher Fallback.
async function copyText(text) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* Fallback unten */ }
  const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' }); ta.value = text; document.body.append(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove(); return ok;
}
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

// Browser-Auftrag (Recherche/Upload) beobachten, bis er fertig ist. onTick bekommt den Zustand; bricht ab, wenn der Knoten verschwindet.
async function watchMwJob(node, name, onTick) {
  for (;;) {
    const j = await api('/mw/job').catch(() => null); if (!j) return null;
    if (j.name === name || !j.running) onTick(j);
    if (!j.running || !document.body.contains(node)) return j;
    await sleepMs(2000);
  }
}
const jobLog = j => el('pre', { class: 'muted', style: 'font-size:11px;white-space:pre-wrap;margin:6px 0 0;max-height:140px;overflow:auto' }, (j.log || []).slice(-8).join('\n'));

// opts: { design_id, title(), description(), tags() -> aktuelle Tags, apply(list) | null (bestehende Modelle: nur Kopieren) }
function tagAssistantCard(opts) {
  const body = el('div', { class: 'bd' }), status = el('div', { class: 'muted' }), out = el('div');
  const depth = el('select', { title: 'gründlich fragt zusätzlich ab, was Nutzer zu deinen Begriffen tippen (dauert länger)' }, [['deep', 'gründlich'], ['fast', 'schnell']].map(([v, l]) => el('option', { value: v }, l)));
  const focus = el('select', { title: 'nah am Original: nur Tags, die zu deinem Modell passen. Mehr Reichweite: auch allgemeine Tags wie decor, art, design.' }, [['close', 'nah am Original'], ['reach', 'mehr Reichweite']].map(([v, l]) => el('option', { value: v }, l)));
  const btn = el('button', { class: 'btn primary sm' }, 'Tags recherchieren');
  const count = () => opts.tags().length;
  const head = () => `${t('Aktuell')} ${count()}/${MAX_TAGS} ${t('Tags')}`;
  status.textContent = head();

  function showResult(r) {
    out.innerHTML = '';
    if (!r || !r.tags || !r.tags.length) return;
    const have = new Set(opts.tags().map(x => x.toLowerCase())), sel = new Set(r.tags.map(x => x.key));
    const tb = el('tbody'), cnt = el('span', { class: 'muted' });
    const refresh = () => { cnt.textContent = `${sel.size} ${t('ausgewählt')} · ${r.tags.filter(x => !have.has(x.key)).length} ${t('neu')}`; };
    r.tags.forEach(x => {
      const cb = el('input', { type: 'checkbox', checked: true, 'aria-label': x.tag }); cb.onchange = () => { cb.checked ? sel.add(x.key) : sel.delete(x.key); refresh(); };
      tb.append(el('tr', {}, el('td', {}, cb), el('td', { class: 'title' }, x.tag, have.has(x.key) ? null : el('span', { class: 'tag', style: 'background:#1a7f37;margin-left:6px' }, 'neu')),
        el('td', { class: 'n' }, x.count != null ? fmt(x.count) : '–'), el('td', { class: 'n muted' }, `${x.usedBy}/${r.similar != null ? r.similar : r.models}`),
        el('td', {}, TIER_LABEL[x.tier] || x.tier), el('td', { class: 'muted' }, x.sources.map(s => t(SRC_LABEL[s] || s)).join(', '))));
    });
    const pick = () => r.tags.filter(x => sel.has(x.key)).map(x => x.tag);
    const upBox = el('div');
    const actions = el('div', { class: 'row', style: 'margin:8px 0' }, ...[].concat(opts.apply
      ? el('button', { class: 'btn primary sm', title: 'Deine bisherigen Tags bleiben vorn, die Auswahl wird ergänzt (max. 50).', onclick: () => {
          const cur = opts.tags(), seen = new Set(cur.map(x => x.toLowerCase())), merged = [...cur];
          for (const tg of pick()) if (merged.length < MAX_TAGS && !seen.has(tg.toLowerCase())) { merged.push(tg); seen.add(tg.toLowerCase()); }
          opts.apply(merged); status.textContent = head(); showResult(r); toast(`${merged.length}/${MAX_TAGS} Tags übernommen.`);
        } }, 'Auswahl übernehmen')
      : [el('button', { class: 'btn primary sm', title: 'Ergänzt die gewählten Tags im Bearbeiten-Editor bei MakerWorld und speichert als Entwurf. Das Live-Modell ändert sich erst, wenn du dort auf „Veröffentlichen“ klickst.', onclick: () => uploadTags(pick(), upBox) }, 'Auswahl bei MakerWorld ergänzen (Entwurf)'),
         el('button', { class: 'btn sm', onclick: async () => toast(await copyText(pick().join(', ')) ? 'Tags kopiert — bei MakerWorld im Modell einfügen.' : 'Kopieren nicht möglich.') }, 'Auswahl kopieren')],
      ), cnt, el('span', { class: 'muted', style: 'margin-left:auto' }, `${t('Stand')} ${dmy(String(r.created_at).slice(0, 10))} · ${r.models} ${t('Top-Modelle')}, ${r.suggestCalls} ${t('Abfragen')}`));
    refresh();
    const fewNote = (r.focus === 'close' && r.tags.length < MAX_TAGS) ? el('div', { class: 'muted', style: 'font-size:11px;margin-bottom:6px' }, `${r.tags.length} ${t('Tags passen eng zum Original. Für bis zu 50 Tags oben „mehr Reichweite“ wählen und erneut recherchieren.')}`) : null;
    out.append(actions, upBox, fewNote, el('div', { class: 'tablewrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['', 'Tag', 'Nutzung', 'Ähnliche Modelle', 'Verbreitung', 'Quelle'].map((h, i) => el('th', { class: i === 2 || i === 3 ? 'n' : '' }, h)))), tb)));
  }
  const run = async () => {
    const title = opts.title().trim(); if (!title) return toast('Erst einen Titel eintragen.');
    btn.disabled = true; const box = el('div'); out.innerHTML = ''; out.append(box);
    const r = await jpost('/tags/research', { design_id: opts.design_id, title, description: opts.description(), tags: opts.tags(), depth: depth.value, focus: focus.value }).catch(e => ({ started: false, reason: e.message }));
    if (!r.started) { btn.disabled = false; out.innerHTML = ''; return toast(r.reason || r.error || 'Start nicht möglich.'); }
    const j = await watchMwJob(box, 'tags', j => { box.innerHTML = ''; box.append(el('div', { class: 'muted' }, t('Recherche läuft …')), jobLog(j)); });
    btn.disabled = false;
    if (j && j.error) { out.innerHTML = ''; out.append(el('div', { class: 'neg' }, j.error)); } else if (j && j.result) showResult(j.result);
  };
  // Ausgewaehlte Tags bei einem bestehenden MakerWorld-Modell als Entwurf ergaenzen (Browser-Auftrag)
  const uploadTags = async (list, box) => {
    if (!list.length) return toast('Erst Tags auswählen.');
    if (!(await askConfirm('Tags bei MakerWorld ergänzen?', `${list.length} ausgewählte Tags werden im Bearbeiten-Editor deines Modells bei MakerWorld ergänzt und als Entwurf gespeichert. Das Live-Modell ändert sich erst, wenn du dort auf „Veröffentlichen“ klickst.`, 'Ergänzen'))) return;
    const r = await jpost('/tags/apply', { design_id: opts.design_id, tags: list }).catch(e => ({ started: false, reason: e.message }));
    if (!r.started) return toast(r.reason || r.error || 'Start nicht möglich.');
    const j = await watchMwJob(box, 'tags-upload', j => { box.innerHTML = ''; box.append(el('div', { class: 'muted' }, t('Läuft … (Browser der Pi, ca. 1 Minute)')), jobLog(j)); });
    if (!j) return; box.innerHTML = '';
    if (j.error) return box.append(el('div', { class: 'neg' }, j.error));
    const res = j.result || {};
    box.append(el('div', { class: 'card', style: 'margin:8px 0' }, el('div', { class: 'bd' },
      el('div', {}, el('b', {}, `${(res.added || []).length} ${t('Tags ergänzt')}`), res.total ? ` · ${res.total}/${MAX_TAGS}` : '', (res.skipped || []).length ? el('span', { class: 'muted' }, ` · ${res.skipped.length} ${t('übersprungen')}`) : null),
      (res.added || []).length ? el('div', { class: 'muted', style: 'font-size:11px' }, (res.added || []).join(', ')) : null,
      el('div', { class: 'row', style: 'margin-top:6px' }, res.url ? el('a', { href: res.url, target: '_blank', rel: 'noopener' }, 'Editor bei MakerWorld öffnen ↗') : null,
        el('span', { class: 'muted', style: 'font-size:11px' }, 'Dort auf „Veröffentlichen“ klicken, um die Tags zu übernehmen.')))));
    jobLog(j);
  };
  btn.onclick = run;
  body.append(el('div', { class: 'row', style: 'margin:0 0 6px' }, status, el('span', { style: 'flex:1' }), focus, depth, btn),
    el('div', { class: 'muted', style: 'font-size:11px' }, 'MakerWorld erlaubt bis zu 50 Tags. Der Assistent wertet aus, welche Tags die bestplatzierten Modelle zu deinem Thema nutzen und wie oft Nutzer jeden Tag insgesamt verwenden — kombiniert mit deinen eigenen Erfahrungswerten. Läuft im Browser der Pi (ca. 1–2 Minuten).'), out);
  const card = el('div', { class: 'card' }, el('div', { class: 'hd' }, 'Tag-Assistent'), body);
  if (opts.design_id) api('/tags/result/' + encodeURIComponent(opts.design_id)).then(r => r && showResult(r)).catch(() => {});
  card.refreshCount = () => { status.textContent = head(); };
  return card;
}

// Upload-Paket eines geplanten Modells
async function uploadCard(m, getTags) {
  const id = m.design_id, card = el('div', { class: 'card' }), bd = el('div', { class: 'bd' });
  const cats = await api('/upload/categories').catch(() => []);
  card.append(el('div', { class: 'hd' }, 'MakerWorld-Upload (Entwurf)'), bd);
  const SLOTS = [['file3mf', 'Bambu-Studio-Datei (.3mf)', '.3mf', false], ['raw', 'Rohmodell (STL/STEP/… — wenn keine 3MF)', '', true], ['cover43', 'Cover 4:3', 'image/*', false],
    ['cover34', 'Cover 3:4 (App)', 'image/*', false], ['photo', 'Echte Druckfotos (≥ 3)', 'image/*', true], ['picture', 'Weitere Modellbilder', 'image/*', true]];
  let view = null, jobBox = el('div');
  const upload = async (kind, files) => {
    for (const f of files) {
      toast(`${f.name} wird hochgeladen …`);
      const r = await fetch(`/api/upload/${encodeURIComponent(id)}/file?kind=${kind}&name=${encodeURIComponent(f.name)}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'X-Lang': LANG.cur }, body: f });
      const j = await r.json().catch(() => ({})); if (!r.ok) { toast(j.error || 'Upload fehlgeschlagen.'); break; } view = j;
    }
    draw();
  };
  const draw = () => {
    bd.innerHTML = '';
    const p = view.pack, cl = view.checklist;
    const catSel = el('select', {}, el('option', { value: '' }, '— Kategorie —'), cats.map(g => el('optgroup', { label: catName(g) }, g.children.map(c => el('option', { value: c.id, selected: c.id === p.category_id }, catName(c))))));
    catSel.onchange = async () => { view = await jpost('/upload/' + encodeURIComponent(id), { category_id: catSel.value || null }, 'PUT'); draw(); };
    const priv = el('input', { type: 'checkbox', checked: p.private }); priv.onchange = async () => { view = await jpost('/upload/' + encodeURIComponent(id), { private: priv.checked }, 'PUT'); };
    bd.append(el('div', { class: 'row' }, el('label', { style: 'min-width:110px' }, 'Kategorie'), catSel, el('label', { class: 'checkline', style: 'margin-left:12px' }, priv, 'Sichtbarkeit „Privat“ vorbelegen')));
    // Dateien
    SLOTS.forEach(([kind, label, accept, multi]) => {
      const mine = p.files.filter(f => f.kind === kind);
      const inp = el('input', { type: 'file', accept, multiple: multi || null, style: 'display:none' }); inp.onchange = () => upload(kind, [...inp.files]);
      const list = el('span', { class: 'row', style: 'margin:0;gap:6px;flex-wrap:wrap' }, mine.map(f => el('span', { class: 'pill' },
        /^(cover|photo|picture)/.test(kind) ? el('img', { src: `/api/upload/${encodeURIComponent(id)}/file/${f.i}`, style: 'height:22px;vertical-align:middle;margin-right:4px', alt: '' }) : null,
        f.name + ' · ' + (f.size > 1048576 ? fmt1(f.size / 1048576) + ' MB' : Math.round(f.size / 1024) + ' KB'),
        el('a', { href: '#', style: 'margin-left:6px', title: 'entfernen', onclick: async e => { e.preventDefault(); view = await api('/upload/' + encodeURIComponent(id) + '/file/' + f.i, { method: 'DELETE' }); draw(); } }, '✕'))));
      bd.append(el('div', { class: 'row' }, el('label', { style: 'min-width:110px' }, label), el('button', { class: 'btn sm', onclick: () => inp.click() }, mine.length && !multi ? 'Ersetzen' : 'Datei wählen'), inp, list));
    });
    // Checkliste
    bd.append(el('div', { style: 'margin:10px 0 4px' }, cl.items.map(i => el('div', { class: 'checkline' },
      el('span', { class: i.ok ? 'pos' : (i.required ? 'neg' : 'muted') }, i.ok ? '✓' : (i.required ? '✕' : '○')), el('span', {}, i.text), i.required ? el('span', { class: 'muted', style: 'font-size:11px' }, '(nötig)') : null))));
    // Aktionen
    const go = el('button', { class: 'btn primary', disabled: !cl.ready }, p.draft_id ? 'Neuen Entwurf anlegen' : 'Als Entwurf bei MakerWorld anlegen');
    go.onclick = async () => {
      if (p.draft_id && !(await askConfirm('Weiteren Entwurf anlegen?', 'Es gibt schon einen Entwurf bei MakerWorld. Ein neuer Entwurf wird zusätzlich angelegt (den alten kannst du löschen).', 'Anlegen'))) return;
      go.disabled = true; const r = await jpost('/upload/' + encodeURIComponent(id) + '/draft', {}).catch(e => ({ started: false, reason: e.message }));
      if (!r.started) { go.disabled = false; return toast(r.reason || r.error || 'Start nicht möglich.'); }
      trackJob('upload');
    };
    bd.append(el('div', { class: 'row', style: 'margin-top:8px' }, go, el('span', { class: 'muted', style: 'font-size:11px' }, 'Legt nur einen ENTWURF an und füllt den MakerWorld-Editor aus. Veröffentlicht wird nie automatisch — das machst du in MakerWorld.')));
    if (p.draft_id) bd.append(el('div', { class: 'row' }, el('span', { class: 'tag', style: 'background:#1a7f37' }, 'Entwurf'), el('a', { href: p.draft_url, target: '_blank', rel: 'noopener' }, 'In MakerWorld öffnen ↗'),
      el('span', { class: 'muted' }, dmy(String(p.draft_at).slice(0, 10))),
      el('button', { class: 'btn sm ghost', onclick: async () => { if (!(await askConfirm('Entwurf bei MakerWorld löschen?', 'Der Entwurf wird bei MakerWorld gelöscht. Dein Paket hier bleibt erhalten.', 'Löschen'))) return;
        const r = await jpost('/upload/' + encodeURIComponent(id) + '/draft/delete', {}).catch(e => ({ started: false, reason: e.message })); if (!r.started) return toast(r.reason || r.error); trackJob('upload-delete'); } }, 'Entwurf löschen')));
    bd.append(jobBox);
  };
  const trackJob = async name => {
    const j = await watchMwJob(jobBox, name, j => { jobBox.innerHTML = ''; jobBox.append(el('div', { class: 'muted' }, j.running ? t('Läuft … (bitte Fenster offen lassen, das dauert je nach Dateigröße einige Minuten)') : ''), jobLog(j)); });
    if (!j) return;
    if (j.error) { jobBox.append(el('div', { class: 'neg' }, j.error)); } else if (j.result && j.result.url) toast('Entwurf angelegt.');
    view = await api('/upload/' + encodeURIComponent(id)); draw();
  };
  view = await api('/upload/' + encodeURIComponent(id)); draw();
  api('/mw/job').then(j => { if (j && j.running && /^upload/.test(j.name)) trackJob(j.name); }).catch(() => {});
  return card;
}
