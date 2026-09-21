import type { AppState, MappingView } from "../api.js";
import { api } from "../api.js";
import { escapeHtml } from "../main.js";

interface ChangeRow {
  key: string;
  fromMessageName: string;
  toMessageName: string | null;
  presentInFrom: boolean;
  presentInTo: boolean;
  compatible: boolean;
  changes: Array<{ fromSignal: string | null; toSignal: string | null; kind: string; fields: string[] }>;
}

export function renderCompare(state: AppState): string {
  const opts = state.versions.map((v) => `<option value="${v.id}">v${v.versionNumber} · ${escapeHtml(v.name)}</option>`).join("");
  const first = state.versions[0]?.id;
  const second = state.versions[1]?.id ?? first;
  return `
  <div class="panel">
    <h2>比较两个 DBC 版本对同一批帧的影响</h2>
    <div class="flexrow">
      旧版 <select id="cmpFrom">${opts}</select>
      新版 <select id="cmpTo">${opts}</select>
      <button id="cmpRun" class="primary">比较</button>
      <button id="cmpPropose">生成迁移映射</button>
    </div>
    <div id="cmpResult" class="muted small">选择版本后点“比较”。</div>
  </div>
  <div class="panel">
    <h2>迁移映射审批 <span class="muted small">并发审批基于版本号（乐观锁）冲突</span></h2>
    <div id="mappingList">${renderMappingTable(state.mappings)}</div>
  </div>
`;
}

function renderMappingTable(mappings: MappingView[]): string {
  if (mappings.length === 0) return '<div class="muted">尚无映射，先比较并生成。</div>';
  return `<table><thead><tr><th>消息键</th><th>旧消息</th><th>新消息</th><th>信号映射</th><th>状态</th><th>版本号</th><th>操作</th></tr></thead><tbody>
  ${mappings
    .map((m) => {
      const sigs = JSON.parse(m.signalMappings) as Record<string, { toSignal: string | null; kind: string }>;
      const sigText = Object.entries(sigs)
        .map(([from, v]) => {
          const cls = v.kind === "removed" ? "bad" : v.kind === "modified" ? "warn" : v.kind === "added" ? "tag" : "muted";
          return `<span class="${cls}">${escapeHtml(from)}→${v.toSignal ? escapeHtml(v.toSignal) : "✕"}(${v.kind})</span>`;
        })
        .join("，");
      const pill =
        m.status === "approved"
          ? '<span class="pill ok">已批准</span>'
          : m.status === "incompatible"
            ? '<span class="pill fail">不兼容</span>'
            : '<span class="pill unchecked">待审批</span>';
      return `<tr>
        <td class="mono small">${escapeHtml(m.messageDefKey)}</td>
        <td>${escapeHtml(m.fromMessageName)}</td>
        <td>${m.toMessageName ? escapeHtml(m.toMessageName) : '<span class="bad">（新版缺失）</span>'}</td>
        <td class="small">${sigText || '<span class="muted">无变化</span>'}</td>
        <td>${pill}</td>
        <td class="mono">#${m.lockVersion}</td>
        <td>
          <button data-approve="${m.id}" data-lock="${m.lockVersion}" data-decision="approved" ${m.status !== "proposed" ? "disabled" : ""}>批准</button>
          <button data-approve="${m.id}" data-lock="${m.lockVersion}" data-decision="incompatible" ${m.status !== "proposed" ? "disabled" : ""}>标记不兼容</button>
        </td>
      </tr>`;
    })
    .join("")}
  </tbody></table>`;
}

export function bindCompare(state: AppState): void {
  const from = document.querySelector<HTMLSelectElement>("#cmpFrom");
  const to = document.querySelector<HTMLSelectElement>("#cmpTo");
  if (from && state.versions[0]) from.value = String(state.versions[0].id);
  if (to && state.versions[1]) to.value = String(state.versions[1].id);

  document.querySelector<HTMLButtonElement>("#cmpRun")?.addEventListener("click", async () => {
    if (!from || !to) return;
    const rows = await api<ChangeRow[]>(`/api/compare?from=${from.value}&to=${to.value}`);
    const target = document.querySelector<HTMLElement>("#cmpResult")!;
    target.innerHTML = renderCompareTable(rows);
  });

  document.querySelector<HTMLButtonElement>("#cmpPropose")?.addEventListener("click", async () => {
    if (!from || !to) return;
    await api("/api/mappings/propose", {
      method: "POST",
      body: JSON.stringify({ from: Number(from.value), to: Number(to.value) })
    });
    location.reload();
  });
}

function renderCompareTable(rows: ChangeRow[]): string {
  return rows
    .map((r) => {
      const changeRows = r.changes
        .map((c) => {
          const cls =
            c.kind === "removed" ? "bad" : c.kind === "added" ? "tag" : c.kind === "modified" ? "warn" : "ok";
          return `<tr>
            <td>${c.fromSignal ? escapeHtml(c.fromSignal) : '<span class="muted">—</span>'}</td>
            <td>${c.toSignal ? escapeHtml(c.toSignal) : '<span class="muted">—</span>'}</td>
            <td class="${cls}">${c.kind}</td>
            <td>${c.fields.map(escapeHtml).join("、")}</td>
          </tr>`;
        })
        .join("");
      return `<div class="panel">
        <h2>${escapeHtml(r.fromMessageName)} → ${r.toMessageName ? escapeHtml(r.toMessageName) : '<span class="bad">缺失</span>'}
          <span class="mono small muted">${escapeHtml(r.key)}</span>
          ${r.compatible ? '<span class="pill ok">兼容</span>' : '<span class="pill fail">破坏性</span>'}
        </h2>
        <table><thead><tr><th>旧信号</th><th>新信号</th><th>变更</th><th>字段</th></tr></thead><tbody>${changeRows}</tbody></table>
      </div>`;
    })
    .join("");
}
