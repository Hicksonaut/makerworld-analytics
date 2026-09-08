// Seeds the database with realistic FAKE demo data so you can explore the app
// (and take screenshots) without pulling anything from MakerWorld.
//   node server/seed-demo.js            # only seeds an empty database
//   node server/seed-demo.js --force    # wipe demo-relevant tables first
// No real account, customer or financial data — everything below is invented.
import { db, nowIso, setSetting } from './db.js';

const force = process.argv.includes('--force');
const existing = db.prepare('SELECT COUNT(*) c FROM models').get().c;
if (existing && !force) {
  console.error(`Database already has ${existing} models. Refusing to seed.\n` +
    `Use  node server/seed-demo.js --force  to wipe and reseed (demo/testing only!).`);
  process.exit(1);
}

const iso = d => d.toISOString().slice(0, 10);
const capturedAt = nowIso();
const today = new Date();
const daysAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };

if (force) {
  for (const t of ['models', 'snapshots', 'daily_metrics', 'traffic_sources', 'events',
    'instances', 'account_snapshots', 'images',
    'contacts', 'projects', 'project_parts', 'project_items', 'parts', 'todos', 'spools', 'milestones'])
    { try { db.exec(`DELETE FROM ${t}`); } catch {} }
}

// --- demo models -----------------------------------------------------------
const MODELS = [
  { id: 'demo-1001', title: 'Hexagon Coaster Set (6er)', category: 'Home & Living / Decor', days: 210,
    tags: ['coaster', 'hexagon', 'home decor', 'kitchen', 'gift', 'minimalist'],
    base: { imp: 900, ctr: 6.5, dlRate: 0.9, ptRate: 3.2 }, weight: 42, printMin: 95 },
  { id: 'demo-1002', title: 'Cable Clip — Desk Management', category: 'Gadgets / Organizers', days: 160,
    tags: ['cable management', 'desk', 'organizer', 'office', 'clip'],
    base: { imp: 1600, ctr: 8.1, dlRate: 1.4, ptRate: 4.0 }, weight: 8, printMin: 22 },
  { id: 'demo-1003', title: 'Minimalist Desk Pen Holder', category: 'Office / Desk', days: 120,
    tags: ['pen holder', 'desk', 'office', 'minimalist', 'organizer'],
    base: { imp: 700, ctr: 5.4, dlRate: 0.6, ptRate: 2.1 }, weight: 65, printMin: 140 },
  { id: 'demo-1004', title: 'Wall Hook (screwless)', category: 'Home & Living / Storage', days: 90,
    tags: ['wall hook', 'storage', 'home', 'no screws', 'organizer'],
    base: { imp: 520, ctr: 7.0, dlRate: 0.8, ptRate: 2.6 }, weight: 15, printMin: 35 },
  { id: 'demo-1005', title: 'Dice Tower — Tabletop', category: 'Toys & Games / Tabletop', days: 65,
    tags: ['dice tower', 'tabletop', 'board games', 'dnd', 'dice'],
    base: { imp: 2100, ctr: 9.2, dlRate: 1.1, ptRate: 3.4 }, weight: 120, printMin: 300 },
];

const mModel = db.prepare(`INSERT INTO models
  (design_id,title,url,publish_date,first_data_date,last_data_date,description,tags,tag_count,
   category,license,instance_count,status,created_at,updated_at,mw_update_time)
  VALUES (@design_id,@title,@url,@publish_date,@first,@last,@description,@tags,@tag_count,
   @category,@license,@instance_count,'live',@now,@now,@upd)`);
const mDaily = db.prepare(`INSERT INTO daily_metrics
  (design_id,date,days_since_publish,impression,view,download,print,collect,"like",follower,boost,
   point_from_model,point_from_inst,point_from_ratings,point_from_others)
  VALUES (@design_id,@date,@dsp,@impression,@view,@download,@print,@collect,@like,@follower,@boost,
   @pfm,@pfi,@pfr,@pfo)`);
const mSnap = db.prepare(`INSERT INTO snapshots
  (design_id,captured_at,impression,view,download,print,print_total,collect,"like",follower,
   point,point_from_model,point_from_inst,point_regular,point_exclusive,boost,ctr_pct,
   like_count,collect_count,comment_count)
  VALUES (@design_id,@cap,@impression,@view,@download,@print,@print,@collect,@like,@follower,
   @point,@pfm,@pfi,@point,0,@boost,@ctr,@like,@collect,@comment)`);
const mTraffic = db.prepare(`INSERT INTO traffic_sources
  (design_id,window,captured_at,recommend,search,browse,direct,other)
  VALUES (?,?,?,?,?,?,?,?)`);
const mInst = db.prepare(`INSERT INTO instances
  (design_id,instance_id,title,download_count,print_count,rating_count,rating_score_total,score,
   weight,prediction,need_ams,material_color_cnt,is_default,captured_at)
  VALUES (@design_id,@instance_id,@title,@dl,@print,@rc,@rst,@score,@weight,@prediction,@ams,@mc,@def,@cap)`);
const mEvent = db.prepare(`INSERT INTO events (design_id,date,type,title,note,created_at)
  VALUES (?,?,?,?,?,?)`);

const rnd = (a, b) => a + Math.random() * (b - a);
for (const m of MODELS) {
  const publish = daysAgo(m.days);
  let cImp = 0, cView = 0, cDl = 0, cPrint = 0, cCollect = 0, cLike = 0, cFoll = 0, cPtM = 0, cPtI = 0, cPtR = 0, cPtO = 0, cBoost = 0;
  const N = Math.min(m.days, 180);
  for (let i = N; i >= 0; i--) {
    const d = daysAgo(i);
    const age = m.days - i;
    // impressions: rise then long tail
    const ramp = age < 21 ? age / 21 : Math.max(0.25, 1 - (age - 21) / 400);
    const imp = Math.round(m.base.imp * ramp * rnd(0.7, 1.3));
    const view = Math.round(imp * (m.base.ctr / 100) * rnd(0.85, 1.15));
    const dl = Math.round(view * (m.base.dlRate / 10) * rnd(0.6, 1.4));
    const print = Math.round(dl * rnd(0.15, 0.4));
    const collect = Math.round(view * 0.02 * rnd(0, 1.6));
    const like = Math.round(view * 0.03 * rnd(0, 1.5));
    const foll = Math.random() < 0.15 ? 1 : 0;
    const pfm = Math.round(dl * (m.base.ptRate / 3) * rnd(0.6, 1.3));
    const pfi = Math.round(print * rnd(0.4, 1.2));
    const pfr = Math.random() < 0.1 ? Math.round(rnd(1, 4)) : 0;
    const pfo = Math.random() < 0.06 ? Math.round(rnd(1, 3)) : 0;
    const boost = Math.random() < 0.05 ? Math.round(rnd(1, 5)) : 0;
    mDaily.run({ design_id: m.id, date: iso(d), dsp: age, impression: imp, view, download: dl, print,
      collect, like, follower: foll, boost, pfm, pfi, pfr, pfo });
    cImp += imp; cView += view; cDl += dl; cPrint += print; cCollect += collect; cLike += like;
    cFoll += foll; cPtM += pfm; cPtI += pfi; cPtR += pfr; cPtO += pfo; cBoost += boost;
  }
  mModel.run({ design_id: m.id, title: m.title, url: 'https://makerworld.com/en/models/' + m.id,
    publish_date: iso(publish), first: iso(daysAgo(m.days)), last: iso(today),
    description: `Demo model. ${m.title} — printable, tuned for FDM, no supports. ` +
      `This description is sample data for the open-source demo and is not a real listing.`,
    tags: JSON.stringify(m.tags), tag_count: m.tags.length, category: m.category,
    license: 'Standard Digital File License', instance_count: 2, now: capturedAt, upd: iso(daysAgo(Math.floor(m.days / 3))) + 'T10:00:00Z' });
  const totalPt = cPtM + cPtI + cPtR + cPtO;
  mSnap.run({ design_id: m.id, cap: capturedAt, impression: cImp, view: cView, download: cDl,
    print: cPrint, collect: cCollect, like: cLike, follower: cFoll, point: totalPt, pfm: cPtM, pfi: cPtI,
    boost: cBoost, ctr: +((cView / cImp) * 100).toFixed(3), comment: Math.round(cLike * 0.1) });
  mTraffic.run(m.id, 'lifetime', capturedAt, +rnd(45, 65).toFixed(1), +rnd(12, 22).toFixed(1),
    +rnd(8, 16).toFixed(1), +rnd(3, 8).toFixed(1), +rnd(2, 6).toFixed(1));
  mInst.run({ design_id: m.id, instance_id: m.id + '-a', title: '0.2mm / default', dl: Math.round(cDl * 0.7),
    print: Math.round(cPrint * 0.7), rc: Math.round(rnd(2, 20)), rst: 0, score: +rnd(4.4, 5).toFixed(2),
    weight: m.weight, prediction: m.printMin * 60, ams: 0, mc: 1, def: 1, cap: capturedAt });
  mInst.run({ design_id: m.id, instance_id: m.id + '-b', title: 'multicolor (AMS)', dl: Math.round(cDl * 0.3),
    print: Math.round(cPrint * 0.3), rc: Math.round(rnd(0, 8)), rst: 0, score: +rnd(4.3, 5).toFixed(2),
    weight: Math.round(m.weight * 1.05), prediction: Math.round(m.printMin * 1.4) * 60, ams: 1, mc: 3, def: 0, cap: capturedAt });
}
// a couple of change-timeline events
mEvent.run('demo-1001', iso(daysAgo(30)), 'thumbnail', 'automatisch erkannt', 'Titelbild geändert', capturedAt);
mEvent.run('demo-1002', iso(daysAgo(14)), 'tags', 'automatisch erkannt', 'Tags geändert: + cable management', capturedAt);

// --- account snapshot (portfolio KPIs) ------------------------------------
db.prepare(`INSERT INTO account_snapshots
  (captured_at,fan_count,follow_count,like_count,collection_count,download_count,point,point_regular,
   point_exclusive,boost,boost_gained,level,my_design_dl,my_instance_dl,my_design_print,my_instance_print,design_count)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(capturedAt, 128, 34, 640, 210, 2450, 470, 470, 0, 12, 3, 4, 2450, 1800, 520, 410, MODELS.length);

// --- CRM demo --------------------------------------------------------------
const mkContact = db.prepare(`INSERT INTO contacts (name,source,mw_handle,email,tags,notes,stage,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);
const cAlex = mkContact.run('Alex M.', 'freund', null, 'alex@example.com', '["stammkunde"]', 'Prints for the board-game group.', 'gewonnen', capturedAt, capturedAt).lastInsertRowid;
const cJordan = mkContact.run('Jordan P.', 'makerworld', 'jordan_makes', 'jordan@example.com', '[]', 'Found me via a coaster model.', 'gewonnen', capturedAt, capturedAt).lastInsertRowid;
const cSam = mkContact.run('Sam K.', 'empfehlung', null, null, '[]', 'Referred by Alex.', 'angebot', capturedAt, capturedAt).lastInsertRowid;

const mkPart = db.prepare('INSERT INTO parts (name,category,unit,unit_price,notes,created_at) VALUES (?,?,?,?,?,?)');
const pMagnet = mkPart.run('Neodym magnet 6×2mm', 'magnet', 'Stk', 0.08, null, capturedAt).lastInsertRowid;
const pScrew = mkPart.run('Screw M3×8', 'schraube', 'Stk', 0.02, null, capturedAt).lastInsertRowid;
const pCork = mkPart.run('Cork pad Ø40mm', 'sonstiges', 'Stk', 0.05, null, capturedAt).lastInsertRowid;

const mkProject = db.prepare(`INSERT INTO projects
  (contact_id,title,description,design_id,stage,status,filament_g,print_hours,labor_hours,margin_tier,price,paid,qty,published,due_date,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
// paid friend job with multiple print positions
const prCoaster = mkProject.run(cAlex, 'Coaster batch (12 pcs)', 'Two beds of the hex coaster.', 'demo-1001',
  'fertig', 'offen', null, null, 0.5, 'Freunde', 8, 1, 12, 1, iso(daysAgo(20)), capturedAt).lastInsertRowid;
db.prepare('INSERT INTO project_items (project_id,design_id,instance_id,label,qty,weight_g,print_min,sort) VALUES (?,?,?,?,?,?,?,?)')
  .run(prCoaster, 'demo-1001', 'demo-1001-a', 'Hexagon Coaster Set · 0.2mm / default', 2, 42, 95, 1);
db.prepare('INSERT INTO project_parts (project_id,part_id,qty) VALUES (?,?,?)').run(prCoaster, pCork, 12);
// free gift that later earns on MakerWorld
mkProject.run(cJordan, 'Pen holder (gift)', 'Modeled for free, then published.', 'demo-1003',
  'fertig', 'offen', 65, 2.3, 1.5, 'kostenlos', 0, 1, 1, 1, iso(daysAgo(40)), capturedAt);
// open request in the pipeline
mkProject.run(cSam, 'Wall hooks for hallway', null, 'demo-1004',
  'druck', 'offen', 15, 0.6, 0.3, 'Standard', null, 0, 4, 0, null, capturedAt);

// priorities + deadlines on the customer projects (0 low … 3 urgent)
db.prepare('UPDATE projects SET priority=?, due_date=? WHERE id=?').run(3, iso(daysAgo(-4)), prCoaster); // urgent, due in 4d
db.prepare("UPDATE projects SET priority=1 WHERE title='Pen holder (gift)'");
db.prepare("UPDATE projects SET priority=2, due_date=? WHERE title='Wall hooks for hallway'").run(iso(daysAgo(-10)));

// --- own projects (no customer): model → print → photos → MW entry → published
const mkSelf = db.prepare(`INSERT INTO projects
  (title,description,design_id,stage,status,self,priority,kind,filament_g,print_hours,labor_hours,due_date,published,created_at)
  VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?)`);
mkSelf.run('Modular Desk Organizer', 'Own product idea, several trays.', null, 'modellierung', 'offen', 3, 'modell_print', null, null, 3, iso(daysAgo(-7)), 0, capturedAt);
mkSelf.run('Parametric Cable Clips', 'Print set, then photograph.', null, 'druck', 'offen', 1, 'modell_print', 30, 1.0, 0.5, null, 0, capturedAt);
mkSelf.run('Fan Grill Cover 120mm', 'Backlog idea.', null, 'idee', 'offen', 2, 'modell_print', null, null, null, iso(daysAgo(-25)), 0, capturedAt);
mkSelf.run('Phone Stand v2', 'Reworked, already published.', 'demo-1002', 'publish', 'offen', 1, 'modell_print', 48, 1.8, 2, null, 1, capturedAt);

// --- filament stock (spools) ----------------------------------------------
const mkSpool = db.prepare('INSERT INTO spools (material,color,hex,brand,total_g,remaining_g,cost,created_at) VALUES (?,?,?,?,?,?,?,?)');
mkSpool.run('PLA', 'Schwarz', '#1b1b1b', 'Bambu', 1000, 640, 19.99, capturedAt);
mkSpool.run('PLA', 'Weiß', '#f2f2f2', 'Bambu', 1000, 120, 19.99, capturedAt);   // low
mkSpool.run('PETG', 'Rot', '#b02a2a', 'Sunlu', 1000, 810, 15.99, capturedAt);

// --- global settings / a demo todo ----------------------------------------
setSetting('handle', '@you');
db.prepare('INSERT INTO todos (title,priority,created_at) VALUES (?,?,?)')
  .run('Try a live pull once you are logged in', 1, capturedAt);

console.log('Seeded demo data:');
console.log(`  models       ${db.prepare('SELECT COUNT(*) c FROM models').get().c}`);
console.log(`  daily rows   ${db.prepare('SELECT COUNT(*) c FROM daily_metrics').get().c}`);
console.log(`  contacts     ${db.prepare('SELECT COUNT(*) c FROM contacts').get().c}`);
console.log(`  projects     ${db.prepare('SELECT COUNT(*) c FROM projects').get().c}`);
console.log('Open http://localhost:4000 to explore. Everything here is fake sample data.');
