import type { AppState } from "../api.js";

export function renderCurves(state: AppState): string {
  // 收集所有数值信号序列
  const seriesMap = new Map<string, { points: Array<{ t: bigint; v: number; frameId: number; gen: string }>; unit: string | null }>();
  for (const f of state.frames) {
    for (const s of f.decode.signals) {
      if (s.unknownMux) continue;
      const v = typeof s.value === "number" ? s.value : null;
      if (v === null) continue;
      const sigDef = f.message?.signals.find((d) => d.name === s.signalName);
      const key = `${f.message?.name ?? "?"}.${s.signalName}`;
      const entry = seriesMap.get(key) ?? { points: [], unit: sigDef?.unit ?? null };
      entry.points.push({ t: BigInt(f.view.frame.hwTimeNs), v, frameId: f.view.frame.id, gen: f.view.generation });
      seriesMap.set(key, entry);
    }
  }
  const keys = [...seriesMap.keys()].sort();
  const charts = keys
    .map((key, idx) => {
      const series = seriesMap.get(key)!;
      return `<div class="panel"><h2>${key} <span class="muted">${series.unit ? "(" + series.unit + ")" : ""} · ${series.points.length} 点</span></h2>
        <canvas id="curve-${idx}" width="900" height="180" data-series="${idx}"></canvas></div>`;
    })
    .join("");

  const drawSoon = (): void => {
    keys.forEach((key, idx) => drawChart(`curve-${idx}`, seriesMap.get(key)!.points));
  };
  setTimeout(drawSoon, 0);

  return charts || `<div class="panel">暂无数值信号。</div>`;
}

function drawChart(canvasId: string, points: Array<{ t: bigint; v: number }>): void {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas || points.length === 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = t1 - t0 || 1n;
  const vals = points.map((p) => p.v);
  const vmin = Math.min(...vals);
  const vmax = Math.max(...vals);
  const vspan = vmax - vmin || 1;
  const pad = 34;

  ctx.strokeStyle = "#2a3550";
  ctx.beginPath();
  ctx.moveTo(pad, 10);
  ctx.lineTo(pad, h - 24);
  ctx.lineTo(w - 10, h - 24);
  ctx.stroke();

  ctx.fillStyle = "#8b97b0";
  ctx.font = "10px monospace";
  ctx.fillText(vmax.toFixed(1), 2, 14);
  ctx.fillText(vmin.toFixed(1), 2, h - 26);

  ctx.strokeStyle = "#4f9cff";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad + Number(((p.t - t0) * BigInt(Math.floor((w - pad - 10) * 1000))) / span) / 1000;
    const y = 10 + ((vmax - p.v) / vspan) * (h - 34);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "#4f9cff";
  for (const p of points) {
    const x = pad + Number(((p.t - t0) * BigInt(Math.floor((w - pad - 10) * 1000))) / span) / 1000;
    const y = 10 + ((vmax - p.v) / vspan) * (h - 34);
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}
