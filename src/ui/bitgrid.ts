import { el } from './dom.js';
import type { DecodedSignal } from '../types.js';

const PALETTE = ['#4aa8ff', '#3fb950', '#a371f7', '#d29922', '#39c5cf', '#db61a2', '#e3b341', '#56d364'];

export function signalColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// 每信号独立行，展示 8*DLC 网格（MSB 在左），可精确看到 bit 区间
export function bitGrid(signals: DecodedSignal[], dlc: number): HTMLElement {
  const total = dlc * 8;
  const wrap = el('div', { class: 'grid' });
  const activeSigs = signals;

  for (const sig of activeSigs) {
    const cells = el('div', { class: 'bitgrid', style: `grid-template-columns: repeat(${Math.min(16, Math.max(8, total))}, minmax(20px, 1fr))` });
    const owned = new Map<number, number>(); // cell -> MSB 位置
    sig.bitCells.forEach((cell, i) => owned.set(cell, i));
    const color = signalColor(sig.name);

    for (let cell = 0; cell < total; cell++) {
      const pos = owned.get(cell);
      const isOwned = pos !== undefined;
      const byteStart = cell % 8 === 0;
      const bitIndexInByte = 7 - (cell % 8);
      const cellEl = el(
        'div',
        {
          class: `bitcell ${byteStart ? 'byte-start' : ''}`,
          style: isOwned
            ? `background:${color}${sig.active ? '88' : '33'};color:#fff;border-color:${color};${pos === 0 ? 'border-left:2px solid #fff' : ''}`
            : '',
          title: isOwned
            ? `${sig.name} bit${sig.startBit} 起第 ${sig.length - pos} 位（绝对网格 ${cell}）`
            : `byte ${Math.floor(cell / 8)} bit ${bitIndexInByte}`
        },
        String(bitIndexInByte)
      );
      if (isOwned && pos === sig.length - 1) cellEl.append(el('span', { class: 'sig-name' }, sig.name.slice(0, 4)));
      cells.append(cellEl);
    }

    wrap.append(
      el(
        'div',
        { class: 'row', style: 'align-items:flex-start' },
        el(
          'div',
          { style: 'min-width:200px' },
          el('div', { class: 'mono', style: `color:${color}` }, sig.name),
          el(
            'div',
            { class: 'small muted' },
            `${sig.byteOrder === 'intel' ? 'Intel(小端)' : 'Motorola(大端)'} · start=${sig.startBit} · len=${sig.length} · ${sig.signed ? '有符号' : '无符号'} · ×${sig.scale}+${sig.offset} ${sig.unit}`
          ),
          !sig.active ? el('span', { class: `tag ${sig.reason === 'unknown-mux' ? 'warn' : 'unchecked'}` }, sig.reason === 'unknown-mux' ? '分支未知·保留raw' : '非活动分支') : null
        ),
        cells
      )
    );
  }
  return wrap;
}

export function bitLegend(signals: DecodedSignal[]): HTMLElement {
  return el(
    'div',
    { class: 'legend small' },
    ...signals.map((s) =>
      el('span', { class: 'mono' }, el('i', { style: `background:${signalColor(s.name)}` }), s.name)
    )
  );
}
