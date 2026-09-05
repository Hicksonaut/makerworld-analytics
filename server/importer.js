// Importiert einen bestehenden Puller-Export (die 0X_*.csv Dateien) in die DB.
// Aufruf:  node server/importer.js [pfad-zum-export-ordner]
import fs from 'fs';
import path from 'path';
import { db, nowIso } from './db.js';

const DEFAULT_EXPORT = path.resolve(process.cwd(), 'makerworld-export');

// --- minimaler, korrekter CSV-Parser (RFC-4180, Komma, "" Escapes) ---------
function parseCsv(text) {
  text = text.replace(/^﻿/, '');            // BOM weg
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignorieren */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function toObjects(text) {
  const rows = parseCsv(text).filter(r => r.length > 1);
  const head = rows.shift();
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

export function importExport(dir = DEFAULT_EXPORT) {
  const read = f => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) throw new Error('Datei fehlt: ' + p);
    return fs.readFileSync(p, 'utf8');
  };
  const capturedAt = (() => {
    try { return fs.statSync(path.join(dir, '01_summary.csv')).mtime.toISOString(); }
    catch { return nowIso(); }
  })();

  const summary = toObjects(read('01_summary.csv'));
  const daily   = toObjects(read('02_daily.csv'));

  const tx = db.transaction(() => {
    // ---- Modelle + Lifetime-Snapshot + Traffic ----
    const upModel = db.prepare(`
      INSERT INTO models(design_id,title,publish_date,first_data_date,last_data_date,updated_at)
      VALUES(@design_id,@title,@publish_date,@first_data_date,@last_data_date,@updated_at)
      ON CONFLICT(design_id) DO UPDATE SET
        title=excluded.title, publish_date=excluded.publish_date,
        first_data_date=excluded.first_data_date, last_data_date=excluded.last_data_date,
        updated_at=excluded.updated_at`);

    const upSnap = db.prepare(`
      INSERT INTO snapshots(design_id,captured_at,impression,view,download,print,print_total,
        collect,"like",follower,point,point_from_model,point_from_inst,point_regular,point_exclusive,
        boost,boost_regular,boost_exclusive,ctr_pct)
      VALUES(@design_id,@captured_at,@impression,@view,@download,@print,@print_total,
        @collect,@like,@follower,@point,@point_from_model,@point_from_inst,@point_regular,@point_exclusive,
        @boost,@boost_regular,@boost_exclusive,@ctr_pct)
      ON CONFLICT(design_id,captured_at) DO NOTHING`);

    const upTraffic = db.prepare(`
      INSERT INTO traffic_sources(design_id,window,captured_at,recommend,search,browse,direct,other)
      VALUES(@design_id,@window,@captured_at,@recommend,@search,@browse,@direct,@other)
      ON CONFLICT(design_id,window,captured_at) DO UPDATE SET
        recommend=excluded.recommend,search=excluded.search,browse=excluded.browse,
        direct=excluded.direct,other=excluded.other`);

    for (const r of summary) {
      const id = r.designId;
      if (!id) continue;
      upModel.run({
        design_id: id, title: r.title, publish_date: r.publishDate || null,
        first_data_date: r.firstDataDate || null, last_data_date: r.lastDataDate || null,
        updated_at: capturedAt
      });
      upSnap.run({
        design_id: id, captured_at: capturedAt,
        impression: int(r.lt_impression), view: int(r.lt_view), download: int(r.lt_download),
        print: int(r.lt_print), print_total: int(r.lt_printTotal), collect: int(r.lt_collect),
        like: int(r.lt_like), follower: int(r.lt_follower), point: int(r.lt_point),
        point_from_model: int(r.lt_pointFromModel), point_from_inst: int(r.lt_pointFromInst),
        point_regular: int(r.lt_pointRegular), point_exclusive: int(r.lt_pointExclusive),
        boost: int(r.lt_boost), boost_regular: int(r.lt_boostRegular),
        boost_exclusive: int(r.lt_boostExclusive), ctr_pct: num(r.lt_ctr_pct)
      });
      upTraffic.run({ design_id: id, window: 'lifetime', captured_at: capturedAt,
        recommend: num(r.lt_src_recommend), search: num(r.lt_src_search), browse: num(r.lt_src_browse),
        direct: num(r.lt_src_direct), other: num(r.lt_src_other) });
      upTraffic.run({ design_id: id, window: 'd30', captured_at: capturedAt,
        recommend: num(r.d30_src_recommend), search: num(r.d30_src_search), browse: num(r.d30_src_browse),
        direct: num(r.d30_src_direct), other: num(r.d30_src_other) });
      upTraffic.run({ design_id: id, window: 'd90', captured_at: capturedAt,
        recommend: num(r.d90_src_recommend), search: num(r.d90_src_search), browse: num(r.d90_src_browse),
        direct: num(r.d90_src_direct), other: num(r.d90_src_other) });
    }

    // ---- Tageswerte ----
    const upDaily = db.prepare(`
      INSERT INTO daily_metrics(design_id,date,days_since_publish,impression,view,download,print,
        collect,"like",follower,boost,point_from_model,point_from_inst,point_from_ratings,point_from_others)
      VALUES(@design_id,@date,@dsp,@impression,@view,@download,@print,
        @collect,@like,@follower,@boost,@pfm,@pfi,@pfr,@pfo)
      ON CONFLICT(design_id,date) DO UPDATE SET
        days_since_publish=excluded.days_since_publish,
        impression=excluded.impression,view=excluded.view,download=excluded.download,print=excluded.print,
        collect=excluded.collect,"like"=excluded."like",follower=excluded.follower,boost=excluded.boost,
        point_from_model=excluded.point_from_model,point_from_inst=excluded.point_from_inst,
        point_from_ratings=excluded.point_from_ratings,point_from_others=excluded.point_from_others`);

    for (const r of daily) {
      if (!r.designId || !r.date) continue;
      upDaily.run({
        design_id: r.designId, date: r.date, dsp: int(r.days_since_publish),
        impression: int(r.impression) || 0, view: int(r.view) || 0, download: int(r.download) || 0,
        print: int(r.print) || 0, collect: int(r.collect) || 0, like: int(r.like) || 0,
        follower: int(r.follower) || 0, boost: int(r.boost) || 0,
        pfm: int(r.pointFromModel) || 0, pfi: int(r.pointFromInst) || 0,
        pfr: int(r.pointFromRatings) || 0, pfo: int(r.pointFromOthers) || 0
      });
    }
  });
  tx();

  db.prepare(`INSERT INTO pull_runs(started_at,finished_at,status,mode,models_ok,models_failed,log)
              VALUES(?,?,?,?,?,?,?)`)
    .run(capturedAt, nowIso(), 'ok', 'import',
         db.prepare('SELECT COUNT(*) c FROM models').get().c, 0,
         'CSV-Export importiert aus ' + dir);

  const counts = {
    models: db.prepare('SELECT COUNT(*) c FROM models').get().c,
    daily:  db.prepare('SELECT COUNT(*) c FROM daily_metrics').get().c,
    snapshots: db.prepare('SELECT COUNT(*) c FROM snapshots').get().c
  };
  return { capturedAt, ...counts };
}

// direkter Aufruf
import { pathToFileURL } from 'url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || DEFAULT_EXPORT;
  console.log('Importiere Export aus:', dir);
  const res = importExport(dir);
  console.log('Fertig:', res);
}
