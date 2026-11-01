// Start: Routen-Tabelle (muss NACH allen Ansichten stehen) und Initialisierung.
// -------- Routing --------
const routes = { heute: renderHeute, overview: renderOverview, momentum: renderMomentum, compare: renderCompare,
  groups: renderGroups, points: renderPoints, report: renderReport,
  contacts: renderContacts, leads: renderLeads, projekte: renderProjekte, revenue: renderRevenue, teile: renderParts,
  pipeline: renderPipeline, selbst: renderSelfProjects, druckplan: renderDruckplan, material: renderMaterial,
  todos: renderTodos, data: renderData };

// ---- Start ----
setupSearch();
applyNavLang();
(async () => { api('/settings').then(s => { if (s && s.lang && s.lang !== LANG.cur) jpost('/settings', { lang: LANG.cur }); }).catch(() => {});
  await loadOverview(); const route = location.hash.slice(1) || 'heute'; go(route); pollPull(); autoLabel(); })();
