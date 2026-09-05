// Gemeinsame Schreiblogik: nimmt pro Modell die Analytics-Antwort (pp) und
// optional die Detail-Extraktion (detail) und schreibt in die DB.
// Wird sowohl vom Browser-Ingest (/api/ingest) als auch vom Playwright-Scraper genutzt.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db, DATA_DIR, IMAGES_DIR, nowIso } from './db.js';

const iso = s => String(s || '').replace(/\//g, '-');
const cell = (row, f) => { const v = row?.[f]; return (v && typeof v === 'object') ? 0 : (v ?? 0); };
const pct = v => { const n = parseFloat(String(v ?? '').replace('%', '')); return Number.isFinite(n) ? n : null; };

const S = {
  model: db.prepare(`
    INSERT INTO models(design_id,title,url,publish_date,first_data_date,last_data_date,
      description,tags,tag_count,cover_url,category,license,instance_count,updated_at)
    VALUES(@design_id,@title,@url,@publish_date,@first_data_date,@last_data_date,
      @description,@tags,@tag_count,@cover_url,@category,@license,@instance_count,@updated_at)
    ON CONFLICT(design_id) DO UPDATE SET
      title=excluded.title,url=excluded.url,publish_date=excluded.publish_date,
      first_data_date=excluded.first_data_date,last_data_date=excluded.last_data_date,
      description=COALESCE(excluded.description,models.description),
      tags=COALESCE(excluded.tags,models.tags),tag_count=COALESCE(excluded.tag_count,models.tag_count),
      cover_url=COALESCE(excluded.cover_url,models.cover_url),
      category=COALESCE(excluded.category,models.category),license=COALESCE(excluded.license,models.license),
      instance_count=COALESCE(excluded.instance_count,models.instance_count),
      updated_at=excluded.updated_at`),
  snap: db.prepare(`
    INSERT INTO snapshots(design_id,captured_at,impression,view,download,print,print_total,
      collect,"like",follower,point,point_from_model,point_from_inst,point_regular,point_exclusive,
      boost,boost_regular,boost_exclusive,ctr_pct,rating_avg,rating_count,like_count,collect_count,comment_count)
    VALUES(@design_id,@captured_at,@impression,@view,@download,@print,@print_total,
      @collect,@like,@follower,@point,@point_from_model,@point_from_inst,@point_regular,@point_exclusive,
      @boost,@boost_regular,@boost_exclusive,@ctr_pct,@rating_avg,@rating_count,@like_count,@collect_count,@comment_count)
    ON CONFLICT(design_id,captured_at) DO NOTHING`),
  daily: db.prepare(`
    INSERT INTO daily_metrics(design_id,date,days_since_publish,impression,view,download,print,
      collect,"like",follower,boost,point_from_model,point_from_inst,point_from_ratings,point_from_others)
    VALUES(@design_id,@date,@dsp,@impression,@view,@download,@print,
      @collect,@like,@follower,@boost,@pfm,@pfi,@pfr,@pfo)
    ON CONFLICT(design_id,date) DO UPDATE SET
      impression=excluded.impression,view=excluded.view,download=excluded.download,print=excluded.print,
      collect=excluded.collect,"like"=excluded."like",follower=excluded.follower,boost=excluded.boost,
      point_from_model=excluded.point_from_model,point_from_inst=excluded.point_from_inst,
      point_from_ratings=excluded.point_from_ratings,point_from_others=excluded.point_from_others,
      days_since_publish=excluded.days_since_publish`),
  traffic: db.prepare(`INSERT INTO traffic_sources(design_id,window,captured_at,recommend,search,browse,direct,other)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(design_id,window,captured_at) DO UPDATE SET
      recommend=excluded.recommend,search=excluded.search,browse=excluded.browse,direct=excluded.direct,other=excluded.other`),
  img: db.prepare(`INSERT INTO images(design_id,position,url,local_path) VALUES(?,?,?,?)
    ON CONFLICT(design_id,url) DO UPDATE SET position=excluded.position,local_path=excluded.local_path`),
  raw: db.prepare(`INSERT INTO raw_pulls(design_id,captured_at,kind,json) VALUES(?,?,?,?)`),
  cover: db.prepare('UPDATE models SET cover_image=COALESCE(cover_image,?) WHERE design_id=?'),
  instance: db.prepare(`INSERT INTO instances(design_id,instance_id,title,download_count,print_count,
      rating_count,rating_score_total,score,weight,prediction,need_ams,material_color_cnt,is_default,captured_at)
    VALUES(@design_id,@instance_id,@title,@download_count,@print_count,@rating_count,@rating_score_total,
      @score,@weight,@prediction,@need_ams,@material_color_cnt,@is_default,@captured_at)
    ON CONFLICT(design_id,instance_id) DO UPDATE SET
      title=excluded.title,download_count=excluded.download_count,print_count=excluded.print_count,
      rating_count=excluded.rating_count,rating_score_total=excluded.rating_score_total,score=excluded.score,
      weight=excluded.weight,prediction=excluded.prediction,need_ams=excluded.need_ams,
      material_color_cnt=excluded.material_color_cnt,is_default=excluded.is_default,captured_at=excluded.captured_at`),
  account: db.prepare(`INSERT INTO account_snapshots(captured_at,fan_count,follow_count,like_count,collection_count,
      download_count,point,point_regular,point_exclusive,boost,boost_gained,level,my_design_dl,my_instance_dl,
      my_design_print,my_instance_print,design_count)
    VALUES(@captured_at,@fan_count,@follow_count,@like_count,@collection_count,@download_count,@point,
      @point_regular,@point_exclusive,@boost,@boost_gained,@level,@my_design_dl,@my_instance_dl,
      @my_design_print,@my_instance_print,@design_count)
    ON CONFLICT(captured_at) DO NOTHING`)
};

// Konto-weite Kennzahlen (session.user) als Snapshot speichern.
export function writeAccount(user, capturedAt) {
  if (!user) return;
  const mw = user.MWCount || {};
  S.account.run({
    captured_at: capturedAt,
    fan_count: user.fanCount ?? null, follow_count: user.followCount ?? null,
    like_count: user.likeCount ?? null, collection_count: user.collectionCount ?? null,
    download_count: user.downloadCount ?? null,
    point: user.point ?? null, point_regular: user.pointRegular ?? null, point_exclusive: user.pointExclusive ?? null,
    boost: user.boost ?? null, boost_gained: user.boostGained ?? null,
    level: user.personal?.userLevel?.level ?? user.userLevel?.level ?? null,
    my_design_dl: mw.myDesignDownloadCount ?? null, my_instance_dl: mw.myInstanceDownloadCount ?? null,
    my_design_print: mw.myDesignPrintCount ?? null, my_instance_print: mw.myInstancePrintCount ?? null,
    design_count: mw.designCount ?? null
  });
}

async function downloadImages(id, urls) {
  const out = [];
  const dir = path.join(IMAGES_DIR, String(id));
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < urls.length && i < 40; i++) {
    const url = urls[i];
    const ext = (String(url).match(/\.(jpe?g|png|webp)/i)?.[1] || 'jpg').toLowerCase();
    const rel = path.posix.join('images', String(id), `${i}.${ext}`);
    const abs = path.join(DATA_DIR, rel);
    try {
      let hash = null;
      if (!fs.existsSync(abs)) {
        const r = await fetch(url);
        if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(abs, buf); if (i === 0) hash = crypto.createHash('sha1').update(buf).digest('hex'); }
      } else if (i === 0) {
        try { hash = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); } catch {}
      }
      out.push({ position: i, url, local_path: rel, hash });
    } catch { /* ueberspringen */ }
  }
  return out;
}
// Titelbild IMMER frisch laden (nicht nach Dateiname cachen), damit ein
// Bildwechsel erkannt wird. Gibt Hash + lokalen Pfad zurueck.
async function fetchCover(id, url) {
  if (!url) return { hash: null, rel: null };
  try {
    const r = await fetch(url); if (!r.ok) return { hash: null, rel: null };
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = (String(url).match(/\.(jpe?g|png|webp)/i)?.[1] || 'jpg').toLowerCase();
    const rel = path.posix.join('images', String(id), `cover.${ext}`);
    fs.mkdirSync(path.join(IMAGES_DIR, String(id)), { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, rel), buf);
    return { hash: crypto.createHash('sha1').update(buf).digest('hex'), rel };
  } catch { return { hash: null, rel: null }; }
}

// Schreibt ein Modell. pp = pageProps der Analytics-Antwort, detail = optional
// {title,description,tags,tagCount,likeCount,collectCount,commentCount,ratingAvg,
//  ratingCount,instanceCount,cover,license,category,images:[url]}
const normText = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stripQuery = u => String(u || '').split('?')[0];
// Aenderungen automatisch als Event festhalten (max. 1 je Typ/Tag/Modell).
function autoEvent(id, type, note, capturedAt) {
  const day = capturedAt.slice(0, 10);
  if (db.prepare('SELECT 1 FROM events WHERE design_id=? AND type=? AND date=?').get(id, type, day)) return false;
  db.prepare('INSERT INTO events(design_id,date,type,title,note,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, day, type, 'automatisch erkannt', note, capturedAt);
  return true;
}
function detectChanges(id, old, { title, description, tags, coverHash, updateTime, detailOk }, capturedAt) {
  if (!old) return;                                  // erster Pull: nichts vergleichen
  if (!detailOk) return;                             // Detail-Abruf fehlgeschlagen -> keine Fehl-Events
  let fired = false;
  if (old.title && title && old.title !== title) fired = autoEvent(id, 'title', `Titel: „${old.title}" → „${title}"`, capturedAt) || fired;
  if (old.description != null && normText(old.description) && normText(old.description) !== normText(description)) fired = autoEvent(id, 'description', 'Beschreibung geändert', capturedAt) || fired;
  if (old.cover_hash && coverHash && old.cover_hash !== coverHash) fired = autoEvent(id, 'thumbnail', 'Titelbild geändert', capturedAt) || fired;
  const oldTags = (() => { try { return old.tags ? JSON.parse(old.tags) : []; } catch { return []; } })();
  const newTags = Array.isArray(tags) ? tags : [];
  if (old.tags != null && newTags.length) {
    const lc = a => a.map(t => String(t).toLowerCase());
    const oset = new Set(lc(oldTags)), nset = new Set(lc(newTags));
    const added = [...nset].filter(t => !oset.has(t)), removed = [...oset].filter(t => !nset.has(t));
    if (added.length || removed.length) {
      const parts = [added.length ? '+ ' + added.join(', ') : '', removed.length ? '– ' + removed.join(', ') : ''].filter(Boolean).join('  ');
      fired = autoEvent(id, 'tags', 'Tags geändert: ' + parts, capturedAt) || fired;
    }
  }
  // Hinweis: updateTime aendert sich auch bei reinen Auto-Neu-Rendern der 3mf
  // durch MakerWorld – daher KEIN Catch-all-Event mehr darauf (nur echte
  // Titel-/Beschreibung-/Tag-/Titelbild-Aenderungen werden protokolliert).
}
// Echte Galerie-Bilder (vom Nutzer), keine Auto-Render/Badges.
const isGalleryImage = u => /\/(?:design|instance)\//i.test(String(u || ''));

export async function writeModel({ id, pp, detail = {}, capturedAt }) {
  const md = pp?.modelData;
  if (!md) throw new Error('keine modelData');
  const oldRow = db.prepare('SELECT title,description,tags,cover_url,cover_hash,mw_update_time FROM models WHERE design_id=?').get(id);
  // Titelbild immer frisch laden + hashen (Basis fuer Aenderungserkennung).
  const coverInfo = await fetchCover(id, detail.cover);
  S.raw.run(id, capturedAt, 'analytics', JSON.stringify(pp));
  if (detail && detail.raw !== undefined) S.raw.run(id, capturedAt, 'detail', JSON.stringify(detail.raw || {}));

  const info = md.designInfo || {}, sum = md.summary || {}, tr = md.trafficSource || {};
  const publish = iso((info.publishTime || '').slice(0, 10));

  db.transaction(() => {
    S.model.run({
      design_id: id, title: info.title || detail.title || id,
      url: `https://makerworld.com/en/models/${id}`,
      publish_date: publish || null,
      first_data_date: iso((pp.minDateStr || '').slice(0, 10)) || null,
      last_data_date: iso((pp.maxDateStr || '').slice(0, 10)) || null,
      description: detail.description || null,
      tags: (detail.tags && detail.tags.length) ? JSON.stringify(detail.tags) : null,
      tag_count: detail.tagCount ?? null,
      cover_url: detail.cover || null, category: detail.category || null,
      license: detail.license || null, instance_count: detail.instanceCount ?? null,
      updated_at: capturedAt
    });
    S.snap.run({
      design_id: id, captured_at: capturedAt,
      impression: sum.impression ?? 0, view: sum.view ?? 0, download: sum.download ?? 0,
      print: sum.print ?? 0, print_total: sum.printTotal ?? 0, collect: sum.collect ?? 0,
      like: sum.like ?? 0, follower: sum.follower ?? 0, point: sum.point ?? 0,
      point_from_model: sum.pointFromModel ?? 0, point_from_inst: sum.pointFromInst ?? 0,
      point_regular: sum.pointRegular ?? 0, point_exclusive: sum.pointExclusive ?? 0,
      boost: sum.boost ?? 0, boost_regular: sum.boostRegular ?? 0, boost_exclusive: sum.boostExclusive ?? 0,
      ctr_pct: sum.impression ? +((sum.view / sum.impression) * 100).toFixed(3) : null,
      rating_avg: detail.ratingAvg ?? null, rating_count: detail.ratingCount ?? null,
      like_count: detail.likeCount ?? null, collect_count: detail.collectCount ?? null,
      comment_count: detail.commentCount ?? null
    });
    for (const row of (md.dateList || [])) {
      const date = iso(row.intervalVal);
      if (publish && date < publish) continue;
      S.daily.run({
        design_id: id, date,
        dsp: publish ? Math.round((Date.parse(date) - Date.parse(publish)) / 86400000) : null,
        impression: cell(row, 'impression'), view: cell(row, 'view'), download: cell(row, 'download'),
        print: cell(row, 'print'), collect: cell(row, 'collect'), like: cell(row, 'like'),
        follower: cell(row, 'follower'), boost: cell(row, 'boost'),
        pfm: cell(row, 'pointFromModel'), pfi: cell(row, 'pointFromInst'),
        pfr: cell(row, 'pointFromRatings'), pfo: cell(row, 'pointFromOthers')
      });
    }
    S.traffic.run(id, 'lifetime', capturedAt, pct(tr.recommend), pct(tr.search), pct(tr.browse), pct(tr.directUrl), pct(tr.others));
  })();

  if (detail.images && detail.images.length) {
    const saved = await downloadImages(id, detail.images.filter(isGalleryImage).map(u => String(u).split('?')[0]));
    for (const im of saved) S.img.run(id, im.position, im.url, im.local_path);
  }
  // Titelbild-Datei + Hash setzen (frisch geladen); cover_image zeigt aufs frische Cover.
  if (coverInfo.rel) db.prepare('UPDATE models SET cover_image=?, cover_hash=? WHERE design_id=?').run(coverInfo.rel, coverInfo.hash, id);

  // Druckprofile (Instanzen) + updateTime aus dem Detail-Rohobjekt.
  const raw = detail.raw || {};
  const updateTime = raw.updateTime || null;
  if (updateTime) db.prepare('UPDATE models SET mw_update_time=? WHERE design_id=?').run(updateTime, id);
  if (Array.isArray(raw.instances)) {
    for (const inst of raw.instances) {
      S.instance.run({
        design_id: id, instance_id: String(inst.id ?? inst.profileId ?? Math.random()),
        title: inst.title || null, download_count: inst.downloadCount ?? null, print_count: inst.printCount ?? null,
        rating_count: inst.ratingCount ?? null, rating_score_total: inst.ratingScoreTotal ?? null, score: inst.score ?? null,
        weight: inst.weight ?? null, prediction: inst.prediction ?? null,
        need_ams: inst.needAms ? 1 : 0, material_color_cnt: inst.materialColorCnt ?? null, is_default: inst.isDefault ? 1 : 0,
        captured_at: capturedAt
      });
    }
  }

  const title = info.title || detail.title || id;
  const detailOk = !!(detail && ((detail.tags && detail.tags.length) || detail.description || detail.cover));
  detectChanges(id, oldRow, { title, description: detail.description, tags: detail.tags, coverHash: coverInfo.hash, updateTime, detailOk }, capturedAt);
  const merged = mergePlanned(id, title);
  return { id, title, days: (md.dateList || []).length,
           tags: detail.tagCount ?? 0, images: detail.images?.length ?? 0, merged };
}

// Geplantes Produkt mit gleichem Titel in das jetzt echte Modell verschmelzen:
// Notizen/Ziele/Gruppe uebernehmen, Todos/Events umhaengen, Platzhalter loeschen.
function mergePlanned(realId, title) {
  const planned = db.prepare(
    "SELECT * FROM models WHERE planned=1 AND design_id!=? AND lower(trim(title))=lower(trim(?))").all(realId, title || '');
  if (!planned.length) return 0;
  db.transaction(() => {
    for (const p of planned) {
      db.prepare('UPDATE todos SET design_id=? WHERE design_id=?').run(realId, p.design_id);
      db.prepare('UPDATE events SET design_id=? WHERE design_id=?').run(realId, p.design_id);
      db.prepare(`UPDATE models SET
        notes=COALESCE(notes,?), group_label=COALESCE(group_label,?),
        goal_download=COALESCE(goal_download,?), goal_view=COALESCE(goal_view,?), goal_point=COALESCE(goal_point,?)
        WHERE design_id=?`).run(p.notes, p.group_label, p.goal_download, p.goal_view, p.goal_point, realId);
      db.prepare('DELETE FROM models WHERE design_id=?').run(p.design_id);
    }
  })();
  return planned.length;
}

export function startRun(mode) {
  const started = nowIso();
  const r = db.prepare(`INSERT INTO pull_runs(started_at,status,mode,models_ok,models_failed,log)
                        VALUES(?,?,?,?,?,?)`).run(started, 'running', mode, 0, 0, '');
  return { runId: r.lastInsertRowid, started };
}
export function updateRun(runId, { ok, failed, log }) {
  db.prepare('UPDATE pull_runs SET models_ok=?,models_failed=?,log=? WHERE id=?')
    .run(ok, failed, log, runId);
}
export function finishRun(runId, { ok, failed, log, status = 'ok' }) {
  db.prepare('UPDATE pull_runs SET status=?,finished_at=?,models_ok=?,models_failed=?,log=? WHERE id=?')
    .run(status, nowIso(), ok, failed, log, runId);
}
