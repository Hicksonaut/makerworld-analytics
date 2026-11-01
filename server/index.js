// Express-Server: REST-API + statisches Frontend + Tages-Scheduler.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR } from './db.js';
import { crm } from './crm.js';
import { langMiddleware, T } from './i18n.js';
import { purgeOld } from './trash.js';
import { renderStatus, projectFileByToken } from './publicPage.js';
import { router as modelsRouter } from './routes-models.js';
import { router as analyticsRouter } from './routes-analytics.js';
import { router as insightsRouter } from './insights.js';
import { router as opsRouter, closeStaleRuns, rescheduleCron, rescheduleWeekly } from './ops.js';
import { router as healthRouter } from './health.js';
import { router as experimentsRouter } from './experiments.js';
import { router as invoicesRouter } from './invoices.js';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const app = express();
app.disable('x-powered-by');

// ---- Schutz ohne Anmeldung ----------------------------------------------------------------
// Die App hat bewusst kein Passwort. Damit trotzdem keine fremde Webseite im Browser des Nutzers
// (CSRF) oder per DNS-Rebinding an die API kommt:
//  1. Host-Header muss ein lokaler/privater Name oder eine private IP sein (LAN, Tailscale, WireGuard).
//     Weitere Namen per Umgebungsvariable ALLOWED_HOSTS="a.example.com,b.example.com".
//  2. Schreibende Anfragen (POST/PUT/DELETE) mit Origin-Header muessen von derselben Adresse kommen.
const EXTRA_HOSTS = String(process.env.ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const hostOnly = h => { h = String(h || '').toLowerCase(); return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]; };
const PRIVATE_HOST = new RegExp('^(localhost|127(\\.\\d+){3}|\\[::1\\]|10(\\.\\d+){3}|192\\.168(\\.\\d+){2}|172\\.(1[6-9]|2\\d|3[01])(\\.\\d+){2}'
  + '|169\\.254(\\.\\d+){2}|100\\.(6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])(\\.\\d+){2}|\\[(fd|fe80)[0-9a-f:]*\\]|[^.]+|.+\\.(local|lan|fritz\\.box|home\\.arpa|ts\\.net))$');
const hostAllowed = h => PRIVATE_HOST.test(h) || EXTRA_HOSTS.includes(h);
app.use(langMiddleware);
app.use((req, res, next) => {
  const host = hostOnly(req.headers.host);
  if (!hostAllowed(host)) { console.log('[security] Host abgelehnt:', req.headers.host); return res.status(403).type('text').send(T('Host nicht erlaubt.', 'Host not allowed.')); }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "frame-ancestors 'none'" });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.headers.origin;
    let bad = req.headers['sec-fetch-site'] === 'cross-site' || origin === 'null';
    if (origin && origin !== 'null') { try { bad = bad || new URL(origin).host !== req.headers.host; } catch { bad = true; } }
    if (bad) { console.log('[security] Fremde Herkunft abgelehnt:', req.method, req.url, origin); return res.status(403).json({ error: T('Anfrage von fremder Herkunft abgelehnt.', 'Request from a foreign origin rejected.') }); }
  }
  next();
});

// Body-Limits: nur der .3mf-Upload darf gross sein (60 MB als Base64 ~ 80 MB); alles andere 2 MB.
app.use('/api/projects/:id/file', express.json({ limit: '85mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));
app.use('/api', crm);

// ---- Module (Routen) -----------------------------------------------------------------------
app.use(modelsRouter, analyticsRouter, insightsRouter, opsRouter, healthRouter, experimentsRouter, invoicesRouter);

// ---- Öffentlicher Read-only-Statuslink für ein Projekt --------------------
// (Nach außen erreichbar über den isolierten Server public.js; hier lokal fürs Testen.)
app.get('/p/:token', (req, res) => { const r = renderStatus(req.params.token); res.status(r.code).type('html').send(r.html); });
app.get('/p/:token/file', (req, res) => {
  const f = projectFileByToken(req.params.token); if (!f) return res.status(404).send(T('Keine Datei.', 'No file.'));
  const abs = path.join(DATA_DIR, f.rel); if (!fs.existsSync(abs)) return res.status(404).send(T('Keine Datei.', 'No file.'));
  res.setHeader('Content-Disposition', 'attachment; filename="' + f.name.replace(/["\r\n]/g, '') + '"');
  res.setHeader('Content-Type', 'model/3mf'); fs.createReadStream(abs).pipe(res);
});

app.use('/data/images', express.static(path.join(DATA_DIR, 'images')));
// Kein Caching fuer die App-Dateien, damit Updates sofort ankommen (Safari cached sonst app.js/css).
app.use('/', express.static(path.join(ROOT, 'web'), { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));

// Fehler der API als JSON (Frontend zeigt den Banner), nie Stacktraces im HTML.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooBig = err.type === 'entity.too.large', bad = err.type === 'entity.parse.failed';
  if (!tooBig && !bad) console.log('[error]', req.method, req.url, err.message);
  res.status(tooBig ? 413 : bad ? 400 : 500).json({ error: tooBig ? T('Anfrage zu groß.', 'Request too large.') : bad ? T('Ungültige Anfrage (JSON).', 'Invalid request (JSON).') : T('Interner Fehler.', 'Internal error.') });
});

const PORT = process.env.PORT || 4000;
purgeOld();   // Papierkorb: Eintraege aelter als 30 Tage endgueltig entfernen
closeStaleRuns('Dienst neu gestartet');   // beim Start kann kein Pull laufen
rescheduleCron();
rescheduleWeekly();
app.listen(PORT, () => console.log(`MakerWorld-Analytics laeuft:  http://localhost:${PORT}`));
