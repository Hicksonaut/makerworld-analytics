// Betriebs-Tests: RAM-Waechter vor dem Pull und Migrationen beim Start.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from './helpers.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('RAM-Waechter', () => {
  it('startet keinen Pull bei zu wenig freiem Arbeitsspeicher und meldet es als Fehlerlauf', async () => {
    const fake = path.join(os.tmpdir(), 'mwa-meminfo-' + process.pid); fs.writeFileSync(fake, 'MemAvailable:     204800 kB\n');
    const app = await startApp({ env: { MEMINFO_FILE: fake, PULL_MIN_RAM_MB: '800', PULL_RAM_WAIT_MS: '50' } });
    try {
      assert.equal((await app.api('POST', '/pull/start')).body.started, true);
      await sleep(2500);
      const st = (await app.api('GET', '/pull/status')).body;
      assert.equal(st.running, false); assert.match(st.lastResult.error, /Zu wenig freier Arbeitsspeicher/);
      const d = app.db(); const run = d.prepare('SELECT status, log FROM pull_runs ORDER BY id DESC LIMIT 1').get(); d.close();
      assert.equal(run.status, 'error'); assert.match(run.log, /Arbeitsspeicher/);
      const h = (await app.api('GET', '/health')).body; assert.equal(h.memAvailableMb, 200);
      assert.ok(h.issues.some(i => /Pull ist fehlgeschlagen/.test(i.text)) && h.issues.some(i => /Arbeitsspeicher/.test(i.text)));
    } finally { await app.stop(); app.cleanup(); fs.rmSync(fake, { force: true }); }
  });
});

describe('Migrationen beim Start', () => {
  it('bereinigt doppelte Meilensteine, schliesst haengende Pulls, entfernt leere Alt-Tabellen und Reste', async () => {
    const app = await startApp(); const dataDir = app.dataDir;
    await app.stop();
    let d = app.db();
    d.exec('DROP INDEX IF EXISTS ux_milestones_key'); d.prepare("DELETE FROM settings WHERE key IN ('milestones_dedupe_v1','orders_dropped_v1','cleanup_v2')").run();
    const ins = d.prepare("INSERT INTO milestones(design_id,kind,threshold,title,date,created_at) VALUES(NULL,'voucher',524,'524 Punkte','2026-01-01','x')");
    for (let i = 0; i < 5; i++) ins.run();
    d.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, contact_id INTEGER)");
    d.prepare("INSERT INTO settings(key,value) VALUES('bambu_ip','1.2.3.4') ON CONFLICT(key) DO NOTHING").run();
    d.prepare("INSERT INTO pull_runs(started_at,status,mode,log) VALUES('2026-01-01T00:00:00Z','running','manual','')").run();
    d.close();
    const again = await startApp({ dataDir, seed: false });
    try {
      d = again.db();
      assert.equal(d.prepare("SELECT COUNT(*) c FROM milestones WHERE kind='voucher' AND threshold=524").get().c, 1, 'Duplikate bleiben');
      assert.ok(d.prepare("SELECT name FROM sqlite_master WHERE name='ux_milestones_key'").get(), 'Index fehlt');
      assert.equal(d.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='orders'").get().c, 0, 'orders nicht entfernt');
      assert.equal(d.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'bambu%'").get().c, 0, 'bambu-Reste');
      assert.equal(d.prepare("SELECT COUNT(*) c FROM pull_runs WHERE status='running'").get().c, 0, 'haengender Lauf');
      d.close();
      // der Index verhindert neue Duplikate auch fuer design_id = NULL
      d = again.db(); d.prepare("INSERT OR IGNORE INTO milestones(design_id,kind,threshold,title,date,created_at) VALUES(NULL,'voucher',524,'x','x','x')").run();
      assert.equal(d.prepare("SELECT COUNT(*) c FROM milestones WHERE kind='voucher' AND threshold=524").get().c, 1); d.close();
    } finally { await again.stop(); again.cleanup(); }
  });
  it('behaelt eine nicht leere orders-Tabelle (kein Datenverlust)', async () => {
    const app = await startApp(); await app.stop();
    let d = app.db(); d.prepare("DELETE FROM settings WHERE key='orders_dropped_v1'").run(); d.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, contact_id INTEGER)'); d.exec('INSERT INTO orders(contact_id) VALUES (1)'); d.close();
    const again = await startApp({ dataDir: app.dataDir, seed: false });
    try { d = again.db(); assert.equal(d.prepare("SELECT COUNT(*) c FROM orders").get().c, 1); d.close(); } finally { await again.stop(); again.cleanup(); }
  });
});
