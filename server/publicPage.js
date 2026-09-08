// Gemeinsamer Renderer für die öffentliche Read-only-Statusseite eines Projekts.
// Wird vom Dashboard-Server (index.js) UND vom isolierten Public-Server
// (public.js, nach außen via Tailscale Funnel) genutzt — identische Ausgabe.
// Design: dunkle Karte (oklch), Fortschritts-Stepper. Bei kind='modell'
// (nur Modellarbeit, kein Druck) entfällt die Druck-Stufe + der Fortschrittsbalken.
import { db, getSetting } from './db.js';

const esc = x => String(x ?? '').replace(/[<>&]/g, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]));
const NOT_FOUND = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:oklch(0.19 0.012 260);color:oklch(0.7 0.012 260);font:15px -apple-system,BlinkMacSystemFont,sans-serif">Dieser Link ist nicht (mehr) gültig.</body>';

const CHECK = '<svg width="11" height="9" viewBox="0 0 11 9" fill="none"><path d="M1 4.5L4 7.5L10 1" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Angehaengte .3mf-Datei zu einem Token (nur Modellarbeit) — Download NUR wenn bezahlt.
export function projectFileByToken(token) {
  const p = db.prepare('SELECT kind, paid, file_name, file_path FROM projects WHERE share_token=?').get(token);
  if (!p || p.kind !== 'modell' || !p.file_path || !p.paid) return null;   // gesperrt bis bezahlt
  return { rel: p.file_path, name: p.file_name || 'modell.3mf' };
}

export function renderStatus(token) {
  const p = db.prepare('SELECT * FROM projects WHERE share_token=?').get(token);
  if (!token || !p) return { code: 404, html: NOT_FOUND };
  let seller = {}; try { seller = JSON.parse(getSetting('invoice_seller', '{}')); } catch {}
  const items = db.prepare('SELECT i.label, m.title AS model_title, i.qty, i.printed_qty FROM project_items i LEFT JOIN models m ON m.design_id=i.design_id WHERE i.project_id=? ORDER BY i.sort,i.id').all(p.id);

  const modelOnly = p.kind === 'modell';   // nur Modellarbeit -> keine Druck-Stufe/Fortschritt
  const STAGE_DEFS = modelOnly
    ? [{ key: 'anfrage', name: 'Anfrage' }, { key: 'modellierung', name: 'In Modellierung' }, { key: 'fertig', name: 'Fertig' }]
    : [{ key: 'anfrage', name: 'Anfrage' }, { key: 'modellierung', name: 'In Modellierung' }, { key: 'druck', name: 'Wird gedruckt' }, { key: 'fertig', name: 'Fertig' }];
  const order = STAGE_DEFS.map(s => s.key);
  let cur = p.stage;
  if (!order.includes(cur)) cur = (cur === 'druck') ? 'modellierung' : (cur === 'fertig' ? 'fertig' : 'anfrage');
  const curIdx = Math.max(0, order.indexOf(cur));

  const stagesHtml = STAGE_DEFS.map((s, i) => {
    const done = i <= curIdx, current = i === curIdx, lineOn = i < curIdx, showLine = i < STAGE_DEFS.length - 1;
    const cls = ['step', done ? 'done' : '', current ? 'current' : '', lineOn ? 'lineon' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}"><div class="col"><div class="dot">${done ? CHECK : ''}</div>${showLine ? '<div class="line"></div>' : ''}</div>`
      + `<div class="body"><div class="slabel">${esc(s.name)}</div>${current ? '<div class="cur">Aktueller Schritt</div>' : ''}</div></div>`;
  }).join('');

  const showProgress = !modelOnly && cur === 'druck';
  const totalQ = items.reduce((a, i) => a + (i.qty || 0), 0), doneQ = items.reduce((a, i) => a + (i.printed_qty || 0), 0);
  const pct = totalQ ? Math.round((doneQ / totalQ) * 100) : 0;
  const progressHtml = showProgress
    ? `<div class="prog"><div class="track"><div class="fill" style="width:${pct}%"></div></div><div class="plabel">${pct}% (${doneQ}/${totalQ} gedruckt)</div></div>` : '';

  const itemsHtml = items.length
    ? `<div class="items">${items.map(i => `<div class="item"><div>${esc(i.label || i.model_title || 'Position')}</div><div class="iqty">×${i.qty}</div></div>`).join('')}</div>` : '';

  // .3mf-Download (nur Modellarbeit): Datei sichtbar hochgeladen, Download erst nach Zahlung.
  const fileHtml = (modelOnly && p.file_name)
    ? (p.paid
      ? `<a class="dl" href="/p/${esc(token)}/file">3D-Datei herunterladen (.3mf)</a>`
      : `<div class="dl locked"><span class="lk"><svg width="12" height="12" viewBox="0 0 14 16" fill="none"><path d="M3.5 7V4.5a3.5 3.5 0 0 1 7 0V7" stroke="currentColor" stroke-width="1.6"/><rect x="1.5" y="7" width="11" height="8" rx="1.5" fill="currentColor"/></svg> Datei hochgeladen</span><span class="ls">Download nach Zahlung freigeschaltet</span></div>`)
    : '';

  const price = p.price != null ? p.price : null;
  const free = p.margin_tier === 'kostenlos' || (price != null && price <= 0);
  const priceHtml = price != null
    ? `<div class="price-row"><div class="price-k">Preis</div><div class="price-v">${free ? 'kostenlos' : price.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'}</div></div>` : '';

  const paid = !!p.paid;
  const stageLabel = STAGE_DEFS[curIdx].name;
  const email = seller.email || '';

  const html = `<!doctype html><html lang=de><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta name=robots content="noindex,nofollow">
<title>Auftragsstatus — ${esc(p.title)}</title><style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:48px 20px;
  background:oklch(0.19 0.012 260);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
.wrap{width:100%;max-width:480px;display:flex;flex-direction:column;gap:18px}
.card{background:oklch(0.24 0.014 260);border:1px solid oklch(0.32 0.014 260);border-radius:20px;padding:28px 26px;box-shadow:0 20px 50px -20px rgba(0,0,0,.5)}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:2px}
.cust{font-size:13px;color:oklch(0.68 0.012 260);letter-spacing:.01em}
.badge{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:4px 10px;border-radius:999px;white-space:nowrap}
.badge.paid{background:oklch(0.4 0.1 150 / .25);color:oklch(0.78 0.14 150)}
.badge.open{background:oklch(0.4 0.09 60 / .25);color:oklch(0.8 0.14 70)}
h1{margin:2px 0 14px;font-size:23px;line-height:1.25;font-weight:700;color:oklch(0.97 0.006 260)}
.status{font-size:13px;color:oklch(0.68 0.012 260);margin-bottom:16px}
.status b{color:oklch(0.94 0.006 260);font-weight:600}
.prog{margin-bottom:22px}
.track{height:8px;border-radius:999px;background:oklch(0.32 0.014 260);overflow:hidden}
.fill{height:100%;border-radius:999px;background:linear-gradient(90deg,oklch(0.62 0.11 240),oklch(0.7 0.13 220));transition:width .6s ease-out}
.plabel{font-size:12px;color:oklch(0.6 0.012 260);margin-top:7px;font-variant-numeric:tabular-nums}
.steps{display:flex;flex-direction:column;gap:0;margin-bottom:20px}
.step{display:flex;gap:12px;align-items:flex-start}
.col{display:flex;flex-direction:column;align-items:center;flex:none}
.dot{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:oklch(0.32 0.014 260)}
.step.done .dot{background:oklch(0.62 0.11 240)}
.step.current .dot{box-shadow:0 0 0 4px oklch(0.62 0.11 240 / .18)}
.line{width:2px;flex:1;min-height:22px;background:oklch(0.32 0.014 260)}
.step.lineon .line{background:oklch(0.5 0.09 240)}
.body{padding-bottom:22px;padding-top:1px}
.slabel{font-size:14.5px;font-weight:600;color:oklch(0.55 0.012 260)}
.step.done .slabel{color:oklch(0.95 0.006 260)}
.cur{font-size:12px;color:oklch(0.62 0.11 240);margin-top:2px}
.items{border-top:1px solid oklch(0.32 0.014 260);padding-top:16px;display:flex;flex-direction:column;gap:8px}
.item{display:flex;justify-content:space-between;gap:12px;font-size:13.5px;color:oklch(0.82 0.008 260)}
.iqty{color:oklch(0.6 0.012 260);flex:none}
.price-row{border-top:1px solid oklch(0.32 0.014 260);margin-top:16px;padding-top:16px;display:flex;justify-content:space-between;align-items:baseline}
.price-k{font-size:12px;color:oklch(0.6 0.012 260);text-transform:uppercase;letter-spacing:.03em}
.price-v{font-size:22px;font-weight:700;color:oklch(0.97 0.006 260);font-variant-numeric:tabular-nums}
.foot{text-align:center;font-size:12px;color:oklch(0.5 0.012 260);line-height:1.6}
.foot a{color:oklch(0.65 0.1 240);text-decoration:none}
.dl{display:block;margin-top:16px;padding:11px 14px;border-radius:10px;text-align:center;font-size:13px;font-weight:600;text-decoration:none;color:#fff;background:linear-gradient(90deg,oklch(0.62 0.11 240),oklch(0.7 0.13 220))}
.dl.locked{background:oklch(0.28 0.014 260);border:1px dashed oklch(0.4 0.014 260);color:oklch(0.62 0.012 260);cursor:default;display:flex;flex-direction:column;gap:2px}
.dl.locked .lk{color:oklch(0.82 0.008 260);display:inline-flex;align-items:center;gap:6px}
.dl.locked .ls{font-size:11px;font-weight:400}
</style></head><body><div class=wrap>
  <div class=card>
    <div class=top><div class=cust>${esc(seller.name || 'Auftragsstatus')}</div><div class="badge ${paid ? 'paid' : 'open'}">${paid ? 'bezahlt' : 'offen'}</div></div>
    <h1>${esc(p.title)}</h1>
    <div class=status>Status: <b>${esc(stageLabel)}</b></div>
    ${progressHtml}
    <div class=steps>${stagesHtml}</div>
    ${itemsHtml}
    ${fileHtml}
    ${priceHtml}
  </div>
  <div class=foot>Live-Status deines 3D-Druck-Auftrags${email ? ' · Fragen? <a href="mailto:' + esc(email) + '">' + esc(email) + '</a>' : ''}</div>
</div></body></html>`;
  return { code: 200, html };
}
