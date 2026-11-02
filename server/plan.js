// Eigenprojekt = Planung des spaeteren MakerWorld-Uploads. Beim Anlegen entsteht ein geplantes Modell (plan_...), das Beschreibung,
// Tags und Upload-Paket traegt. Eine Verknuepfung mit dem echten MakerWorld-Modell gibt es erst nach dem Veroeffentlichen:
// Der Pull verschmilzt das geplante Modell dann per Titel mit dem echten (mergePlanInto), oder du verknuepfst manuell.
import { db, nowIso } from './db.js';

export const isPlanId = id => typeof id === 'string' && id.startsWith('plan_');

// Geplantes Modell fuer ein Eigenprojekt anlegen (falls noch keins verknuepft ist) und die Verknuepfung setzen.
export function ensurePlan(project) {
  if (project.design_id) return project.design_id;
  const id = 'plan_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  db.prepare(`INSERT INTO models(design_id,title,description,status,planned,created_at,updated_at) VALUES(?,?,?,?,1,?,?)`)
    .run(id, project.title, project.description || null, 'idee', nowIso(), nowIso());
  db.prepare('UPDATE projects SET design_id=? WHERE id=?').run(id, project.id);
  return id;
}

// Geplantes Modell in das echte verschmelzen: Notizen/Ziele/Gruppe uebernehmen, Todos/Events/Projekte/Upload-Paket umhaengen,
// Platzhalter loeschen. Eigenprojekte springen dabei auf "Veroeffentlicht".
export function mergePlanInto(planId, realId) {
  const p = db.prepare('SELECT * FROM models WHERE design_id=? AND planned=1').get(planId);
  if (!p || planId === realId) return false;
  db.transaction(() => {
    db.prepare('UPDATE todos SET design_id=? WHERE design_id=?').run(realId, planId);
    db.prepare('UPDATE events SET design_id=? WHERE design_id=?').run(realId, planId);
    db.prepare(`UPDATE models SET notes=COALESCE(notes,?), group_label=COALESCE(group_label,?),
      goal_download=COALESCE(goal_download,?), goal_view=COALESCE(goal_view,?), goal_point=COALESCE(goal_point,?) WHERE design_id=?`)
      .run(p.notes, p.group_label, p.goal_download, p.goal_view, p.goal_point, realId);
    db.prepare(`UPDATE projects SET design_id=?, published=1, stage=CASE WHEN self=1 THEN 'publish' ELSE stage END,
      close_date=CASE WHEN self=1 AND close_date IS NULL THEN ? ELSE close_date END WHERE design_id=?`).run(realId, nowIso().slice(0, 10), planId);
    db.prepare('UPDATE project_items SET design_id=? WHERE design_id=?').run(realId, planId);
    try {   // Tabellen/Eintraege des Upload-Assistenten (koennen fehlen, wenn das Modul nicht geladen ist)
      if (db.prepare('SELECT 1 FROM upload_packs WHERE design_id=?').get(realId)) db.prepare('DELETE FROM upload_packs WHERE design_id=?').run(planId);
      else db.prepare('UPDATE upload_packs SET design_id=? WHERE design_id=?').run(realId, planId);
    } catch { /* kein Upload-Paket */ }
    db.prepare("UPDATE settings SET key='tag_result:'||? WHERE key='tag_result:'||? AND NOT EXISTS (SELECT 1 FROM settings WHERE key='tag_result:'||?)").run(realId, planId, realId);
    db.prepare('DELETE FROM models WHERE design_id=?').run(planId);
  })();
  return true;
}
