// Isolierter, nach außen gerichteter Server: liefert AUSSCHLIESSLICH die
// öffentliche Read-only-Statusseite /p/:token — kein Dashboard, keine API,
// keine Daten. Wird via Tailscale Funnel (Port 8443 -> 127.0.0.1:4001) ins
// Internet gebracht; das Dashboard (index.js, Port 4000) bleibt komplett lokal.
import express from 'express';
import fs from 'fs';
import path from 'path';
import { renderStatus, projectFileByToken } from './publicPage.js';
import { DATA_DIR } from './db.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);   // hinter dem Tailscale-Funnel-Proxy

app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.get('/p/:token', (req, res) => {
  const r = renderStatus(req.params.token);
  res.set('X-Robots-Tag', 'noindex, nofollow')
     .set('Referrer-Policy', 'no-referrer')
     .status(r.code).type('html').send(r.html);
});
// .3mf-Download (nur Modellarbeit mit angehaengter Datei, token-geschuetzt)
app.get('/p/:token/file', (req, res) => {
  const f = projectFileByToken(req.params.token);
  if (!f) return res.status(404).type('text').send('Keine Datei.');
  const abs = path.join(DATA_DIR, f.rel);
  if (!fs.existsSync(abs)) return res.status(404).type('text').send('Keine Datei.');
  res.setHeader('Content-Disposition', 'attachment; filename="' + f.name.replace(/["\r\n]/g, '') + '"');
  res.setHeader('Content-Type', 'model/3mf');
  fs.createReadStream(abs).pipe(res);
});
// Alles andere existiert hier bewusst nicht.
app.use((_req, res) => res.status(404).type('html')
  .send('<!doctype html><meta charset=utf-8><body style="font:15px system-ui;padding:40px">Nicht gefunden.</body>'));

const PORT = +(process.env.PUBLIC_PORT || 4001);
const HOST = process.env.PUBLIC_HOST || '127.0.0.1';   // nur lokal; Tailscale Funnel proxyt dorthin
app.listen(PORT, HOST, () => console.log(`Öffentliche Statusseite: http://${HOST}:${PORT}/p/<token>`));
