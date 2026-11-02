// Browser-Auftraege gegen MakerWorld (Tag-Recherche, Upload-Assistent): laufen im selben Chrome-Profil wie der Pull,
// deshalb immer nur ein Auftrag gleichzeitig und nie parallel zum Pull. Fortschritt/Ergebnis liest die Oberflaeche per Polling.
import express from 'express';
import { nowIso } from './db.js';
import { T } from './i18n.js';
import { mwJob, pullState, memAvailableMb } from './health.js';

const app = express.Router();
export const router = app;

const MIN_RAM_MB = () => +process.env.PULL_MIN_RAM_MB || 800;
const TIMEOUT_MS = () => +process.env.MW_JOB_TIMEOUT_MS || 12 * 60 * 1000;

// Tests setzen MWA_FAKE_SESSION auf ein Modul, das eine Pseudo-Sitzung liefert (page.evaluate gegen ein Fake-fetch).
async function session(fn, onLog) {
  if (process.env.MWA_FAKE_SESSION) { const fake = (await import(process.env.MWA_FAKE_SESSION)).default; return fn({ ...(await fake()), onLog }); }
  const { withSession } = await import('./scraper.js');   // lazy: Server startet auch ohne Playwright
  return withSession(fn, { onLog });
}

// fn({ page, ctx, handle, log }) -> Ergebnis (JSON-faehig). Rueckgabe: { started, reason? }
export function startMwJob(name, fn) {
  if (mwJob.running) return { started: false, reason: T(`Ein Browser-Auftrag (${mwJob.name}) läuft bereits.`, `A browser job (${mwJob.name}) is already running.`) };
  if (pullState.running) return { started: false, reason: T('Ein Pull läuft gerade - bitte danach erneut versuchen.', 'A pull is running - please try again afterwards.') };
  const m = memAvailableMb();
  if (m != null && m < MIN_RAM_MB()) return { started: false, reason: T(`Zu wenig freier Arbeitsspeicher (${m} MB, benötigt ~${MIN_RAM_MB()} MB).`, `Not enough free memory (${m} MB, needs ~${MIN_RAM_MB()} MB).`) };
  Object.assign(mwJob, { name, running: true, startedAt: nowIso(), log: [], result: null, error: null, finishedAt: null });
  const log = msg => { mwJob.log.push(String(msg)); if (mwJob.log.length > 300) mwJob.log.shift(); };
  const watchdog = setTimeout(async () => { log(T('WATCHDOG: Zeitlimit erreicht - Auftrag wird abgebrochen.', 'WATCHDOG: time limit reached - aborting job.')); try { (await import('./scraper.js')).abortJob(); } catch {} }, TIMEOUT_MS());
  (async () => {
    try { mwJob.result = await session(s => fn({ ...s, log }), log); }
    catch (e) { mwJob.error = e.message; log(T('Fehler: ', 'Error: ') + e.message); }
    finally { clearTimeout(watchdog); mwJob.running = false; mwJob.finishedAt = nowIso(); }
  })();
  return { started: true };
}

app.get('/api/mw/job', (req, res) => res.json({ ...mwJob }));
