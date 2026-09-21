// 总线刻度 — 信号曲线（画布）与 bit 布局（DOM 网格）
import { h, type Child } from './dom.js';
import type { BitCell, DecodedSignal, SignalPoint } from '../shared/types.js';

const SIG_COLORS = [
  '#2563eb', '#d97706', '#059669', '#dc2626', '#7c3aed',
  '#0891b2', '#be185d', '#65a30d', '#b45309', '#475569'
];
export function signalColor(i: number): string {
  return SIG_COLORS[i % SIG_COLORS.length];
}

/** 信号曲线：横轴硬件时间，纵轴物理值；mux 未知分支画空心点（保留 raw bits） */
export function lineChart(points: SignalPoint[], unit: string): HTMLElement {
  const canvas = document.createElement('canvas');
  canvas.width = 760;
  canvas.height = 220;
  canvas.className = 'chart';
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (points.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.fillText('暂无可绘制的点', 20, 30);
    return canvas;
  }

  const margin = { l: 56, r: 16, t: 18, b: 34 };
  const ts = points.map((p) => p.hwTimeNs);
  const vals = points.filter((p) => p.phys !== null).map((p) => p.phys as number);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const vMin = vals.length ? Math.min(...vals) : 0;
  const vMax = vals.length ? Math.max(...vals) : 1;
  const x = (t: number) =>
    margin.l + ((t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - margin.l - margin.r));
  const y = (v: number) => {
    const span = vMax - vMin || 1;
    return H - margin.b - ((v - vMin) / span) * (H - margin.t - margin.b);
  };

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#64748b';
  ctx.font = '11px sans-serif';
  ctx.beginPath();
  ctx.moveTo(margin.l, margin.t);
  ctx.lineTo(margin.l, H - margin.b);
  ctx.lineTo(W - margin.r, H - margin.b);
  ctx.stroke();
  for (let g = 0; g <= 4; g++) {
    const v = vMin + ((vMax - vMin || 1) * g) / 4;
    const yy = y(v);
    ctx.fillText(v.toFixed(2), 6, yy + 3);
    ctx.strokeStyle = '#f1f5f9';
    ctx.beginPath();
    ctx.moveTo(margin.l, yy);
    ctx.lineTo(W - margin.r, yy);
    ctx.stroke();
  }
  ctx.fillText(`单位 ${unit}`, 8, 12);
  ctx.fillText(`${((t1 - t0) / 1e6).toFixed(3)} ms`, W - 96, H - 10);

  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let pen = false;
  for (const p of points) {
    if (p.phys === null) {
      pen = false;
      continue;
    }
    const px = x(p.hwTimeNs);
    const py = y(p.phys);
    if (!pen) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
    pen = true;
  }
  ctx.stroke();

  for (const p of points) {
    const px = x(p.hwTimeNs);
    if (p.phys === null || p.muxSkipped) {
      ctx.strokeStyle = '#f59e0b';
      ctx.beginPath();
      ctx.arc(px, H - margin.b - 6, 4, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#2563eb';
      ctx.beginPath();
      ctx.arc(px, y(p.phys), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return h('div', { class: 'chart-wrap' }, canvas as unknown as Node);
}

/** bit 布局：8 字节 × 8 位（DBC 位编号从右上到左下），信号按色覆盖 */
export function bitGrid(signals: DecodedSignal[], dlc: number, selectedName?: string): HTMLElement {
  const colorOf = new Map<string, string>();
  signals.forEach((s, i) => colorOf.set(s.signalName, signalColor(i)));

  const rows: Child[] = [];
  for (let byte = 0; byte < 8; byte++) {
    const bits: Child[] = [];
    for (let bitInByte = 0; bitInByte < 8; bitInByte++) {
      const phys = byte * 8 + (7 - bitInByte);
      const owner = signals.find((s) => s.bitCells.some((c) => c.byteIndex === byte && c.bitInByte === bitInByte));
      const inDlc = byte < dlc;
      const cell = h(
        'div',
        {
          class: [
            'bit',
            owner ? 'bit-own' : '',
            !inDlc ? 'bit-pad' : '',
            owner && owner.signalName === selectedName ? 'bit-sel' : ''
          ].filter(Boolean).join(' '),
          style: owner ? `background:${colorOf.get(owner.signalName)}22;border-color:${colorOf.get(owner.signalName)}` : '',
          title: owner
            ? `${owner.signalName} · 物理位 ${phys} · ${owner.muxSkipped ? '未知分支，保留 raw bits' : `raw=${owner.rawValue ?? '-'}`}`
            : `物理位 ${phys}${inDlc ? '' : '（DLC 填充）'}`
        },
        String(phys)
      );
      bits.push(cell);
    }
    rows.push(
      h('div', { class: 'bit-row' },
        h('span', { class: 'byte-label' }, `B${byte}`),
        h('div', { class: 'bits' }, ...bits)
      )
    );
  }
  return h('div', { class: 'bit-grid' }, ...rows);
}

/** 单条信号的 bit 证据链：每位 -> 权重 -> raw -> 物理值 */
export function bitEvidence(sig: DecodedSignal, dataB64: string): HTMLElement {
  const bytes = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
  const spans = sig.bitCells.map((cell: BitCell) => {
    const bit = cell.byteIndex < bytes.length ? (bytes[cell.byteIndex] >> (7 - cell.bitInByte)) & 1 : null;
    return h(
      'span',
      {
        class: 'ev-bit',
        title: `权重位次 ${cell.weightIndex}（0=MSB） · B${cell.byteIndex} 的第 ${cell.bitInByte} 位（MSB 起）`
      },
      bit === null ? 'x' : String(bit)
    );
  });
  return h('div', { class: 'evidence' },
    h('div', { class: 'ev-bits' }, ...spans),
    h('div', { class: 'ev-meta' },
      `位区间 B${Math.min(...sig.bitCells.map((c) => c.byteIndex))}..B${Math.max(...sig.bitCells.map((c) => c.byteIndex))}`,
      ' · ',
      `start=${sig.startBit} len=${sig.length}`,
      ' · ',
      sig.byteOrder === 0 ? 'Motorola(大端)' : 'Intel(小端)',
      sig.signed ? ' · 有符号' : '',
      ' · ',
      `× ${sig.factor} + ${sig.offset} ${sig.unit}`
    )
  );
}
