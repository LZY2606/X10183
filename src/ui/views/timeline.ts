import { api, hexId } from '../api.js';

interface TimelineRow {
  id: number;
  canId: number;
  isExtended: boolean;
  channel: number;
  hwTime: number;
  acquisitionGen: number;
  dataHex: string;
  dbcId: number | null;
  dbcLabel: string | null;
  messageName: string | null;
  reason: string;
  muxValue: number | null;
  signalCount: number;
  stale?: boolean;
}

const REASON_TEXT: Record<string, string> = {
  ok: '已解码',
  'no-effective-dbc': '该时刻无生效 DBC',
  'no-message-definition': '生效 DBC 内无此消息定义'
};

export async function timelineView(root: HTMLElement) {
  root.innerHTML = `
    <div class="panel">
      <h2>帧时间轴</h2>
      <div id="tl-svg"></div>
      <div class="muted" style="margin-top:6px">彩色竖条按消息着色；标准帧/扩展帧分属不同定义。点击任意帧查看解码证据。</div>
    </div>
    <div class="two-col">
      <div class="panel"><div class="scroll"><table id="ftable"></table></div></div>
      <div class="panel" id="detail"><span class="muted">点击左侧帧查看定义与 bit 级证据</span></div>
    </div>`;

  const rows: TimelineRow[] = await api('/api/timeline');
  const names = [...new Set(rows.map((r) => r.messageName).filter(Boolean))] as string[];
  const palette = ['#4ea1ff', '#3fb950', '#a371f7', '#d29922', '#39c5cf', '#f85149'];
  const colorOf = (n: string | null) => (n ? palette[names.indexOf(n) % palette.length] : '#46566a');

  // SVG 时间轴
  const times = rows.map((r) => r.hwTime);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times, tMin + 1);
  const lanes = new Map<string, number>();
  rows.forEach((r) => {
    const key = `${r.canId}:${r.isExtended ? 1 : 0}`;
    if (!lanes.has(key)) lanes.set(key, lanes.size);
  });
  const laneH = 26;
  const svgW = 960;
  const svgH = Math.max(70, lanes.size * laneH + 34);
  const x = (t: number) => 30 + ((t - tMin) / (tMax - tMin)) * (svgW - 46);
  let bars = '';
  for (const r of rows) {
    const lane = lanes.get(`${r.canId}:${r.isExtended ? 1 : 0}`)!;
    const y = 24 + lane * laneH;
    bars += `<line class="tlbar" data-id="${r.id}" x1="${x(r.hwTime).toFixed(1)}" x2="${x(r.hwTime).toFixed(1)}"
      y1="${y}" y2="${y + 16}" stroke="${colorOf(r.messageName)}" stroke-width="3" style="cursor:pointer"/>`;
  }
  let labels = '';
  for (const [key, lane] of lanes) {
    const [idStr, ext] = key.split(':');
    labels += `<text x="4" y="${36 + lane * laneH}" fill="#8497a8" font-size="10" class="mono">${hexId(Number(idStr), ext === '1')}</text>`;
  }
  root.querySelector('#tl-svg')!.innerHTML =
    `<svg class="timeline" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="none">${labels}${bars}</svg>`;

  const table = root.querySelector<HTMLTableElement>('#ftable')!;
  table.innerHTML = `
    <thead><tr><th>#</th><th>时间(ms)</th><th>ID</th><th>类型</th><th>通道</th><th>代次</th><th>数据</th><th>消息定义</th><th>DBC</th><th>状态</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr data-id="${r.id}">
      <td>${r.id}</td><td class="mono">${r.hwTime}</td>
      <td class="mono">0x${r.canId.toString(16).toUpperCase().padStart(3, '0')}</td>
      <td>${r.isExtended ? '<span class="pill ext">扩展</span>' : '<span class="pill std">标准</span>'}</td>
      <td>${r.channel}</td><td>G${r.acquisitionGen}</td>
      <td class="mono">${r.dataHex.match(/../g)?.join(' ')}</td>
      <td>${r.messageName ?? '<span class="muted">—</span>'}${r.muxValue !== null ? ` <span class="pill muted">mux=${r.muxValue}</span>` : ''}</td>
      <td class="mono">${r.dbcLabel ?? '—'}</td>
      <td>${r.reason === 'ok' ? (r.stale ? '<span class="pill warn">已过期</span>' : '<span class="pill ok">已解码</span>') : `<span class="pill warn">${REASON_TEXT[r.reason] ?? r.reason}</span>`}</td>
    </tr>`
      )
      .join('')}</tbody>`;

  const detail = root.querySelector('#detail')!;
  const show = async (id: number) => {
    table.querySelectorAll('tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.id) === id));
    const d = await api(`/api/frame?id=${id}`);
    detail.innerHTML = renderDetail(d);
  };
  table.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest('tr[data-id]') as HTMLTableRowElement | null;
    if (tr) show(Number(tr.dataset.id));
  });
  (root.querySelector('.timeline') as SVGSVGElement | null)?.addEventListener('click', (e) => {
    const hit = (e.target as SVGElement).closest('[data-id]') as SVGElement | null;
    if (hit?.dataset?.id) show(Number(hit.dataset.id));
  });
  if (rows[0]) show(rows[0].id);
}

function renderDetail(d: any): string {
  if (!d.message) {
    return `<h2>帧 #${d.frame.id} <span class="mono">${hexId(d.frame.canId, d.frame.isExtended)}</span></h2>
      <p><span class="pill warn">${REASON_TEXT[d.reason] ?? d.reason}</span></p>
      <p class="muted">硬件时间 ${d.frame.hwTime} ms · 通道 ${d.frame.channel} · 代次 G${d.frame.acquisitionGen}</p>
      <p class="mono">${d.frame.dataHex}</p>`;
  }
  const data = d.frame.dataHex.match(/../g) as string[];
  const colors = ['#4ea1ff', '#3fb950', '#a371f7', '#d29922', '#39c5cf', '#f85149', '#e07be0', '#7ed7a0'];
  const colorBySig: Record<string, string> = {};
  d.signals.forEach((s: any, i: number) => (colorBySig[s.signalName] = colors[i % colors.length]));

  const cellColor = new Map<number, string>();
  for (const s of d.signals) for (const p of s.bitPositions) cellColor.set(p, s.muxUnknown ? '#3a4350' : colorBySig[s.signalName]);

  let cells = '';
  for (let byte = 0; byte < d.message.dlc; byte++) {
    for (let bit = 7; bit >= 0; bit--) {
      const linear = byte * 8 + bit;
      const c = cellColor.get(linear);
      cells += `<div class="bit-cell" style="${c ? `background:${c}33;border-color:${c}` : ''}" title="线性位 ${linear} / DBC 位号 ${linear}">
        <span class="dbcn">${linear}</span>${data[byte]?.[7 - bit] ?? '0'}</div>`;
    }
  }
  const muxRow = d.muxValue !== null ? `<p>多路复用器：<code class="k">${d.signals.find((s:any)=>s.muxRole==='switch')?.signalName}</code> = <b>${d.muxValue}</b></p>` : '';

  return `
  <h2>${d.message.name} <span class="mono" style="font-size:12px">${hexId(d.frame.canId, d.frame.isExtended)}</span></h2>
  <p class="muted">定义来源 <b>${d.dbc.label}</b>（生效 ${d.dbc.effectiveFrom ?? '−∞'} ~ ${d.dbc.effectiveTo ?? '+∞'} ms）
     · DLC ${d.message.dlc} · 发送节点 ${d.message.transmitter ?? '—'} · 硬件时间 ${d.frame.hwTime} ms · G${d.frame.acquisitionGen}</p>
  ${muxRow}
  <h3>Bit 布局（格内数字为 DBC 位号 / 数据位值）</h3>
  <div class="bit-grid">${cells}</div>
  <div class="legend">${d.signals
    .map((s: any) => `<span><i style="background:${s.muxUnknown ? '#3a4350' : colorBySig[s.signalName]}"></i>${s.signalName}${s.muxUnknown ? '（分支未知·保留 raw）' : ''}</span>`)
    .join('')}</div>
  <h3>信号证据链</h3>
  ${d.signals.map((s: any) => renderSignal(s, data)).join('')}`;
}

function renderSignal(s: any, data: string[]): string {
  const endianLabel = s.byteOrder === 'intel' ? 'Intel（小端 / LSB 起始）' : 'Motorola（大端 / MSB 起始）';
  if (s.muxUnknown) {
    return `<div class="sig-row" style="border-color:#5a6c7d">
      <b>${s.signalName}</b> <span class="pill muted">分支未知</span>
      <div class="evidence">所属 mux 分支 <code class="k">${s.muxRole}</code> 与当前值不匹配；位区间 <code class="k">${s.bitRanges.join(', ')}</code> 原始 bits：<code class="k">${s.rawBits ?? ''}</code>，不做缩放解释。</div>
    </div>`;
  }
  return `<div class="sig-row">
    <b>${s.signalName}</b>
    ${s.enumValue ? `<span class="pill ok">${s.enumValue}</span>` : ''}
    <span style="font-size:16px;float:right">${formatNum(s.physical)}${s.unit ? ' ' + s.unit : ''}</span>
    <div class="evidence">
      ${endianLabel} · 起始 DBC 位号 <code class="k">${s.startBitDbc}</code> · 长度 <code class="k">${s.bitLength}</code> bit
      · 确切 bit 区间 <code class="k">${s.bitRanges.join(', ')}</code><br/>
      raw 位串 <code class="k">${s.rawBits}</code> → 无符号 <code class="k">${s.raw}</code> → 有符号 <code class="k">${s.signedRaw}</code>
      → 物理 = raw × ${s.factor} + (${s.offset}) = <code class="k">${formatNum(s.physical)}</code>
    </div>
  </div>`;
}

function formatNum(v: number | null): string {
  if (v === null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
