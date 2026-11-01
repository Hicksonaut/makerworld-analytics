// Gemeinsame Testhilfen: startet die App auf einem freien Port mit einer frischen, mit Demo-Daten befuellten
// Datenbank in einem temporaeren Ordner (DATA_DIR) - die echten Daten bleiben unberuehrt.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => 4600 + Math.floor(Math.random() * 380);

// Startet die App. opts: { seed: true, env: {...}, dataDir }
export async function startApp(opts = {}) {
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mwa-test-'));
  const env = { ...process.env, DATA_DIR: dataDir, ...(opts.env || {}) };
  if (opts.seed !== false && !fs.existsSync(path.join(dataDir, 'makerworld.db'))) {
    execFileSync(process.execPath, ['server/seed-demo.js'], { cwd: ROOT, env, stdio: 'ignore' });
  }
  const port = freePort();
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/settings'); if (r.ok) break; } catch {}
    if (child.exitCode != null) throw new Error('App startet nicht:\n' + log);
    await sleep(100);
  }
  const app = {
    base, port, dataDir, log: () => log,
    // JSON-API-Aufruf; gibt {status, body} zurueck (body = geparstes JSON oder null)
    async api(method, p, body, headers = {}) {
      const r = await fetch(base + '/api' + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const t = await r.text(); let b = null; try { b = JSON.parse(t); } catch {}
      return { status: r.status, body: b, text: t, headers: r.headers };
    },
    // Roher HTTP-Aufruf mit frei waehlbarem Host-/Origin-Header (fetch erlaubt Host nicht)
    raw(method, p, headers = {}, data) {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: 'localhost', port, path: p, method, headers }, res => {
          let t = ''; res.on('data', d => t += d); res.on('end', () => resolve({ status: res.statusCode, text: t, headers: res.headers }));
        });
        req.on('error', reject); if (data) req.write(data); req.end();
      });
    },
    // Direkter Datenbankzugriff (z.B. um Testzustaende herzustellen) - nur fuer Tests
    db() { const Database = require('better-sqlite3'); return new Database(path.join(dataDir, 'makerworld.db')); },
    async stop() { child.kill(); await new Promise(r => child.once('exit', r)); },
    cleanup() { fs.rmSync(dataDir, { recursive: true, force: true }); }
  };
  return app;
}

// Playwright-Browser: bevorzugt das installierte Chrome, sonst das gebuendelte Chromium.
export async function launchBrowser() {
  const { chromium } = require('playwright');
  try { return await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { return await chromium.launch({ headless: true }); }
}

// Alle Seiten (Routen) der Oberflaeche, fuer UI- und Uebersetzungstests.
export const ROUTES = ['heute', 'overview', 'momentum', 'compare', 'groups', 'points', 'report', 'contacts', 'leads', 'projekte', 'revenue',
  'teile', 'pipeline', 'selbst', 'druckplan', 'material', 'todos', 'data'];
