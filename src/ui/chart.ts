import { el } from './dom.js';
import type { SignalSeriesPoint } from '../types.js';

export function lineChart(points: SignalSeriesPoint[], unit: string): Element {
  const w = 760;
  const h = 180;
  const pad = { l: 48, r: 12, t: 14, b: 24 };
  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${w} ${h}`, width: '100%' });

  if (points.length === 0) {
    svg.append(el('text', { x: w / 2, y: h / 2, 'text-anchor': 'middle' }, '无样本'));
    return svg;
  }

  const t0 = points[0].hwTime;
  const t1 = points[points.length - 1].hwTime || t0 + 1;
  const vals = points.filter((p) => p.physical !== null).map((p) => p.physical as number);
  const minV = vals.length ? Math.min(...vals) : 0;
  const maxV = vals.length ? Math.max(...vals) : 1;
  const spanV = maxV - minV || 1;

  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - minV) / spanV) * (h - pad.t - pad.b);

  for (let i = 0; i <= 4; i++) {
    const gv = minV + (spanV * i) / 4;
    const gy = y(gv);
    svg.append(el('line', { x1: pad.l, x2: w - pad.r, y1: gy, y2: gy, class: 'axis', opacity: 0.35 }));
    svg.append(el('text', { x: pad.l - 6, y: gy + 3, 'text-anchor': 'end' }, gv.toFixed(2)));
  }
  for (let i = 0; i <= 5; i++) {
    const t = t0 + ((t1 - t0) * i) / 5;
    const gx = x(t);
    svg.append(el('text', { x: gx, y: h - 6, 'text-anchor': 'middle' }, `${t.toFixed(2)}s`));
  }

  let path = '';
  points.forEach((p, i) => {
    if (p.physical === null) return;
    path += `${i === 0 || points[i - 1].physical === null ? 'M' : 'L'}${x(p.hwTime).toFixed(1)},${y(p.physical).toFixed(1)} `;
  });
  svg.append(el('path', { d: path.trim(), class: 'line' }));

  for (const p of points) {
    if (p.physical === null) continue;
    svg.append(
      el('circle', {
        class: `pt ${p.active ? '' : 'inactive'}`,
        cx: x(p.hwTime),
        cy: y(p.physical),
        r: 3,
        title: `${p.hwTime.toFixed(6)}s  raw=${p.raw ?? '—'}  val=${p.physical}${unit ? ' ' + unit : ''}${p.enumLabel ? ' (' + p.enumLabel + ')' : ''}`
      })
    );
  }
  return svg;
}
