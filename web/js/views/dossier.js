/**
 * views/dossier.js — 个人训练档案页（v2：本地确定性聚合的长期基线，只读）
 * 数据源 GET /api/dossier（settings dossier 缓存，数据变更后自动重建）。
 */

import { app, esc, api } from "../common.js";
import { t } from "../i18n.js";

const fmtPct = (x) => (x == null ? "—" : `${Math.round(x * 10) / 10}%`);
const fmtNum = (x) => (x == null ? "—" : String(x));

function metric(label, value, sub) {
  return `<div class="metric">
    <div class="m-label">${esc(label)}</div>
    <div class="m-value">${esc(value)}</div>
    ${sub ? `<div class="m-sub">${esc(sub)}</div>` : ""}
  </div>`;
}

function peaksText(peaks) {
  if (!peaks?.length) return "—";
  return peaks.map((p) => `${p.window} ${p.value_w} W`).join(" · ");
}

export async function renderDossier() {
  app.innerHTML = `<div class="empty loading">${esc(t("common.loading"))}</div>`;
  const { dossier } = await api("/api/dossier");
  if (!dossier) {
    app.innerHTML = `<div class="view-title"><h1>${esc(t("dossierPage.title"))}</h1></div>
      <div class="empty">${esc(t("dossierPage.empty"))}</div>`;
    return;
  }
  const c = dossier.cycling || {};
  const cp = dossier.climb_profile || {};
  const cad = dossier.cadence_profile || {};
  const zones = dossier.intensity_structure?.zone_pct || null;
  const hzones = dossier.intensity_structure?.hr_zone_pct || null;
  const weeks = dossier.load_shape?.weeks || [];
  const drift = dossier.load_shape?.hr_drift || {};
  const totalTss = weeks.reduce((a, w) => a + w.tss, 0);
  const totalHours = weeks.reduce((a, w) => a + w.duration_sec, 0) / 3600;

  const zoneText = zones
    ? t("dossierPage.zones_line", {
        low: fmtPct((zones.Z1 ?? 0) + (zones.Z2 ?? 0)),
        mid: fmtPct((zones.Z3 ?? 0) + (zones.Z4 ?? 0)),
        high: fmtPct((zones.Z5 ?? 0) + (zones.Z6 ?? 0) + (zones.Z7 ?? 0)),
      })
    : t("dossierPage.no_power");
  const hrZoneText = hzones
    ? t("dossierPage.zones_line", {
        low: fmtPct((hzones.Z1 ?? 0) + (hzones.Z2 ?? 0)),
        mid: fmtPct((hzones.Z3 ?? 0) + (hzones.Z4 ?? 0)),
        high: fmtPct(hzones.Z5 ?? 0),
      })
    : "—";
  const cadTotal =
    (cad.style_counts?.low ?? 0) +
    (cad.style_counts?.normal ?? 0) +
    (cad.style_counts?.high ?? 0);
  const cadPct = (x) => (cadTotal ? `${Math.round((x / cadTotal) * 1000) / 10}%` : "0%");

  app.innerHTML = `
    <div class="view-title">
      <h1>${esc(t("dossierPage.title"))}</h1>
      <span class="sub">${esc(t("dossierPage.sub", { date: dossier.anchor_date ?? "—" }))}</span>
    </div>
    <div class="callout info">${esc(t("dossierPage.baseline", {
      considered: c.considered ?? 0,
      with_power: c.with_power ?? 0,
      flagged: c.flagged_excluded ?? 0,
    }))}</div>
    <div class="panel">
      <div class="panel-title">${esc(t("dossierPage.peak"))}</div>
      <div class="metric-grid" style="margin-bottom:0">
        ${metric(t("dossierPage.all_time"), peaksText(dossier.peak_power?.all_time))}
        ${metric(t("dossierPage.recent"), peaksText(dossier.peak_power?.last_90d))}
        ${metric(t("dossierPage.ftp"), fmtNum(dossier.ftp_watts), "W")}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("dossierPage.profile"))}</div>
      <div class="metric-grid" style="margin-bottom:0">
        ${metric(t("dossierPage.climb"), fmtNum(cp.climbs_analyzed), t("dossierPage.climb_sub", {
          g: fmtNum(cp.median_grade_pct),
          p: fmtNum(cp.median_pct_ftp),
          h: fmtNum(cp.median_avg_hr),
        }))}
        ${metric(t("dossierPage.cadence"), fmtNum(cad.rides_analyzed), t("dossierPage.cadence_sub", {
          low: cadPct(cad.style_counts?.low ?? 0),
          normal: cadPct(cad.style_counts?.normal ?? 0),
          high: cadPct(cad.style_counts?.high ?? 0),
        }))}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("dossierPage.structure"))}</div>
      <p class="muted" style="font-size:13px">${esc(t("dossierPage.power_zones"))}${esc(zoneText)}</p>
      <p class="muted" style="font-size:13px">${esc(t("dossierPage.hr_zones"))}${esc(hrZoneText)}</p>
      <p class="muted" style="font-size:13px">${esc(t("dossierPage.types"))}${esc(
        (dossier.intensity_structure?.intensity_types ?? [])
          .map((m) => `${m.month} ${m.type}`)
          .join(t("dossierPage.joiner")) || "—",
      )}</p>
    </div>
    <div class="panel">
      <div class="panel-title">${esc(t("dossierPage.load"))}</div>
      <div class="metric-grid" style="margin-bottom:0">
        ${metric(t("dossierPage.weeks"), `${weeks.length} / 8`, t("dossierPage.weeks_sub", {
          avg: weeks.length ? Math.round(totalTss / weeks.length) : 0,
          peak: weeks.length ? Math.max(...weeks.map((w) => w.tss)) : 0,
          hours: Math.round((totalHours / Math.max(weeks.length, 1)) * 10) / 10,
        }))}
        ${metric(t("dossierPage.drift"), fmtPct(drift.median_pct), t("dossierPage.drift_sub", { n: drift.rides ?? 0 }))}
        ${metric(t("dossierPage.flagged"), fmtNum(c.total_flagged), t("dossierPage.flagged_sub"))}
      </div>
    </div>`;
}
