import { el } from './dom.js';
import { api } from '../api.js';
import { fmtId, fmtNum, fmtTime, toast } from './dom.js';
import { bitGrid } from './bitgrid.js';
import { lineChart } from './chart.js';
import type { DecodedFrame, DbcVersion, SignalSeriesPoint } from '../types.js';
import type { ViewContext } from './app.js';

export function explorerView(ctx: ViewContext): HTMLElement {
  const root = el('div', { class: 'grid' });
  root.append(el('div', { class: 'muted small' }, '按硬件时间重放；每个帧解析其采集时点生效的 DBC 定义。点击标记或行可查看 bit 级证据。'));

  const timelineCard = el('div', { class: 'card' }, el('h2', {}, '帧时间轴'));
  const detailCard = el('div', { class: 'card' }, el('h2', {}, '帧详情'));
  root.append(timelineCard, detailCard);

  void load();

  async function load(): Promise<void> {
    try {
      const frames = await api.get<DecodedFrame[]>('/api/timeline?limit=2000');
      timelineCard.append(buildTimeline(frames, ctx.state.dbcs, (id) => {
        ctx.selectFrame(id);
      }));
      const selected = ctx.state.selectedFrameId ?? frames[0]?.frame.id ?? null;
      renderDetail(detailCard, frames, selected);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return root;
}

const COLOR_BY_MSG = (d: DecodedFrame): string =>
  d.undecoded ? '#6e7681' : `hsl(${(d.messageDefId ?? 0) * 47 % 360} 60% 55%)`;

function buildTimeline(
  frames: DecodedFrame[],
  dbcs: DbcVersion[],
  onPick: (id: number) => void
): HTMLElement {
  const wrap = el('div', { class: 'timeline-wrap' });
  const tl = el('div', { class: 'timeline', style: 'min-width:900px' });

  const channels = [...new Set(frames.map((f) => f.frame.channel))].sort((a, b) => a - b);
  const t0 = frames[0]?.frame.hwTime ?? 0;
  const t1 = frames[frames.length - 1]?.frame.hwTime ?? 1;
  const span = t1 - t0 || 1;
  const xPos = (t: number) => 4 + ((t - t0) / span) * 96;

  // DBC 生效区间分界
  for (const v of dbcs) {
    const boundaries = [v.effectiveFrom, v.effectiveTo].filter((b): b is number => b !== null && b > t0 && b < t1);
    for (const b of boundaries) {
      tl.append(
        el(
          'div',
          { class: 'tl-version', style: `left:${xPos(b)}%` },
          el('span', {}, `${v.label} 边界 ${b}s`)
        )
      );
    }
  }

  for (const ch of channels) {
    const lane = el('div', { class: 'tl-lane' }, el('div', { class: 'tl-lane-label' }, `通道 ${ch}`));
    for (const d of frames.filter((f) => f.frame.channel === ch)) {
      lane.append(
        el('div', {
          class: `tl-mark ${d.frame.id === window.__selectedFrame ? 'selected' : ''}`,
          style: `left:${xPos(d.frame.hwTime)}%;background:${COLOR_BY_MSG(d)}`,
          title: `${fmtTime(d.frame.hwTime)}s ${fmtId(d.frame.arbId, d.frame.extended)} ${d.messageName ?? '未解码'}`,
          onclick: () => onPick(d.frame.id)
        })
      );
    }
    tl.append(lane);
  }

  const axis = el('div', { class: 'tl-axis' });
  for (let i = 0; i <= 6; i++) {
    const t = t0 + (span * i) / 6;
    axis.append(el('div', { class: 'tl-tick', style: `left:${(i / 6) * 100}%` }, `${t.toFixed(2)}s`));
  }
  tl.append(axis);
  wrap.append(tl);
  return wrap;
}

function renderDetail(card: HTMLElement, frames: DecodedFrame[], selectedId: number | null): void {
  card.replaceChildren(el('h2', {}, '帧详情'));
  const idx = frames.findIndex((f) => f.frame.id === selectedId);
  if (idx < 0) {
    card.append(el('div', { class: 'muted' }, '没有帧。请先到“导入”页载入 trace 或演示数据。'));
    return;
  }
  window.__selectedFrame = selectedId;
  const d = frames[idx];
  const f = d.frame;

  const header = el(
    'div',
    { class: 'pill-row' },
    el('span', { class: `tag ${f.extended ? 'ext' : 'std'}` }, f.extended ? '扩展帧 29bit' : '标准帧 11bit'),
    el('code', { class: 'kv mono' }, fmtId(f.arbId, f.extended)),
    el('span', { class: 'muted' }, `通道 ${f.channel}`),
    el('span', { class: 'muted mono' }, `${fmtTime(f.hwTime)} s`),
    el('span', { class: 'muted' }, `采集代次 ${f.importGen}`),
    el('span', { class: 'mono' }, f.data.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '))
  );
  card.append(header);

  card.append(
    el(
      'div',
      { class: 'pill-row', style: 'margin-top:8px' },
      el('span', { class: 'muted' }, '消息定义：'),
      d.messageName ? el('code', { class: 'kv' }, d.messageName) : el('span', { class: 'tag fail' }, d.undecodedReason ?? '无定义'),
      el('span', { class: 'muted' }, 'DBC：'),
      el('code', { class: 'kv' }, d.dbcLabel ?? '该时点无生效版本'),
      el('span', { class: 'muted' }, '帧字节序：'),
      el('span', { class: 'tag' }, d.byteOrder === 'mixed' ? '混合' : d.byteOrder === 'intel' ? 'Intel' : d.byteOrder === 'motorola' ? 'Motorola' : '—')
    )
  );

  // 帧表（紧凑，可切换选择）
  const tableWrap = el('div', { style: 'max-height:170px;overflow:auto;margin:10px 0' });
  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {},
      ...['时间', '通道', 'ID', '帧', '代次', 'DBC', '消息'].map((h) => el('th', {}, h))
    ))
  );
  const tbody = el('tbody');
  for (const row of frames.slice(Math.max(0, idx - 12), idx + 13)) {
    tbody.append(
      el(
        'tr',
        {
          class: `clickable ${row.frame.id === f.id ? 'selected' : ''}`,
          onclick: () => renderDetail(card, frames, row.frame.id)
        },
        el('td', { class: 'mono' }, fmtTime(row.frame.hwTime)),
        el('td', {}, String(row.frame.channel)),
        el('td', { class: 'mono' }, fmtId(row.frame.arbId, row.frame.extended)),
        el('td', {}, el('span', { class: `tag ${row.frame.extended ? 'ext' : 'std'}` }, row.frame.extended ? '扩展' : '标准')),
        el('td', {}, String(row.frame.importGen)),
        el('td', {}, row.dbcLabel ?? '—'),
        el('td', {}, row.messageName ?? '未解码')
      )
    );
  }
  table.append(tbody);
  tableWrap.append(table);
  card.append(tableWrap);

  if (d.messageName) {
    card.append(el('h3', {}, '信号解码（值可追溯到 bit 区间）'));
    const sigTable = el('table');
    sigTable.append(
      el('thead', {}, el('tr', {},
        ...['信号', 'bit 区间', '字节序', 'raw bits', 'raw', '缩放/偏置', '物理值', '枚举/分支'].map((h) => el('th', {}, h))
      ))
    );
    const sigBody = el('tbody');
    for (const s of d.signals) {
      const range = `${Math.min(...s.bitCells)}..${Math.max(...s.bitCells)}`;
      sigBody.append(
        el(
          'tr',
          {},
          el('td', { class: 'mono' }, s.name),
          el('td', { class: 'mono' }, `${range} (start ${s.startBit}, len ${s.length})`),
          el('td', {}, s.byteOrder === 'intel' ? 'Intel' : 'Motorola'),
          el('td', {}, el('span', { class: 'bits-string' }, s.rawBits)),
          el('td', { class: 'mono' }, s.raw === null ? '保留' : fmtNum(s.raw)),
          el('td', { class: 'mono' }, `×${s.scale} +${s.offset}`),
          el('td', { class: 'mono' }, s.physical === null ? '—' : `${fmtNum(s.physical)} ${s.unit}`),
          el(
            'td',
            {},
            s.enumLabel ? el('span', { class: 'tag pass' }, s.enumLabel) : null,
            s.muxType === 'multiplexor' ? el('span', { class: 'tag ext' }, `mux 开关=${s.raw}`) : null,
            s.muxType === 'multiplexed'
              ? el('span', { class: `tag ${s.active ? 'identical' : s.reason === 'unknown-mux' ? 'warn' : 'unchecked'}` },
                  s.active ? `分支 ${s.muxSwitch}` : s.reason === 'unknown-mux' ? '分支未知' : `非活动分支 ${s.muxSwitch}`)
              : null
          )
        )
      );
    }
    sigTable.append(sigBody);
    card.append(sigTable);

    card.append(el('h3', {}, 'bit 布局（信号独立轨道，按 8×DLC 网格）'));
    card.append(bitGrid(d.signals, f.data.length || 8));

    card.append(el('h3', {}, '信号曲线（同 ID 全量帧）'));
    const selector = el('select', {}, ...d.signals.map((s) => el('option', { value: String(s.signalDefId) }, s.name)));
    const chartHost = el('div');
    const drawChart = () => {
      const sig = d.signals.find((s) => String(s.signalDefId) === selector.value);
      chartHost.replaceChildren();
      if (!sig) return;
      const series: SignalSeriesPoint[] = frames
        .filter((x) => x.frame.arbId === f.arbId && x.frame.extended === f.extended)
        .map((x) => {
          const ss = x.signals.find((q) => q.signalDefId === sig.signalDefId || q.name === sig.name);
          return {
            frameId: x.frame.id,
            hwTime: x.frame.hwTime,
            raw: ss?.raw ?? null,
            physical: ss?.physical ?? null,
            active: ss?.active ?? false,
            enumLabel: ss?.enumLabel ?? null
          };
        });
      chartHost.append(lineChart(series, sig.unit));
    };
    selector.addEventListener('change', drawChart);
    card.append(el('div', { class: 'row' }, selector), chartHost);
    drawChart();
  }
}

declare global {
  interface Window { __selectedFrame?: number | null; }
}
