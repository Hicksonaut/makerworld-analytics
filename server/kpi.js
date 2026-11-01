// Kennzahlen-Bausteine: neuester Snapshot, Momentum, Prognose, Gutschein, Gruppen-Aggregation.
import { db, getSetting } from './db.js';

// ---- SQL-Bausteine --------------------------------------------------------
// neuester Snapshot = zuletzt eingefuegter (hoechste id), robuster als
// MAX(captured_at) – ein CSV-Import kann sonst per Datei-Datum den Live-Pull schlagen.
export const latestSnapSub = `
  SELECT s.* FROM snapshots s
  JOIN (SELECT design_id, MAX(id) m FROM snapshots GROUP BY design_id) t
    ON t.design_id = s.design_id AND t.m = s.id`;

export function modelsWithKpis() {
  return db.prepare(`
    SELECT m.*, s.impression, s.view, s.download, s.print, s.collect, s."like", s.follower,
           s.point, s.boost, s.ctr_pct, s.like_count, s.collect_count,
           s.comment_count, s.captured_at AS snap_at
    FROM models m
    LEFT JOIN (${latestSnapSub}) s ON s.design_id = m.design_id
    WHERE COALESCE(m.planned,0)=0
    ORDER BY s.download DESC NULLS LAST, s.view DESC NULLS LAST`).all();
}

// ---- API ------------------------------------------------------------------
// Momentum je Modell (7/30-Tage-Fenster, Delta ggue. Vorperiode) + Sparkline.
export function attachMomentum(models) {
  const mom = {};
  for (const r of db.prepare(`
    SELECT design_id,
      SUM(CASE WHEN date >= date('now','-7 day')  THEN download ELSE 0 END) dl7,
      SUM(CASE WHEN date >= date('now','-14 day') AND date < date('now','-7 day') THEN download ELSE 0 END) dl_p7,
      SUM(CASE WHEN date >= date('now','-30 day') THEN download ELSE 0 END) dl30,
      SUM(CASE WHEN date >= date('now','-7 day')  THEN view ELSE 0 END) v7,
      SUM(CASE WHEN date >= date('now','-14 day') AND date < date('now','-7 day') THEN view ELSE 0 END) v_p7,
      SUM(CASE WHEN date >= date('now','-30 day') THEN view ELSE 0 END) v30,
      SUM(CASE WHEN date >= date('now','-30 day') THEN (point_from_model+point_from_inst+point_from_ratings+point_from_others) ELSE 0 END) pts30
    FROM daily_metrics GROUP BY design_id`).all()) mom[r.design_id] = r;
  const spark = {};
  for (const r of db.prepare(`SELECT design_id, view FROM daily_metrics
      WHERE date >= date('now','-30 day') ORDER BY design_id, date`).all())
    (spark[r.design_id] = spark[r.design_id] || []).push(r.view || 0);
  for (const m of models) {
    const x = mom[m.design_id] || {};
    m.dl7 = x.dl7 || 0; m.dl30 = x.dl30 || 0; m.v7 = x.v7 || 0; m.v30 = x.v30 || 0; m.pts30 = x.pts30 || 0;
    m.dl_per_day = +(m.dl7 / 7).toFixed(2); m.v_per_day = +(m.v7 / 7).toFixed(1);
    m.dl_delta = (x.dl7 || 0) - (x.dl_p7 || 0);            // absolute Aenderung Woche vs Vorwoche
    m.v_trend = (x.v_p7 > 0) ? +(((x.v7 - x.v_p7) / x.v_p7) * 100).toFixed(0) : null; // % ggue Vorwoche
    m.spark = spark[m.design_id] || [];
  }
  return models;
}

// Prognose je Modell per linearer Regression ueber die letzten 90 Tage (dichte
// Tagesreihe, fehlende Tage = 0). Trifft Anlauf/Abklingen besser als 30-Tage-Schnitt.
function projectSeries(dense, days) {
  const n = dense.length; if (!n) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += dense[i]; sxx += i * i; sxy += i * dense[i]; }
  const det = n * sxx - sx * sx;
  const b = det ? (n * sxy - sx * sy) / det : 0, a = (sy - b * sx) / n;
  let sum = 0; for (let t = n; t < n + days; t++) sum += Math.max(0, a + b * t);
  return Math.round(sum);
}
export function attachForecast(models) {
  const WIN = 90;
  const base = new Date(); base.setUTCHours(0, 0, 0, 0);
  const dates = []; for (let i = WIN - 1; i >= 0; i--) { const d = new Date(base); d.setUTCDate(d.getUTCDate() - i); dates.push(d.toISOString().slice(0, 10)); }
  const idx = new Map(dates.map((d, i) => [d, i]));
  const series = {};
  for (const r of db.prepare(`SELECT design_id, date, download, view,
      (point_from_model+point_from_inst+point_from_ratings+point_from_others) pts
      FROM daily_metrics WHERE date >= ?`).all(dates[0])) {
    const i = idx.get(r.date); if (i == null) continue;
    const s = series[r.design_id] || (series[r.design_id] = { dl: Array(WIN).fill(0), vw: Array(WIN).fill(0), pt: Array(WIN).fill(0) });
    s.dl[i] += r.download || 0; s.vw[i] += r.view || 0; s.pt[i] += r.pts || 0;
  }
  const rate = eurRate();
  for (const m of models) {
    const s = series[m.design_id] || { dl: [], vw: [], pt: [] };
    m.proj_dl30 = projectSeries(s.dl, 30); m.proj_dl90 = projectSeries(s.dl, 90);
    m.proj_v30 = projectSeries(s.vw, 30); m.proj_v90 = projectSeries(s.vw, 90);
    m.proj_pts30 = projectSeries(s.pt, 30); m.proj_pts90 = projectSeries(s.pt, 90);
    m.proj_eur30 = +(m.proj_pts30 * rate).toFixed(2); m.proj_eur90 = +(m.proj_pts90 * rate).toFixed(2);
  }
  return models;
}

// 524 Punkte = 40 EUR-Gutschein (MakerWorld). Eine Stelle fuer die Konstanten.
export const VOUCHER_POINTS = 524, VOUCHER_EUR = 40;
const DEFAULT_RATE = VOUCHER_EUR / VOUCHER_POINTS;
// Gutschein-Status aus Kontostand + erwarteten Punkten je Tag. EINZIGE Quelle fuer die ETA
// (Uebersicht, Heute-Insights, Bericht) - Basis ist die Trend-Prognose (attachForecast, 90 Tage).
export function voucherStatus(walletPts, perDayPts) {
  const remaining = Math.max(0, VOUCHER_POINTS - ((walletPts || 0) % VOUCHER_POINTS));
  return { remaining: Math.round(remaining), perDay: perDayPts, etaDays: perDayPts > 0 ? Math.ceil(remaining / perDayPts) : null };
}
// ---- Gruppierung (Kategorie / eigene Gruppe / Hashtag): EINE Stelle fuer Schluessel + Aggregation ----
const parseTags = m => { try { return m.tags ? JSON.parse(m.tags) : []; } catch { return []; } };
export function groupKeysOf(m, by) {
  if (by === 'tag') { const t = parseTags(m); return t.length ? t : ['—']; }
  return [(by === 'group' ? m.group_label : m.category) || '—'];
}
const GROUP_SUM = ['view', 'impression', 'download', 'print', 'collect', 'like', 'point', 'boost', 'dl30', 'v30'];
export function aggregateGroups(models, by) {
  const buckets = {};
  for (const m of models) for (const key of groupKeysOf(m, by)) {
    const b = buckets[key] || (buckets[key] = { key, count: 0, ...Object.fromEntries(GROUP_SUM.map(k => [k, 0])) });
    b.count++; for (const k of GROUP_SUM) b[k] += (m[k] || 0);
  }
  return Object.values(buckets).map(b => ({ ...b, ctr: b.impression ? +((b.view / b.impression) * 100).toFixed(2) : null })).sort((a, b) => b.download - a.download);
}
export const eurRate = () => { const r = parseFloat(getSetting('eur_per_point', String(DEFAULT_RATE))); return Number.isFinite(r) ? r : DEFAULT_RATE; };
