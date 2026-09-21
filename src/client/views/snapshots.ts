import type { AppState } from "../api.js";
import { escapeHtml } from "../main.js";

export function renderSnapshots(state: AppState): string {
  const options = state.versions.map((v) => `<option value="${v.id}">v${v.versionNumber} · ${escapeHtml(v.name)}</option>`).join("");
  const rows = state.snapshots
    .map((s) => {
      const payload = JSON.parse(s.payloadJson) as Array<{
        frame: { id: number; arbitrationId: number; extended: boolean; hwTimeNs: string };
        versionId: number;
        messageName: string | null;
      }>;
      const pinned = state.versions.find((v) => v.id === s.pinnedDbcVersionId);
      return `<div class="panel">
        <h2>${escapeHtml(s.label)}
          <span class="muted small">${escapeHtml(s.createdAt)} · 冻结于 ${pinned ? `v${pinned.versionNumber} ${escapeHtml(pinned.name)}` : "未知版本"} · ${payload.length} 帧</span>
        </h2>
        <details><summary>查看冻结内容（继续指向旧定义，不随后续修订变化）</summary>
        <table><thead><tr><th>帧</th><th>ID</th><th>消息</th><th>DBC</th></tr></thead><tbody>
        ${payload
          .map(
            (p) =>
              `<tr><td class="mono">#${p.frame.id}</td><td class="mono">0x${p.frame.arbitrationId.toString(16).toUpperCase()}${p.frame.extended ? "x" : ""}</td><td>${p.messageName ?? "-"}</td><td>v${state.versions.find((v) => v.id === p.versionId)?.versionNumber ?? p.versionId}</td></tr>`
          )
          .join("")}
        </tbody></table></details>
      </div>`;
    })
    .join("");

  return `
  <div class="panel">
    <h2>冻结调查快照</h2>
    <div class="flexrow">
      <input id="snapshotLabel" placeholder="快照标签，例如：故障复盘 #12" />
      <select id="snapshotVersion">${options}</select>
      <button id="doSnapshot" class="primary">创建快照（当前全部帧）</button>
    </div>
    <div class="muted small">快照写入时的 DBC 版本与解码结果；之后修订 DBC 生效区间，快照内容仍指向旧定义。</div>
  </div>
  ${rows || '<div class="panel">尚无快照。</div>'}`;
}
