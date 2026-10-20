/**
 * views/memory.js — AI 记忆页（v2：短期/长期分区；含已取代/已失效标记，只删不编辑）
 */

import {
  $, app, esc, api, confirmModal,
} from "../common.js";
import { t, memCategoryLabel, memSourceLabel } from "../i18n.js";

function rowHtml(m) {
  let status;
  if (!m.active) {
    status = `<span class="status-badge failed" title="${esc(t("memPage.superseded_title", { n: m.superseded_by }))}">${esc(t("memPage.superseded"))}</span>`;
  } else if (m.expired) {
    status = `<span class="status-badge failed" title="${esc(t("memPage.expired_title"))}">${esc(t("memPage.expired"))}</span>`;
  } else {
    status = `<span class="status-badge completed">${esc(t("memPage.active"))}</span>`;
  }
  return `<tr class="${m.expired ? "mem-expired" : ""}">
    <td class="mono" style="white-space:nowrap">${esc(String(m.created_at ?? "").slice(0, 10))}</td>
    <td>${esc(memCategoryLabel(m.category))}</td>
    <td>${esc(memSourceLabel(m.source))}</td>
    <td>${esc(m.content)}</td>
    <td>${status}</td>
    <td><button class="btn icon mem-del" data-id="${m.id}" title="${esc(t("memPage.del_title"))}">×</button></td>
  </tr>`;
}

function tableHtml(memories) {
  return `<div class="table-wrap"><table class="data-table">
    <tr><th>${esc(t("memPage.col.date"))}</th><th>${esc(t("memPage.col.cat"))}</th><th>${esc(t("memPage.col.source"))}</th><th>${esc(t("memPage.col.content"))}</th><th>${esc(t("memPage.col.status"))}</th><th></th></tr>
    ${memories.map(rowHtml).join("")}
  </table></div>`;
}

export async function renderMemory() {
  app.innerHTML = `<div class="view-title"><h1>${esc(t("memPage.title"))}</h1><span class="sub">${esc(t("memPage.sub"))}</span></div>
    <p class="muted" style="margin-bottom:12px;font-size:12px">
      ${esc(t("memPage.desc"))}
    </p>
    <div id="memList"><div class="empty loading">${esc(t("common.loading"))}</div></div>`;
  const memList = $("#memList");
  const render = async () => {
    const { memories } = await api("/api/ai/memories");
    if (!memories.length) {
      memList.innerHTML = `<div class="empty">${esc(t("memPage.empty"))}</div>`;
      return;
    }
    const shortMem = memories.filter((m) => m.scope === "short");
    const longMem = memories.filter((m) => m.scope !== "short");
    memList.innerHTML = `
      ${shortMem.length ? `<div class="panel"><div class="panel-title">${esc(t("memPage.short"))}</div>${tableHtml(shortMem)}</div>` : ""}
      <div class="panel"><div class="panel-title">${esc(t("memPage.long"))}</div>${tableHtml(longMem)}</div>`;
    memList.querySelectorAll(".mem-del").forEach((btn) =>
      btn.addEventListener("click", () => {
        confirmModal(t("memPage.delete.title"), t("memPage.delete.text"), async () => {
          await api(`/api/ai/memory?id=${btn.dataset.id}`, { method: "DELETE" });
          render();
        });
      }),
    );
  };
  render().catch(() => {
    memList.innerHTML = `<div class="callout">${esc(t("memPage.failed"))}</div>`;
  });
}
