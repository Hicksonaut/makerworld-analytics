// Datenbank-Schicht: SQLite via better-sqlite3.
// Eine Datei auf der SSD, spaeter 1:1 auf den Pi kopierbar.
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const DB_PATH = path.join(DATA_DIR, 'makerworld.db');

fs.mkdirSync(IMAGES_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS models (
  design_id       TEXT PRIMARY KEY,
  title           TEXT,
  url             TEXT,
  publish_date    TEXT,
  first_data_date TEXT,
  last_data_date  TEXT,
  description     TEXT,
  tags            TEXT,            -- JSON-Array
  tag_count       INTEGER,
  cover_image     TEXT,            -- lokaler Pfad relativ zu data/
  cover_url       TEXT,
  category        TEXT,
  license         TEXT,
  instance_count  INTEGER,         -- Anzahl Druckprofile
  created_at      TEXT,
  updated_at      TEXT
);

-- Lifetime-Stand je Pull. Damit lassen sich Likes/Collect/Bewertung/Punkte
-- ueber die Zeit verfolgen (die Analytics-API liefert nur Tages-Deltas).
CREATE TABLE IF NOT EXISTS snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id      TEXT NOT NULL,
  captured_at    TEXT NOT NULL,
  impression     INTEGER, view INTEGER, download INTEGER, print INTEGER, print_total INTEGER,
  collect        INTEGER, "like" INTEGER, follower INTEGER,
  point          INTEGER, point_from_model INTEGER, point_from_inst INTEGER,
  point_regular  INTEGER, point_exclusive INTEGER,
  boost          INTEGER, boost_regular INTEGER, boost_exclusive INTEGER,
  ctr_pct        REAL,
  rating_avg     REAL, rating_count INTEGER,
  like_count     INTEGER, collect_count INTEGER, comment_count INTEGER,
  UNIQUE(design_id, captured_at)
);

-- Tageswerte (Deltas). Quelle der Wahrheit; Woche/Monat werden per SQL aggregiert.
CREATE TABLE IF NOT EXISTS daily_metrics (
  design_id          TEXT NOT NULL,
  date               TEXT NOT NULL,
  days_since_publish INTEGER,
  impression INTEGER, view INTEGER, download INTEGER, print INTEGER,
  collect INTEGER, "like" INTEGER, follower INTEGER, boost INTEGER,
  point_from_model INTEGER, point_from_inst INTEGER,
  point_from_ratings INTEGER, point_from_others INTEGER,
  PRIMARY KEY (design_id, date)
);

CREATE TABLE IF NOT EXISTS traffic_sources (
  design_id   TEXT NOT NULL,
  window      TEXT NOT NULL,     -- 'lifetime' | 'd30' | 'd90'
  captured_at TEXT NOT NULL,
  recommend REAL, search REAL, browse REAL, direct REAL, other REAL,
  PRIMARY KEY (design_id, window, captured_at)
);

-- Nutzer-Zeitstempel: wann wurde an einem Upload etwas veraendert.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id  TEXT,              -- NULL = globales Ereignis
  date       TEXT NOT NULL,     -- Tag der Aenderung (YYYY-MM-DD)
  type       TEXT,              -- thumbnail|title|description|tags|price|files|other
  title      TEXT,
  note       TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id  TEXT NOT NULL,
  position   INTEGER,
  url        TEXT,
  local_path TEXT,
  UNIQUE(design_id, url)
);

CREATE TABLE IF NOT EXISTS pull_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT, finished_at TEXT,
  status       TEXT,             -- running|ok|error
  mode         TEXT,             -- manual|scheduled|import
  models_ok    INTEGER, models_failed INTEGER,
  log          TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Rohantworten, damit nie Daten verloren gehen und Felder spaeter neu
-- ausgewertet werden koennen.
CREATE TABLE IF NOT EXISTS raw_pulls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id   TEXT,
  captured_at TEXT,
  kind        TEXT,              -- analytics|detail
  json        TEXT
);

CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id  TEXT,               -- NULL = globales Todo
  title      TEXT NOT NULL,
  done       INTEGER DEFAULT 0,
  priority   INTEGER DEFAULT 1,  -- 0 niedrig | 1 normal | 2 hoch
  due_date   TEXT,
  created_at TEXT,
  done_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_daily_design ON daily_metrics(design_id);
CREATE INDEX IF NOT EXISTS idx_snap_design  ON snapshots(design_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_events_design ON events(design_id);
-- Konto-weite Kennzahlen je Pull (Portfolio-Ebene, aus session.user).
CREATE TABLE IF NOT EXISTS account_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  captured_at   TEXT UNIQUE,
  fan_count     INTEGER, follow_count INTEGER,
  like_count    INTEGER, collection_count INTEGER, download_count INTEGER,
  point         REAL, point_regular REAL, point_exclusive REAL,
  boost         INTEGER, boost_gained INTEGER, level INTEGER,
  my_design_dl  INTEGER, my_instance_dl INTEGER,
  my_design_print INTEGER, my_instance_print INTEGER, design_count INTEGER
);

-- Druckprofile (Instanzen) je Modell, je Pull aktualisiert.
CREATE TABLE IF NOT EXISTS instances (
  design_id     TEXT NOT NULL,
  instance_id   TEXT NOT NULL,
  title         TEXT,
  download_count INTEGER, print_count INTEGER,
  rating_count  INTEGER, rating_score_total REAL, score REAL,
  weight        REAL, prediction INTEGER,
  need_ams      INTEGER, material_color_cnt INTEGER, is_default INTEGER,
  captured_at   TEXT,
  PRIMARY KEY (design_id, instance_id)
);

-- ===== CRM =====
CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  source     TEXT,                 -- makerworld|freund|empfehlung|manuell
  mw_handle  TEXT, email TEXT, phone TEXT,
  tags       TEXT,                 -- JSON-Array
  notes      TEXT,
  stage      TEXT DEFAULT 'neu',   -- neu|kontaktiert|angebot|gewonnen|verloren
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  design_id   TEXT,                -- optionale Modell-Verknuepfung
  status      TEXT DEFAULT 'offen',-- offen|in_arbeit|fertig|abgebrochen
  value       REAL,
  due_date    TEXT,
  created_at  TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL,
  project_id  INTEGER,
  design_id   TEXT,
  title       TEXT,
  qty         INTEGER DEFAULT 1,
  unit_price  REAL DEFAULT 0,
  status      TEXT DEFAULT 'angefragt', -- angefragt|bestaetigt|produktion|versendet|bezahlt|storniert
  order_date  TEXT,
  notes       TEXT,
  created_at  TEXT
);
-- Teile-Katalog ("SAP" = eigene DB): Magnete, Schrauben, Metallteile ...
CREATE TABLE IF NOT EXISTS parts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  category   TEXT,                -- magnet|schraube|metall|elektronik|sonstiges
  unit       TEXT DEFAULT 'Stk',
  unit_price REAL DEFAULT 0,
  notes      TEXT,
  created_at TEXT
);
-- Teile in einem Projekt (Menge x Teil).
CREATE TABLE IF NOT EXISTS project_parts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  part_id    INTEGER NOT NULL,
  qty        REAL DEFAULT 1
);
-- Druckpositionen je Projekt: mehrere Modelle/Druckprofile mit eigener Stueckzahl.
-- Beispiel: 2x Profil "2er-Deckel" + 1x anderes Modell, weil pro Druckbett nur 2 passen.
CREATE TABLE IF NOT EXISTS project_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,
  design_id   TEXT,               -- optionale Modell-Verknuepfung
  instance_id TEXT,               -- gewaehltes Druckprofil (Instanz)
  label       TEXT,               -- Anzeigename (Profil/Modell oder frei)
  qty         INTEGER DEFAULT 1,  -- Anzahl Drucke dieses Profils
  weight_g    REAL,               -- Filament pro Druck (g)
  print_min   REAL,               -- Druckzeit pro Druck (min)
  sort        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_projectparts ON project_parts(project_id);
CREATE INDEX IF NOT EXISTS idx_projectitems ON project_items(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_contact ON projects(contact_id);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(contact_id);
CREATE INDEX IF NOT EXISTS idx_orders_design ON orders(design_id);

-- Betriebsausgaben (Filament-Kaeufe, Drucker, Zubehoer ...)
CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT,
  category    TEXT,                -- filament|drucker|zubehoer|versand|sonstiges
  description TEXT,
  amount      REAL,
  created_at  TEXT
);
-- Punkte-Auszahlungen (Gutschein-Einloesungen)
CREATE TABLE IF NOT EXISTS payouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT,
  points      REAL,
  amount      REAL,
  note        TEXT,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  config     TEXT,               -- JSON: {search,status,sortKey,sortDir}
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_todos_design ON todos(design_id);
`);

// -------- Migrationen (idempotent) -----------------------------------------
{
  const cols = db.prepare('PRAGMA table_info(models)').all().map(c => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE models ADD COLUMN ${ddl}`); };
  add('notes', 'notes TEXT');
  add('goal_download', 'goal_download INTEGER');
  add('goal_view', 'goal_view INTEGER');
  add('goal_point', 'goal_point INTEGER');
  add('group_label', 'group_label TEXT');   // manuelle Gruppe/Typ fuer Auswertung
  add('status', 'status TEXT');              // idee|arbeit|live|update|archiv
  add('planned', 'planned INTEGER DEFAULT 0'); // 1 = geplantes Produkt (noch nicht auf MakerWorld)
  add('cover_hash', 'cover_hash TEXT');         // Hash des Titelbilds fuer zuverlaessige Aenderungserkennung
  add('mw_update_time', 'mw_update_time TEXT');  // updateTime von MakerWorld = letzte Bearbeitung
  // Bestehende (veroeffentlichte) Modelle als "live" markieren.
  db.exec(`UPDATE models SET status='live' WHERE status IS NULL AND publish_date IS NOT NULL`);
}
// Projekt-Kalkulationsfelder
{
  const cols = db.prepare('PRAGMA table_info(projects)').all().map(c => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${ddl}`); };
  add('stage', "stage TEXT DEFAULT 'anfrage'");   // anfrage|modellierung|druck|fertig|abgebrochen
  add('filament_g', 'filament_g REAL');
  add('print_hours', 'print_hours REAL');
  add('labor_hours', 'labor_hours REAL');
  add('margin_tier', 'margin_tier TEXT');          // Name der Margen-Stufe oder 'kostenlos'
  add('price', 'price REAL');                       // vereinbarter Preis / Einnahme
  add('paid', 'paid INTEGER DEFAULT 0');           // bezahlt? (ersetzt Bestell-Status)
  add('qty', 'qty INTEGER DEFAULT 1');             // Stückzahl (fuer Produktverkaeufe)
  add('published', 'published INTEGER DEFAULT 0');  // auf MakerWorld veroeffentlicht/verknuepft
}
// Todos an Kontakt/Projekt haengbar (CRM-Follow-ups)
{
  const cols = db.prepare('PRAGMA table_info(todos)').all().map(c => c.name);
  const add = (name, ddl) => { if (!cols.includes(name)) db.exec(`ALTER TABLE todos ADD COLUMN ${ddl}`); };
  add('contact_id', 'contact_id INTEGER');
  add('project_id', 'project_id INTEGER');
}
// Einmalige Migration: bestehende Bestellungen -> Projekte (Projekte = einzige Geld-Logik)
if (getSetting('orders_migrated', '0') !== '1') {
  try {
    const orders = db.prepare('SELECT * FROM orders').all();
    const stageOf = st => ({ angefragt: 'anfrage', bestaetigt: 'druck', produktion: 'druck', versendet: 'fertig', bezahlt: 'fertig', storniert: 'abgebrochen' }[st] || 'anfrage');
    const ins = db.prepare(`INSERT INTO projects(contact_id,title,design_id,stage,status,price,paid,qty,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    for (const o of orders) ins.run(o.contact_id, o.title || 'Bestellung', o.design_id, stageOf(o.status), 'offen',
      (o.qty || 1) * (o.unit_price || 0), o.status === 'bezahlt' ? 1 : 0, o.qty || 1, o.created_at || nowIso());
    setSetting('orders_migrated', '1');
    if (orders.length) console.log('[migration] ' + orders.length + ' Bestellungen -> Projekte');
  } catch (e) { /* orders-Tabelle evtl. noch nicht da */ }
}

// Einmalige Bereinigung: von MakerWorld automatisch erzeugte 3mf/STL-Render
// (Pfad /msfile/, wechselnder ?at=), Material-/Lizenz-Badges (store.bblcdn,
// /product/public/) sowie die dadurch faelschlich erzeugten "bearbeitet"-Events
// entfernen. Danach zeigt die App nur echte Galerie-Bilder (/design/, /instance/).
if (getSetting('img_cleanup_v1', '0') !== '1') {
  try {
    db.exec(`DELETE FROM images WHERE url NOT LIKE '%/design/%' AND url NOT LIKE '%/instance/%'`);
    db.exec(`DELETE FROM events WHERE type='other' AND title='automatisch erkannt' AND note LIKE 'Modell bearbeitet%'`);
    setSetting('img_cleanup_v1', '1');
  } catch (e) { /* Tabellen evtl. noch nicht da */ }
}

// -------- kleine Helfer ----------------------------------------------------
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(key, String(value));
}

export function nowIso() { return new Date().toISOString(); }
