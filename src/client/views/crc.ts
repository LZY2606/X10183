import type { AppState } from "../api.js";
import { escapeHtml, fmtTime } from "../main.js";

export function renderCrc(state: AppState): string {
  const rules = state.crcRules as Array<{
    id: number; arbitrationId: number; extended: boolean; signalName: string; widthBits: number;
    startByte: number | null; lengthBytes: number | null;
    polynomial: number | null; init: number | null; xorOut: number | null;
  }>;
  const ruleRows = rules
    .map(
      (r) => `<tr>
        <td class="mono">0x${r.arbitrationId.toString(16).toUpperCase()}${r.extended ? "x" : ""}</td>
        <td>${escapeHtml(r.signalName)}</td>
        <td>${r.widthBits}</td>
        <td>${r.startByte ?? '<span class="warn">?</span>'}..+${r.lengthBytes ?? '<span class="warn">?</span>'}</td>
        <td>${r.polynomial === null ? '<span class="warn">未配置</span>' : "0x" + r.polynomial.toString(16)}</td>
        <td>${r.init === null ? '<span class="warn">未配置</span>' : "0x" + r.init.toString(16).padStart(2, "0")}</td>
        <td>${r.xorOut === null ? '<span class="warn">未配置</span>' : "0x" + r.xorOut.toString(16).padStart(2, "0")}</td>
      </tr>`
    )
    .join("");

  const counts = state.crc.reduce(
    (acc, e) => {
      acc[e.verdict] = (acc[e.verdict] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const rows = state.crc
    .map((e) => {
      const pill =
        e.verdict === "pass"
          ? '<span class="pill ok">通过</span>'
          : e.verdict === "fail"
            ? '<span class="pill fail">失败</span>'
            : '<span class="pill unchecked">未核验</span>';
      return `<tr>
        <td class="mono">${escapeHtml(fmtTime(e.hwTimeNs))}</td>
        <td class="mono">#${e.frameId}</td>
        <td class="mono">0x${e.rule.arbitrationId.toString(16).toUpperCase()}${e.rule.extended ? "x" : ""}</td>
        <td>${escapeHtml(e.rule.signalName)}</td>
        <td>${pill}</td>
        <td class="mono">${e.expected === null ? "-" : "0x" + e.expected.toString(16).padStart(2, "0")}</td>
        <td class="mono">${e.actual === null ? "-" : "0x" + e.actual.toString(16).padStart(2, "0")}</td>
        <td>${e.coveredBytes ? "字节 " + e.coveredBytes.join(",") : "-"}</td>
        <td class="muted">${escapeHtml(e.reason)}</td>
      </tr>`;
    })
    .join("");

  return `
  <div class="panel">
    <h2>CRC 规则（覆盖范围 / 初值 / 异或值可配；不完整只能“未核验”）</h2>
    <table><thead><tr><th>消息</th><th>信号</th><th>位宽</th><th>覆盖字节</th><th>多项式</th><th>初值</th><th>异或</th></tr></thead>
    <tbody>${ruleRows || '<tr><td colspan="7" class="muted">无规则</td></tr>'}</tbody></table>
    <div class="muted small" style="margin-top:6px">
      汇总：<span class="ok">通过 ${counts.pass ?? 0}</span> ·
      <span class="bad">失败 ${counts.fail ?? 0}</span> ·
      <span class="warn">未核验 ${counts.unchecked ?? 0}</span>
    </div>
  </div>
  <div class="panel">
    <h2>逐帧 CRC 证据</h2>
    <div class="scroll"><table>
      <thead><tr><th>时间</th><th>帧</th><th>消息</th><th>信号</th><th>结论</th><th>期望</th><th>实际</th><th>覆盖字节</th><th>理由</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="muted">无证据</td></tr>'}</tbody>
    </table></div>
  </div>`;
}
