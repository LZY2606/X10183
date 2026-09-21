import type { AppState, DecodedFrame } from "../api.js";
import { dataHex } from "../api.js";
import { escapeHtml, fmtTime } from "../main.js";

const SIG_COLORS = ["#4f9cff", "#3ecf8e", "#f5a623", "#ff6b6b", "#b48cff", "#28c8e0", "#e06bd8", "#8bc34a"];

export function signalColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SIG_COLORS[h % SIG_COLORS.length];
}

export function renderTimeline(state: AppState, selected: DecodedFrame | null): string {
  const frames = state.frames;
  if (frames.length === 0) return `<div class="panel">暂无帧，请先导入 trace。</div>`;

  const times = frames.map((f) => BigInt(f.view.frame.hwTimeNs));
  const min = times.reduce((a, b) => (a < b ? a : b));
  const max = times.reduce((a, b) => (a > b ? a : b));
  const span = max - min || 1n;

  // 按 arb id 分泳道
  const lanes = new Map<string, { label: string; ext: boolean; items: DecodedFrame[] }>();
  for (const f of frames) {
    const key = `${f.view.frame.arbitrationId.toString(16).padStart(3, "0")}${f.view.frame.extended ? "x" : ""}`;
    const lane = lanes.get(key) ?? { label: `0x${key.toUpperCase()}`, ext: f.view.frame.extended, items: [] };
    lane.items.push(f);
    lanes.set(key, lane);
  }
  const laneList = [...lanes.values()].sort((a, b) => a.label.localeCompare(b.label));
  const laneH = 36;
  const height = Math.max(laneList.length * laneH + 10, 120);

  // DBC 生效区间色带
  const eras = state.versions
    .map((v) => {
      const from = v.effectiveFromNs === null ? null : BigInt(v.effectiveFromNs);
      const to = v.effectiveToNs === null ? null : BigInt(v.effectiveToNs);
      const x0 = from === null ? 0 : Number(((from - min) * 10000n) / span) / 100;
      const x1 = to === null ? 100 : Number(((to - min) * 10000n) / span) / 100;
      const left = Math.max(x0, 0);
      const width = Math.max(x1 - left, 0);
      return `<div class="era" style="left:${left}%;width:${Math.min(width, 100 - left)}%;background:${v.versionNumber % 2 ? "#4f9cff" : "#3ecf8e"}" title="${escapeHtml(v.name)}"></div>`;
    })
    .join("");

  const laneHtml = laneList
    .map((lane, i) => {
      const ticks = lane.items
        .map((f) => {
          const t = BigInt(f.view.frame.hwTimeNs);
          const x = Number(((t - min) * 10000n) / span) / 100;
          const stale = f.stale;
          const bg = stale ? "#f5a623" : lane.ext ? "#b48cff" : "#4f9cff";
          return `<div class="tick" data-frame-id="${f.view.frame.id}" style="left:${x}%;background:${bg};top:6px;height:22px" title="${escapeHtml(
            fmtTime(f.view.frame.hwTimeNs)
          )} ${f.message?.name ?? "无定义"}${stale ? "（过期解码）" : ""}"></div>`;
        })
        .join("");
      return `<div class="lane" style="top:${i * laneH}px;height:${laneH}px">
        <span class="lane-label">${lane.label}${lane.ext ? ' <span class="pill ext">扩展</span>' : ' <span class="pill">标准</span>'}</span>${ticks}</div>`;
    })
    .join("");

  const axis = [0, 25, 50, 75, 100]
    .map((p) => {
      const t = min + (span * BigInt(p)) / 100n;
      return `<span style="left:${p}%">${escapeHtml(fmtTime(t.toString()).slice(5, 19))}</span>`;
    })
    .join("");

  const table = renderFrameTable(frames, selected);

  return `
  <div class="panel">
    <h2>帧时间轴 <span class="muted small">色带为 DBC 生效区间；黄色刻度=当前所选版本下该帧解码已过期</span></h2>
    <div class="timeline-wrap" style="height:${height}px">${eras}${laneHtml}</div>
    <div class="axis">${axis}</div>
  </div>
  <div class="panel">
    <h2>帧明细（点击选择，再去 Bit 布局 / 信号曲线）</h2>
    <div class="scroll">${table}</div>
  </div>`;
}

function renderFrameTable(frames: AppState["frames"], selected: DecodedFrame | null): string {
  return `<table>
    <thead><tr><th>时间</th><th>通道</th><th>ID</th><th>类型</th><th>DLC</th><th>数据</th><th>代次</th><th>消息定义</th><th>DBC</th><th>状态</th></tr></thead>
    <tbody>
    ${frames
      .map((f) => {
        const fr = f.view.frame;
        return `<tr data-frame-id="${fr.id}" class="${selected?.view.frame.id === fr.id ? "selected" : ""}">
          <td class="mono">${escapeHtml(fmtTime(fr.hwTimeNs))}</td>
          <td>${escapeHtml(fr.channel ?? "-")}</td>
          <td class="mono">0x${fr.arbitrationId.toString(16).toUpperCase().padStart(fr.extended ? 8 : 3, "0")}</td>
          <td>${fr.extended ? '<span class="pill ext">扩展</span>' : '<span class="pill">标准</span>'}</td>
          <td>${dataHex(fr).length / 2}</td>
          <td class="mono">${dataHex(fr).match(/.{2}/g)?.join(" ")}</td>
          <td>${escapeHtml(f.view.generation)}</td>
          <td>${f.message ? escapeHtml(f.message.name) : '<span class="muted">无匹配定义</span>'}</td>
          <td>${f.version ? `v${f.version.versionNumber}` : "-"}</td>
          <td>${f.stale ? '<span class="pill stale">过期</span>' : '<span class="pill ok">当前</span>'}</td>
        </tr>`;
      })
      .join("")}
    </tbody></table>`;
}
