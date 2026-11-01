// Server-Sprache (de/en) fuer alles, was die App dem Nutzer als Text liefert: Alerts, Insights, Statushinweise,
// Fehlermeldungen, Push-Texte, Pull-Protokoll. Quelle im Code ist Deutsch; T(de, en) waehlt nach Sprache.
//  - Anfragen aus dem Browser tragen den Header `X-Lang` (de|en) -> gilt fuer genau diese Anfrage.
//  - Hintergrundjobs (Cron-Pull, Push, Digest) nutzen die zuletzt gewaehlte Sprache (Einstellung `lang`).
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSetting } from './db.js';

const als = new AsyncLocalStorage();

export function langMiddleware(req, res, next) {
  const h = String(req.headers['x-lang'] || '').toLowerCase();
  als.run({ lang: h === 'en' || h === 'de' ? h : null }, next);
}
export const lang = () => als.getStore()?.lang || (getSetting('lang', 'de') === 'en' ? 'en' : 'de');
export const T = (de, en) => (lang() === 'en' ? en : de);
export const LOCALE = () => (lang() === 'en' ? 'en-US' : 'de-DE');
export const num = n => Number(n).toLocaleString(LOCALE());
export const dateLocal = (d = new Date()) => d.toLocaleDateString(LOCALE());
