import type { AppState, DecodedFrame } from "../api.js";
import { dataHex } from "../api.js";
import { escapeHtml, fmtTime } from "../main.js";
import { signalColor } from "./timeline.js";

export function renderBits(state: AppState, frame: DecodedFrame | null): string {
  if (!frame) {
    return `<div class="panel">请先在 <span class="tag">帧时间轴</span> 中选择一帧。</div>`;
  }
  const fr = frame.view.frame;
  const hex = dataHex(fr);
  const dataBytes = hex.match(/.{2}/g) ?? [];

  const cells: string[] = [];
  const claims = new Map<string, { name: string; unknown: boolean }>();
  for (const sig of frame.decode.signals) {
    for (const c of sig.bitSpan.cells) {
      claims.set(`${c.byte}:${c.bit}`, { name: sig.signalName, unknown: sig.unknownMux });
    }
  }
  for (let byte = 0; byte < 8; byte++) {
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      const claim = claims.get(`${byte}:${bit}`);
      const rawByte = parseInt(dataBytes[byte] ?? "00", 16);
      const bitVal = (rawByte >> bit) & 1;
      if (claim) {
        cells.push(
          `<div class="cell" style="border-color:${signalColor(claim.name)}">
             <span class="sig" style="background:${signalColor(claim.name)}${claim.unknown ? "55" : ""}">${escapeHtml(claim.name)}${claim.unknown ? " (未知分支 raw)" : ""}</span>
             <div>${bitVal}</div>
             <div class="bitref">b${byte * 8 + bit} · DBC#${dbcIndex(byte, col)}</div>
           </div>`
        );
      } else {
        const unclaimed = frame.decode.unclaimedBits.includes(byte * 8 + bit);
        cells.push(
          `<div class="cell ${unclaimed ? "unclaimed" : ""}">
             <span class="muted small">${unclaimed ? "未解释" : ""}</span>
             <div>${byte < dataBytes.length ? bitVal : ""}</div>
             <div class="bitref">b${byte * 8 + bit} · DBC#${dbcIndex(byte, col)}</div>
           </div>`
        );
      }
    }
  }

  const muxInfo = Object.entries(frame.decode.muxBranches)
    .map(([k, v]) => `<span class="pill">${escapeHtml(k)}=${v}</span>`)
    .join(" ");

  const sigRows = frame.message
    ? frame.message.signals.map((s) => {
        const decoded = frame.decode.signals.find((d) => d.signalName === s.name);
        const enumText = s.enums
          ? Object.entries(s.enums)
              .map(([k, v]) => `${k}=${v}`)
              .join("，")
          : "-";
        return `<tr>
          <td><span class="sig-dot" style="color:${signalColor(s.name)}">●</span> ${escapeHtml(s.name)}</td>
          <td>${s.byteOrder === "intel" ? "Intel（小端）" : "Motorola（大端）"}</td>
          <td class="mono">${s.signed ? "有符号" : "无符号"}</td>
          <td class="mono">${s.startBit}|${s.length}</td>
          <td class="mono">${s.scale}${s.offset ? ` ${s.offset >= 0 ? "+" : ""}${s.offset}` : ""}</td>
          <td>${s.unit ? escapeHtml(s.unit) : "-"}</td>
          <td>${muxKindText(s.muxKind, s.muxValue)}</td>
          <td>${escapeHtml(enumText)}</td>
          <td class="mono">${decoded && !decoded.unknownMux ? decoded.rawValue : '<span class="muted">raw 保留</span>'}</td>
          <td class="mono"><strong>${decoded && !decoded.unknownMux ? formatVal(decoded.value, decoded.enumLabel) : '<span class="unk">raw bits</span>'}</strong></td>
          <td class="bitref">${decoded ? decoded.bitSpan.cells.map((c) => `b${c.byte * 8 + c.bit}`).join(",") : ""}</td>
        </tr>`;
      })
    : [];

  return `
  <div class="panel">
    <h2>Bit 布局 — 帧 #${fr.id}
      <span class="muted small mono">0x${fr.arbitrationId.toString(16).toUpperCase()}${fr.extended ? " (扩展)" : " (标准)"} · ${escapeHtml(fmtTime(fr.hwTimeNs))}</span>
      ${frame.stale ? '<span class="pill stale">过期解码</span>' : ""}
    </h2>
    <div class="muted small">每行 1 字节（左=MSB/bit7，右=LSB/bit0），格子标注 Intel bit 号与 DBC bit 号。命中消息：<strong>${frame.message ? escapeHtml(frame.message.name) : "无"}</strong>；mux 分支：${muxInfo || "无"}</div>
    <div class="legend">
      ${[...new Set(frame.decode.signals.map((s) => s.signalName))]
        .map((n) => `<span><i class="sw" style="background:${signalColor(n)}"></i>${escapeHtml(n)}</span>`)
        .join("")}
      <span><i class="sw" style="background:#2a3550"></i>未解释 bit</span>
    </div>
    <div class="grid8">${cells.join("")}</div>
  </div>
  <div class="panel">
    <h2>信号定义与解码值（可追到确切 bit 区间）</h2>
    <div class="scroll">
    <table>
      <thead><tr><th>信号</th><th>字节序</th><th>符号</th><th>起始|长度</th><th>缩放/偏置</th><th>单位</th><th>多路复用</th><th>枚举</th><th>raw</th><th>解码值</th><th>bit 区间</th></tr></thead>
      <tbody>${sigRows.join("")}</tbody>
    </table>
    </div>
  </div>`;
}

function dbcIndex(byte: number, col: number): number {
  // 网格 col 是 MSB->LSB；DBC 编号=byte*8+col
  return byte * 8 + col;
}

function muxKindText(kind: string, value: number | null): string {
  if (kind === "switch") return "多路开关 M";
  if (kind === "value") return `分支 m${value ?? "?"}`;
  return "普通";
}

function formatVal(value: number | string | null, label: string | null): string {
  if (label) return escapeHtml(label);
  if (value === null) return "-";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3);
  return escapeHtml(String(value));
}
