// Laufzustand des Pulls und Systemstatus (Pull, Backup, Speicher).
import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { db, DATA_DIR } from './db.js';
import { T } from './i18n.js';

const app = express.Router();
export const router = app;

// ---- Pull-Status (eine Instanz gleichzeitig) ------------------------------
export const pullState = { running: false, mode: null, startedAt: null, log: [], lastResult: null };
export function pushLog(m) { pullState.log.push(m); if (pullState.log.length > 500) pullState.log.shift(); }

// ---- Systemstatus (Pull, Backup, Speicher) --------------------------------
export function memAvailableMb() {
  try { const m = fs.readFileSync(process.env.MEMINFO_FILE || '/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/); return m ? Math.round(+m[1] / 1024) : null; }
  catch { return null; }   // nicht Linux (Entwicklung auf dem Mac)
}
export function healthData() {
  const sizeOf = f => { try { return fs.statSync(f).size; } catch { return 0; } };
  const dbFile = path.join(DATA_DIR, 'makerworld.db');
  const dbBytes = sizeOf(dbFile) + sizeOf(dbFile + '-wal');
  let diskFreeGb = null;
  try { const st = fs.statfsSync(DATA_DIR); diskFreeGb = +((st.bavail * st.bsize) / 1e9).toFixed(1); } catch {}
  const lastRun = db.prepare('SELECT id,started_at,finished_at,status,mode,models_ok,models_failed FROM pull_runs ORDER BY id DESC LIMIT 1').get() || null;
  const lastOk = db.prepare("SELECT finished_at FROM pull_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").get();
  const pullAgeH = lastOk?.finished_at ? +((Date.now() - Date.parse(lastOk.finished_at)) / 3600000).toFixed(1) : null;
  const backupDir = process.env.BACKUP_DIR || path.join(os.homedir(), 'backups', 'makerworld');
  let backup = null;
  try {
    const files = fs.readdirSync(backupDir).filter(f => /^makerworld-.*\.db\.gz$/.test(f)).sort();
    if (files.length) { const f = files[files.length - 1], st = fs.statSync(path.join(backupDir, f));
      backup = { file: f, at: st.mtime.toISOString(), ageH: +((Date.now() - st.mtimeMs) / 3600000).toFixed(1), count: files.length, bytes: st.size }; }
  } catch {}
  const memMb = memAvailableMb();
  const issues = [];
  if (lastRun?.status === 'error') issues.push({ level: 'error', text: T('Der letzte Pull ist fehlgeschlagen — Details unter „Daten & Pull".', 'The last pull failed — see "Data & Pull" for details.') });
  else if (lastRun?.status === 'running' && !pullState.running) issues.push({ level: 'error', text: T('Ein Pull steht auf „läuft", obwohl keiner aktiv ist (Neustart/Absturz).', 'A pull is marked as running although none is active (restart/crash).') });
  if (pullAgeH == null) issues.push({ level: 'warn', text: T('Noch kein erfolgreicher Pull vorhanden.', 'No successful pull yet.') });
  else if (pullAgeH > 36) issues.push({ level: 'error', text: T(`Der letzte erfolgreiche Pull ist ${Math.round(pullAgeH)} Stunden her — die Zahlen sind veraltet.`, `The last successful pull was ${Math.round(pullAgeH)} hours ago — the numbers are stale.`) });
  if (!backup) issues.push({ level: 'warn', text: T('Kein Backup gefunden.', 'No backup found.') });
  else if (backup.ageH > 36) issues.push({ level: 'warn', text: T(`Das letzte Backup ist ${Math.round(backup.ageH)} Stunden alt.`, `The last backup is ${Math.round(backup.ageH)} hours old.`) });
  if (diskFreeGb != null && diskFreeGb < 5) issues.push({ level: 'error', text: T(`Nur noch ${diskFreeGb} GB Speicherplatz frei.`, `Only ${diskFreeGb} GB of disk space left.`) });
  if (dbBytes > 1e9) issues.push({ level: 'warn', text: T(`Die Datenbank ist ${(dbBytes / 1e9).toFixed(1)} GB groß (erwartet: wenige MB).`, `The database is ${(dbBytes / 1e9).toFixed(1)} GB (expected: a few MB).`) });
  if (memMb != null && memMb < 300) issues.push({ level: 'warn', text: T(`Wenig freier Arbeitsspeicher (${memMb} MB).`, `Low free memory (${memMb} MB).`) });
  return { dbBytes, diskFreeGb, memAvailableMb: memMb, uptimeH: +(process.uptime() / 3600).toFixed(1), lastRun, pullAgeH, backup, pullRunning: pullState.running, issues };
}
app.get('/api/health', (req, res) => res.json(healthData()));

