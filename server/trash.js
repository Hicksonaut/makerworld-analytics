// Papierkorb: geloeschte Datensaetze (samt abhaengigen Zeilen und Dateien) werden 30 Tage aufbewahrt und
// lassen sich wiederherstellen ("Rueckgaengig"-Hinweis oder Liste unter Daten & Pull).
// Gespeichert wird ein JSON-Abbild {rows: {tabelle: [zeile, ...]}, files: [relativer Pfad, ...]}.
import fs from 'fs';
import path from 'path';
import { db, DATA_DIR, nowIso } from './db.js';

export const TRASH_DAYS = 30;
const TRASH_DIR = path.join(DATA_DIR, 'trash');
// Wiederherstellungs-Reihenfolge: Eltern vor Kindern.
const TABLE_ORDER = ['contacts', 'models', 'projects', 'spools', 'parts', 'project_parts', 'project_items', 'print_log',
  'expenses', 'payouts', 'events', 'views', 'todos'];

export const rowsOf = (table, where, ...args) => db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args);
// Sammler: acc.rows[tabelle] bekommt Zeilen, acc.files Pfade (relativ zu data/).
export const newAcc = () => ({ rows: {}, files: [] });
export function addRows(acc, table, rows) { if (rows && rows.length) (acc.rows[table] = acc.rows[table] || []).push(...rows); return acc; }

// Abbild speichern, Dateien in data/trash/<id>/ verschieben. Gibt die Papierkorb-ID zurueck.
export function trashPut(kind, label, acc) {
  const files = acc.files.filter(rel => fs.existsSync(path.join(DATA_DIR, rel)));
  const id = db.prepare('INSERT INTO trash(kind,label,payload,created_at) VALUES(?,?,?,?)')
    .run(kind, String(label || kind).slice(0, 120), JSON.stringify({ rows: acc.rows, files }), nowIso()).lastInsertRowid;
  for (const rel of files) {
    try {
      const dst = path.join(TRASH_DIR, String(id), rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(path.join(DATA_DIR, rel), dst);
    } catch (e) { console.log('[trash] Datei nicht verschoben:', rel, e.message); }
  }
  return id;
}

// Wiederherstellen: Zeilen zurueckschreiben (gleiche IDs), Dateien zurueck an ihren Platz.
export function trashRestore(id) {
  const t = db.prepare('SELECT * FROM trash WHERE id=?').get(id);
  if (!t) return null;
  const { rows = {}, files = [] } = JSON.parse(t.payload);
  db.transaction(() => {
    for (const table of TABLE_ORDER) {
      const list = rows[table]; if (!list || !list.length) continue;
      const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
      for (const row of list) {
        const keys = Object.keys(row).filter(k => cols.has(k));
        db.prepare(`INSERT OR REPLACE INTO ${table}(${keys.map(k => `"${k}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
          .run(...keys.map(k => row[k]));
      }
    }
    db.prepare('DELETE FROM trash WHERE id=?').run(id);
  })();
  for (const rel of files) {
    try {
      const src = path.join(TRASH_DIR, String(id), rel);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(path.join(DATA_DIR, rel)), { recursive: true });
      fs.renameSync(src, path.join(DATA_DIR, rel));
    } catch (e) { console.log('[trash] Datei nicht zurueckgelegt:', rel, e.message); }
  }
  fs.rmSync(path.join(TRASH_DIR, String(id)), { recursive: true, force: true });
  return { kind: t.kind, label: t.label };
}

export function trashPurge(id) {
  const r = db.prepare('DELETE FROM trash WHERE id=?').run(id);
  fs.rmSync(path.join(TRASH_DIR, String(id)), { recursive: true, force: true });
  return r.changes > 0;
}
export function purgeOld() {
  const old = db.prepare(`SELECT id FROM trash WHERE created_at < ?`).all(new Date(Date.now() - TRASH_DAYS * 86400000).toISOString());
  old.forEach(o => trashPurge(o.id));
  return old.length;
}
export function trashList() {
  return db.prepare('SELECT id,kind,label,created_at FROM trash ORDER BY id DESC').all()
    .map(t => ({ ...t, days_left: Math.max(0, Math.ceil(TRASH_DAYS - (Date.now() - Date.parse(t.created_at)) / 86400000)) }));
}
