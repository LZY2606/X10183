import type { AppState } from "../api.js";
import { escapeHtml, fmtTime } from "../main.js";

const TYPE_LABEL: Record<string, string> = {
  ok: "正常",
  wrap: "环绕",
  duplicate: "重复计数",
  gap: "缺帧",
  jump: "异常跳变",
  "missing-signal": "信号缺失",
  "duplicate-timestamp": "重复时间戳"
};

export function renderCounters(state: AppState): string {
  const reports = state.counters;
  const rules = state.counterRules as Array<{
    id: number; arbitrationId: number; extended: boolean; signalName: string;
    bits: number; increment: number; nodeName: string;
  }>;
  const rulesHtml = rules
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.nodeName)}</td><td class="mono">0x${r.arbitrationId.toString(16).toUpperCase()}${r.extended ? "x" : ""}</td><td>${escapeHtml(r.signalName)}</td><td>${r.bits} bit（模 ${2 ** r.bits}）</td><td>+${r.increment}</td></tr>`
    )
    .join("");

  const groups = reports
    .map((rep) => {
      const verdictPill =
        rep.verdict === "pass"
          ? '<span class="pill ok">通过</span>'
          : rep.verdict === "fail"
            ? '<span class="pill fail">失败</span>'
            : '<span class="pill unchecked">未核验</span>';
      const rows = rep.events.length
        ? rep.events
            .map(
              (e) => `<tr>
                <td><span class="pill ${eventClass(e.type)}">${TYPE_LABEL[e.type] ?? e.type}</span></td>
                <td class="mono">${escapeHtml(fmtTime(e.hwTimeNs))}</td>
                <td class="mono">#${e.frameId}</td>
                <td>${e.expected ?? "-"}</td>
                <td>${e.actual ?? "-"}</td>
                <td>${escapeHtml(e.detail)}</td>
              </tr>`
            )
            .join("")
        : `<tr><td colspan="5" class="muted">未发现异常（正常递增；环绕单独标注，不算失败）。</td></tr>`;
      return `<div class="panel">
        <h2>${escapeHtml(rep.nodeName)} · 代次 ${escapeHtml(rep.generation)} ${verdictPill}
          <span class="muted small">${rep.events.length} 个事件</span></h2>
        <div class="scroll"><table>
          <thead><tr><th>类型</th><th>时间</th><th>帧</th><th>期望</th><th>实际</th><th>说明</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
    })
    .join("");

  return `
  <div class="panel">
    <h2>计数器规则（按节点 + 采集代次）</h2>
    <table><thead><tr><th>节点</th><th>消息</th><th>信号</th><th>位宽</th><th>增量</th></tr></thead>
    <tbody>${rulesHtml || '<tr><td colspan="5" class="muted">无规则</td></tr>'}</tbody></table>
  </div>
  ${groups || '<div class="panel">没有可检查的计数器。</div>'}`;
}

function eventClass(type: string): string {
  if (type === "wrap" || type === "duplicate-timestamp") return "unchecked";
  if (type === "ok") return "ok";
  return "fail";
}
