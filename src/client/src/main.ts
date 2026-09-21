import { api } from './api.js';
import type { State } from './state.js';

const view = document.querySelector<HTMLElement>('#view')!;
let state: State | null = null;
let selectedFrameId: number | null = null;
let selectedVersionId: number | null = null;

async function refresh(): Promise<void> {
  state = await api<State>('/state');
  document.querySelector('#seed-badge')!.textContent =
    `${state.frameCount.n} 帧 · ${state.versions.length} 个 DBC 版本 · ${state.imports.length} 次导入`;
  const tab = document.querySelector<HTMLElement>('.tabs button.active')?.dataset.tab ?? 'timeline';
  render(tab);
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function idTag(isExtended: boolean): string {
  return `<span class="tag ${isExtended ? 'ext' : 'std'}">${isExtended ? '扩展 0x' : '标准 0x'}${(256).toString(16)}</span>`;
}

function frameTag(isExtended: boolean, id: number): string {
  return `<span class="tag ${isExtended ? 'ext' : 'std'}">${isExtended ? '扩展' : '标准'} 0x${id.toString(16).toUpperCase()}</span>`;
}

async function render(tab: string): Promise<void> {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab));
  if (!state) return;
  if (tab === 'timeline') renderTimeline();
  else if (tab === 'bits') renderBits();
  else if (tab === 'curves') renderCurves();
  else if (tab === 'counters') renderCounters();
  else if (tab === 'crc') renderCrc();
  else if (tab === 'compare') renderCompare();
  else if (tab === 'snapshots') renderSnapshots();
  else if (tab === 'import') renderImport();
}

function renderTimeline(): void {
  const frames = state!.frames;
  const t0 = Math.min(...frames.map((f) => f.hwTime));
  const t1 = Math.max(...frames.map((f) => f.hwTime));
  const span = Math.max(t1 - t0, 1);
  const groups = new Map<string, typeof frames>();
  for (const f of frames) {
    const key = `${f.arbitrationId}:${f.isExtended ? 1 : 0}`;
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }
  const keys = [...groups.keys()].sort();
  const bandColors = state!.versions.map((_, i) => (i % 2 === 0 ? '#5aa7ff' : '#b18cf0'));
  const bands = state!.versions
    .map((v, i) => {
      const left = ((v.validFrom - t0) / span) * 100;
      const right = v.validTo === null ? 100 : ((v.validTo - t0) / span) * 100;
      return `<div class="tl-band" style="left:${Math.max(left, 0)}%;width:${right - Math.max(left, 0)}%;background:${bandColors[i]}"></div>`;
    })
    .join('');
  const rows = keys
    .map((key, ri) => {
      const [idStr, extStr] = key.split(':');
      const dots = groups.get(key)!.map((f) => {
        const x = ((f.hwTime - t0) / span) * 100;
        const sel = f.id === selectedFrameId ? 'sel' : '';
        const color = f.isExtended ? '#b18cf0' : '#5aa7ff';
        return `<div class="tl-dot ${sel}" data-frame="${f.id}" style="left:${x}%;background:${color}" title="gen${f.generation} t=${f.hwTime} ${f.data}"></div>`;
      }).join('');
      return `<div class="tl-row" style="top:${30 + ri * 26}px">
        <span class="small" style="position:absolute;left:6px;top:4px">${frameTag(extStr === '1', Number(idStr))} gen 分组</span>${dots}</div>`;
    })
    .join('');
  view.innerHTML = `
    <div class="panel">
      <h2>帧时间轴（按硬件时间重放，色带为 DBC 生效区间）</h2>
      <div class="legend">${state!.versions.map((v, i) => `<span class="sig-chip" style="background:${bandColors[i]}33;color:${bandColors[i]}">v${v.versionNumber} ${esc(v.label)} [${v.validFrom}, ${v.validTo ?? '∞'})</span>`).join('')}</div>
      <div class="timeline-wrap" id="tl">${bands}${rows}</div>
      <div class="small">蓝点=标准帧，紫点=扩展帧；点击任一帧查看采用的消息定义与解码证据。</div>
    </div>
    <div id="detail"></div>`;
  view.querySelectorAll<HTMLElement>('.tl-dot').forEach((el) =>
    el.addEventListener('click', () => {
      selectedFrameId = Number(el.dataset.frame);
      renderTimeline();
      showDetail();
    })
  );
  if (selectedFrameId !== null) showDetail();
}

async function showDetail(): Promise<void> {
  const target = view.querySelector('#detail');
  if (!target || selectedFrameId === null) return;
  const interp = await api<Interp>(`/frames/${selectedFrameId}${selectedVersionId ? `?versionId=${selectedVersionId}` : ''}`);
  target.innerHTML = detailHtml(interp);
  target.querySelector('#snapshot-btn')?.addEventListener('click', async () => {
    await api('/snapshots', {
      method: 'POST',
      body: JSON.stringify({ frameId: selectedFrameId, title: `帧 #${selectedFrameId} 调查快照`, note: '界面冻结' }),
    });
    await refresh();
  });
}

interface InterpSignal {
  name: string; raw: number | null; value: number | null; unit: string; enumName?: string;
  bitPositions: { linear: number; dbc: number }[];
  startBit: number; length: number; byteOrder: 'intel' | 'motorola';
  factor: number; offset: number; muxKind: string; active: boolean; unknownBranch: boolean;
  muxSwitchName?: string; muxValue?: number;
}
interface Interp {
  frame: { id: number; generation: number; channel: number; arbitrationId: number; isExtended: boolean; hwTime: number; dlc: number; data: number[] };
  decoded: { messageName: string; dbcVersionId: number; dbcVersionNumber: number; unknownBranch: boolean; muxSwitch?: { name: string; raw: number }; signals: InterpSignal[] } | null;
  stale: boolean; versionNumber: number; note?: string;
}

function detailHtml(interp: Interp): string {
  const f = interp.frame;
  if (!interp.decoded) {
    return `<div class="panel"><h2>帧 #${f.id}</h2><p class="small">该硬件时间点没有生效的 DBC 版本：${esc(interp.note)}</p></div>`;
  }
  const d = interp.decoded;
  const rows = d.signals
    .map((s) => {
      const dbcs = s.bitPositions.map((p) => p.dbc);
      const span = dbcs.length === 1 ? `bit ${dbcs[0]}` : `bit ${Math.min(...dbcs)}..${Math.max(...dbcs)}`;
      const nonContig = dbcs
        .slice()
        .sort((a, b) => a - b)
        .some((n, i, arr) => i > 0 && n !== arr[i - 1] + 1);
      const loc = nonContig ? `bits ${dbcs.slice().sort((a, b) => a - b).join(',')}` : span;
      const enumTxt = s.enumName ? `枚举 <b>${esc(s.enumName)}</b>` : '';
      const muxTxt =
        s.muxKind === 'switch'
          ? `<span class="tag muted">多路开关</span>`
          : s.muxKind === 'branch'
            ? `<span class="tag muted">分支 m${s.muxValue}</span>`
            : '';
      const state = !s.active
        ? '<span class="tag muted">未激活（raw bits 保留）</span>'
        : s.unknownBranch
          ? '<span class="tag warn">未知分支</span>'
          : '';
      return `<tr>
        <td class="mono">${esc(s.name)}</td>
        <td>${s.active ? s.raw : '—'} <span class="small">raw</span></td>
        <td>${s.active ? `${s.value} ${esc(s.unit)}` : '—'}</td>
        <td>${enumTxt}</td>
        <td class="mono">${s.byteOrder === 'motorola' ? 'Motorola@0' : 'Intel@1'} start=${s.startBit} len=${s.length}</td>
        <td class="mono">×${s.factor} + ${s.offset}</td>
        <td class="mono">${loc}</td>
        <td>${muxTxt} ${state}</td>
      </tr>`;
    })
    .join('');
  return `<div class="panel">
    <h2>帧 #${f.id} · ${esc(d.messageName)} ${frameTag(f.isExtended, f.arbitrationId)}
      <span class="tag muted">DBC v${d.dbcVersionNumber}</span>
      ${interp.stale ? '<span class="tag warn stale">该解码已过期</span>' : '<span class="tag ok">当前定义</span>'}
    </h2>
    <dl class="kv">
      <dt>原始帧</dt><dd class="mono">${Array.from(f.data).map((b) => b.toString(16).padStart(2, '0')).join(' ')} (DLC ${f.dlc})</dd>
      <dt>通道 / 代次</dt><dd>CH${f.channel} · 采集代次 ${f.generation} · 硬件时间 ${f.hwTime}</dd>
      <dt>消息定义</dt><dd>${esc(d.messageName)}（${f.isExtended ? '扩展帧' : '标准帧'}，ID 不混用）</dd>
      <dt>多路复用</dt><dd>${d.muxSwitch ? `开关 ${esc(d.muxSwitch.name)} = ${d.muxSwitch.raw}${d.unknownBranch ? '（分支未知，仅保留 raw bits）' : ''}` : '无'}</dd>
    </dl>
    <div class="scroll"><table>
      <thead><tr><th>信号</th><th>raw</th><th>物理值</th><th>枚举</th><th>字节序</th><th>缩放/偏置</th><th>确切 bit 区间</th><th>多路/状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="row" style="margin-top:10px">
      <label class="small">强制按版本解释：
        <select id="force-version">
          ${state!.versions.map((v) => `<option value="${v.id}" ${v.id === d.dbcVersionId ? 'selected' : ''}>v${v.versionNumber} ${esc(v.label)}</option>`).join('')}
        </select>
      </label>
      <button class="ghost" id="snapshot-btn">冻结调查快照</button>
    </div>
  </div>`;
}

document.addEventListener('change', async (e) => {
  const el = e.target as HTMLElement;
  if (el.id === 'force-version') {
    selectedVersionId = Number((el as HTMLSelectElement).value);
    showDetail();
  }
});

const PALETTE = ['#5aa7ff', '#4ecb71', '#f0b452', '#b18cf0', '#f06b6b', '#46d0d0', '#e08fd0', '#9db44d'];

async function renderBits(): Promise<void> {
  const frameOptions = state!.frames.map((f) => `<option value="${f.id}" ${f.id === selectedFrameId ? 'selected' : ''}>#${f.id} 0x${f.arbitrationId.toString(16).toUpperCase()}${f.isExtended ? ' X' : ''} t=${f.hwTime}</option>`).join('');
  view.innerHTML = `<div class="panel">
    <h2>Bit 布局</h2>
    <div class="row">
      <select id="frame-picker" style="min-width:340px">${frameOptions}</select>
      <select id="version-picker"><option value="">生效版本（按时间）</option>${state!.versions.map((v) => `<option value="${v.id}" ${v.id === selectedVersionId ? 'selected' : ''}>v${v.versionNumber}</option>`).join('')}</select>
    </div>
    <div id="bit-content"></div>
  </div>`;
  const pick = () => {
    selectedFrameId = Number(view.querySelector<HTMLSelectElement>('#frame-picker')!.value);
    selectedVersionId = Number(view.querySelector<HTMLSelectElement>('#version-picker')!.value) || null;
    drawBits();
  };
  view.querySelector('#frame-picker')!.addEventListener('change', pick);
  view.querySelector('#version-picker')!.addEventListener('change', pick);
  if (selectedFrameId === null && state!.frames.length) selectedFrameId = state!.frames[0].id;
  drawBits();
}

async function drawBits(): Promise<void> {
  if (selectedFrameId === null) return;
  const interp = await api<Interp>(`/frames/${selectedFrameId}${selectedVersionId ? `?versionId=${selectedVersionId}` : ''}`);
  const host = view.querySelector('#bit-content')!;
  if (!interp.decoded) {
    host.innerHTML = '<p class="small">无匹配消息定义。</p>';
    return;
  }
  const data = interp.frame.data;
  const colorOf = new Map<string, string>();
  interp.decoded.signals.forEach((s, i) => colorOf.set(s.name, PALETTE[i % PALETTE.length]));

  const cells = data
    .map((byteVal, bi) => {
      const bitRows = [7, 6, 5, 4, 3, 2, 1, 0]
        .map((q) => {
          const linear = bi * 8 + q;
          const sig = interp.decoded!.signals.find((s) => s.active && s.bitPositions.some((p) => p.linear === linear));
          const on = (byteVal >> q) & 1;
          const color = sig ? colorOf.get(sig.name) : undefined;
          return `<div class="bit ${on ? 'on' : ''}" style="${color ? `color:${color};box-shadow: inset 0 0 0 1px ${color}55` : ''}" title="${sig ? sig.name : '未使用'} bit ${linear}">
            <span>${linear}</span><span>${on}</span></div>`;
        })
        .join('');
      return `<div class="bytecell"><h4>B${bi} = 0x${byteVal.toString(16).padStart(2, '0').toUpperCase()}</h4>${bitRows}</div>`;
    })
    .join('');

  const chips = interp.decoded.signals
    .map((s) => {
      const dbcs = s.bitPositions.map((p) => p.dbc).sort((a, b) => a - b);
      const loc = dbcs.length === 1 ? `bit ${dbcs[0]}` : `bit ${dbcs[0]}..${dbcs[dbcs.length - 1]}`;
      return `<span class="sig-chip ${s.active ? '' : ''}" style="background:${colorOf.get(s.name)}22;color:${colorOf.get(s.name)}">
        ${esc(s.name)} ${s.active ? `= ${s.value} ${esc(s.unit)}` : '(未激活/raw bits)'} · ${loc} · ${s.byteOrder === 'motorola' ? 'Motorola' : 'Intel'}</span>`;
    })
    .join('');
  host.innerHTML = `<div class="bitmap">${cells}</div>
    <p class="small" style="margin-top:8px">格内数字是 DBC/物理 bit 编号（与线性编号一致），格右小数字为该位实际电平。</p>
    <div>${chips}</div>
    ${interp.stale ? '<p class="stale">注意：该帧按旧定义的解码已过期。</p>' : ''}`;
}

async function renderCurves(): Promise<void> {
  const groups = new Map<string, { id: number; ext: boolean }>();
  state!.frames.forEach((f) => groups.set(`${f.arbitrationId}:${f.isExtended ? 1 : 0}`, { id: f.arbitrationId, ext: f.isExtended }));
  const groupOptions = [...groups.entries()].map(([k, g]) => `<option value="${k}">0x${g.id.toString(16).toUpperCase()} ${g.ext ? '扩展' : '标准'}</option>`).join('');
  view.innerHTML = `<div class="panel">
    <h2>信号曲线</h2>
    <div class="row">
      <select id="curve-group">${groupOptions}</select>
      <select id="curve-signal"></select>
      <select id="curve-version"><option value="">生效版本（逐帧解析）</option>${state!.versions.map((v) => `<option value="${v.id}">v${v.versionNumber}</option>`).join('')}</select>
    </div>
    <canvas id="curve-canvas" width="1100" height="220"></canvas>
    <div id="curve-info" class="small"></div>
  </div>`;
  const loadSignals = async () => {
    const key = view.querySelector<HTMLSelectElement>('#curve-group')!.value;
    const [idStr, extStr] = key.split(':');
    const first = state!.frames.find((f) => f.arbitrationId === Number(idStr) && f.isExtended === (extStr === '1'));
    if (!first) return;
    const interp = await api<Interp>(`/frames/${first.id}`);
    const sel = view.querySelector<HTMLSelectElement>('#curve-signal')!;
    sel.innerHTML = (interp.decoded?.signals ?? []).map((s) => `<option value="${s.name}">${s.name}</option>`).join('');
    drawCurve();
  };
  const drawCurve = async () => {
    const key = view.querySelector<HTMLSelectElement>('#curve-group')!.value;
    const signal = view.querySelector<HTMLSelectElement>('#curve-signal')!.value;
    const vid = view.querySelector<HTMLSelectElement>('#curve-version')!.value;
    const [idStr, extStr] = key.split(':');
    const q = `?messageId=${idStr}&extended=${extStr}&signal=${encodeURIComponent(signal)}${vid ? `&versionId=${vid}` : ''}`;
    const curve = await api<{ points: { frameId: number; hwTime: number; generation: number; raw: number | null; value: number | null }[] }>(`/curve${q}`);
    const canvas = view.querySelector<HTMLCanvasElement>('#curve-canvas')!;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const pts = curve.points;
    view.querySelector('#curve-info')!.textContent = pts.length
      ? `${pts.length} 个采样点，时间 ${pts[0].hwTime} .. ${pts[pts.length - 1].hwTime}，跨采集代次 ${[...new Set(pts.map((p) => p.generation))].join(', ')}`
      : '无数据';
    if (pts.length < 1) return;
    const tMin = Math.min(...pts.map((p) => p.hwTime));
    const tMax = Math.max(...pts.map((p) => p.hwTime));
    const vMin = Math.min(...pts.map((p) => p.value as number));
    const vMax = Math.max(...pts.map((p) => p.value as number));
    const x = (t: number) => 40 + ((t - tMin) / Math.max(tMax - tMin, 1)) * (canvas.width - 60);
    const y = (v: number) => canvas.height - 30 - ((v - vMin) / Math.max(vMax - vMin, 1)) * (canvas.height - 60);
    ctx.strokeStyle = '#2b3654';
    ctx.beginPath(); ctx.moveTo(40, 20); ctx.lineTo(40, canvas.height - 30); ctx.lineTo(canvas.width - 20, canvas.height - 30); ctx.stroke();
    ctx.fillStyle = '#8a97b8'; ctx.font = '11px monospace';
    ctx.fillText(String(vMax), 4, 24); ctx.fillText(String(vMin), 4, canvas.height - 34);
    ctx.strokeStyle = '#5aa7ff'; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => { const px = x(p.hwTime), py = y(p.value as number); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
    ctx.fillStyle = '#5aa7ff';
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(x(p.hwTime), y(p.value as number), 2.5, 0, 7); ctx.fill(); });
  };
  view.querySelector('#curve-group')!.addEventListener('change', loadSignals);
  view.querySelector('#curve-signal')!.addEventListener('change', drawCurve);
  view.querySelector('#curve-version')!.addEventListener('change', drawCurve);
  await loadSignals();
}

async function renderCounters(): Promise<void> {
  const data = await api<{
    config: { messageKey: string; node: string; signalName: string; modulus: number; increment: number };
    reports: { key: string; node: string; generation: number; wraps: number; repeats: number; missing: number; duplicateTimestamps: number; checkedFrames: number;
      events: { frameId: number; hwTime: number; kind: string; duplicateTimestamp: boolean; expected?: number; actual: number; missingCount?: number }[] }[];
  }[]>('/analyze/counters');
  const sections = data.map((group) => {
    const c = group.config;
    const reportHtml = group.reports
      .map((r) => {
        const bad = r.events
          .filter((e) => e.kind !== 'ok' || e.duplicateTimestamp)
          .map((e) => `<tr>
            <td>#${e.frameId}</td><td class="mono">${e.hwTime}</td>
            <td><span class="tag ${e.kind === 'ok' ? 'ok' : e.kind === 'wrap' ? 'warn' : 'bad'}">${e.kind}</span>${e.duplicateTimestamp ? ' <span class="tag warn">重复时间戳</span>' : ''}</td>
            <td class="mono">${e.actual}${e.expected !== undefined ? `（期望 ${e.expected}）` : ''}</td>
            <td>${e.missingCount ? `缺 ${e.missingCount} 帧` : ''}</td>
          </tr>`)
          .join('');
        return `<div class="panel">
          <h2>${c.messageKey} · 节点 ${r.node} · 采集代次 ${r.generation}</h2>
          <div class="row">
            <span class="tag ok">环绕 ${r.wraps}</span>
            <span class="tag bad">重复值 ${r.repeats}</span>
            <span class="tag bad">缺帧 ${r.missing}</span>
            <span class="tag warn">重复时间戳 ${r.duplicateTimestamps}</span>
            <span class="tag muted">检查 ${r.checkedFrames} 帧</span>
            <span class="small">信号 ${esc(c.signalName)}，mod ${c.modulus}，步进 ${c.increment}</span>
          </div>
          <div class="scroll"><table><thead><tr><th>帧</th><th>硬件时间</th><th>判定</th><th>计数器值</th><th>缺口</th></tr></thead><tbody>${bad}</tbody></table></div>
        </div>`;
      })
      .join('');
    return reportHtml || `<div class="panel"><h2>${c.messageKey}</h2><p class="small">没有可检查的帧。</p></div>`;
  }).join('');
  view.innerHTML = `<div class="panel"><h2>计数器缺口（按节点 × 采集代次）</h2><p class="small">判定：环绕（wrap）/ 重复（repeat）/ 缺帧（missing），重复时间戳单独标记；排序与导入顺序无关。</p></div>${sections}`;
}

async function renderCrc(): Promise<void> {
  const data = await api<{
    messageKey: string; complete: boolean; missing: string[];
    results: { frameId: number; hwTime: number; verdict: 'pass' | 'fail' | 'unchecked'; computed?: number; expected?: number; coveredBytes: number[]; reason?: string }[];
  }[]>('/analyze/crc');
  const sections = data
    .map((g) => {
      const configTag = g.complete
        ? '<span class="tag ok">配置完整</span>'
        : `<span class="tag warn">未核验</span><span class="small"> 缺：${g.missing.join(', ')}</span>`;
      const rows = g.results
        .map((r) => {
          const cls = r.verdict === 'pass' ? 'ok' : r.verdict === 'fail' ? 'bad' : 'warn';
          return `<tr>
            <td>#${r.frameId}</td><td class="mono">${r.hwTime}</td>
            <td><span class="tag ${cls}">${r.verdict === 'unchecked' ? '未核验' : r.verdict === 'pass' ? '通过' : '失败'}</span></td>
            <td class="mono">${r.computed !== undefined ? `0x${r.computed.toString(16).padStart(2, '0')}` : '—'}</td>
            <td class="mono">${r.expected !== undefined ? `0x${r.expected.toString(16).padStart(2, '0')}` : '—'}</td>
            <td class="mono">[${(r.coveredBytes ?? []).join(', ')}]</td>
            <td class="small">${esc(r.reason ?? '')}</td>
          </tr>`;
        })
        .join('');
      return `<div class="panel">
        <h2>CRC 证据 · ${g.messageKey} ${configTag}</h2>
        <p class="small">覆盖范围、初值、异或值可配置；配置不完整时一律“未核验”，不报通过。</p>
        <div class="scroll"><table><thead><tr><th>帧</th><th>硬件时间</th><th>判定</th><th>计算值</th><th>期望值</th><th>覆盖字节</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    })
    .join('');
  view.innerHTML = sections || '<div class="panel"><p class="small">暂无 CRC 配置。</p></div>';
}

interface CompareData {
  from: { id: number; versionNumber: number };
  to: { id: number; versionNumber: number };
  messages: {
    messageId: number; isExtended: boolean; name: string; status: string;
    signals: { signal: string; fromBits?: string; toBits?: string; fromType?: string; toType?: string; transform: string; status: string; reason?: string }[];
  }[];
  maps: { messageKey: string; status: string; version: number; approvedBy: string | null }[];
}

async function renderCompare(): Promise<void> {
  const vOpts = state!.versions.map((v) => `<option value="${v.id}">v${v.versionNumber} ${esc(v.label)}</option>`).join('');
  view.innerHTML = `<div class="panel">
    <h2>比较两个 DBC 版本对同一批帧的影响</h2>
    <div class="row">
      <label class="small">旧 <select id="cmp-from">${vOpts}</select></label>
      <label class="small">新 <select id="cmp-to">${vOpts}</select></label>
      <button class="action" id="cmp-go">比较</button>
    </div>
    <div id="cmp-out"></div>
  </div>`;
  const sels = view.querySelectorAll<HTMLSelectElement>('#cmp-from,#cmp-to');
  sels[0].value = String(state!.versions[0]?.id ?? '');
  sels[1].value = String(state!.versions[state!.versions.length - 1]?.id ?? '');
  view.querySelector('#cmp-go')!.addEventListener('click', runCompare);
  runCompare();
}

function statusTag(s: string): string {
  const cls = s === 'identical' ? 'muted' : s === 'incompatible' || s === 'missing-from' || s === 'missing-to' ? 'bad' : s === 'enum-changed' ? 'warn' : 'ok';
  const label: Record<string, string> = { identical: '一致', compatible: '可迁移', 'enum-changed': '枚举变化', incompatible: '无法兼容', 'missing-from': '新增', 'missing-to': '删除' };
  return `<span class="tag ${cls}">${label[s] ?? s}</span>`;
}

async function runCompare(): Promise<void> {
  const from = view.querySelector<HTMLSelectElement>('#cmp-from')!.value;
  const to = view.querySelector<HTMLSelectElement>('#cmp-to')!.value;
  const data = await api<CompareData>(`/compare?from=${from}&to=${to}`);
  const mapByKey = new Map(data.maps.map((m) => [m.messageKey, m]));
  const html = data.messages
    .map((m) => {
      const key = `${m.messageId}:${m.isExtended ? 1 : 0}`;
      const existing = mapByKey.get(key);
      const rows = m.signals
        .map((s) => `<tr>
          <td class="mono">${esc(s.signal)}</td><td>${statusTag(s.status)}</td>
          <td class="small mono">${esc(s.fromBits ?? '')}</td><td class="small mono">${esc(s.toBits ?? '')}</td>
          <td class="small">${esc(s.transform)}${s.reason ? `<br><span class="small">${esc(s.reason)}</span>` : ''}</td>
        </tr>`)
        .join('');
      const approve = existing
        ? `<span class="small">映射版本 ${existing.version}${existing.approvedBy ? ` · 已由 ${esc(existing.approvedBy)} 批准` : ''}</span>
           <button class="ghost" data-approve="${key}" data-version="${existing.version}">批准</button>`
        : `<button class="action" data-save="${key}" data-status="compatible">批准迁移映射</button>
           <button class="ghost" data-save="${key}" data-status="incompatible">标记无法兼容</button>`;
      return `<div class="panel">
        <h2>${frameTag(m.isExtended, m.messageId)} ${esc(m.name)} ${statusTag(m.status)} <span style="float:right">${approve}</span></h2>
        <div class="scroll"><table><thead><tr><th>信号</th><th>状态</th><th>旧布局</th><th>新布局</th><th>映射动作</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    })
    .join('');
  view.querySelector('#cmp-out')!.innerHTML = html;

  view.querySelectorAll<HTMLElement>('[data-save]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        const result = await api<{ ok: boolean; version: number }>('/migration', {
          method: 'POST',
          body: JSON.stringify({
            fromVersion: data.from.versionNumber,
            toVersion: data.to.versionNumber,
            messageKey: btn.dataset.save,
            status: btn.dataset.status,
            payload: { generatedAt: Date.now() },
          }),
        });
        void result;
        runCompare();
      } catch (err) {
        alert((err as Error).message);
      }
    })
  );
  view.querySelectorAll<HTMLElement>('[data-approve]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api('/migration/approve', {
          method: 'POST',
          body: JSON.stringify({
            fromVersion: data.from.versionNumber,
            toVersion: data.to.versionNumber,
            messageKey: btn.dataset.approve,
            approver: 'bus-tester',
            expectedVersion: Number(btn.dataset.version),
          }),
        });
        runCompare();
      } catch (err) {
        alert(`审批冲突或失败：${(err as Error).message}`);
      }
    })
  );
}

async function renderSnapshots(): Promise<void> {
  const items = state!.snapshots
    .map((s) => `<tr class="clickable" data-snap="${s.id}">
      <td>#${s.id}</td><td>${esc(s.title)}</td><td>帧 #${s.frameId}</td><td>DBC 版本 id=${s.dbcVersionId}</td>
      <td class="small">冻结后即使 DBC 修订也继续指向旧定义</td>
    </tr>`)
    .join('');
  view.innerHTML = `<div class="panel">
    <h2>冻结的调查快照</h2>
    <div class="scroll"><table><thead><tr><th>快照</th><th>标题</th><th>帧</th><th>定义</th><th>说明</th></tr></thead><tbody>${items}</tbody></table></div>
    <div id="snap-detail"></div>
  </div>`;
  view.querySelectorAll<HTMLElement>('[data-snap]').forEach((el) =>
    el.addEventListener('click', async () => {
      const snap = await api<{ title: string; note: string; definition: { name: string }; decode: Interp['decoded'] }>(`/snapshots/${el.dataset.snap}`);
      const d = snap.decode as Interp['decoded'];
      const def = snap.definition as { name: string; signals: { name: string; startBit: number; length: number; byteOrder: string; factor: number; offset: number }[] };
      view.querySelector('#snap-detail')!.innerHTML = `<div class="panel">
        <h2>${esc(snap.title)}</h2>
        <p class="small">${esc(snap.note)} · 冻结定义：${esc(def.name)}</p>
        <div class="scroll"><table><thead><tr><th>信号</th><th>raw</th><th>值</th><th>冻结布局</th><th>缩放</th></tr></thead><tbody>
        ${d!.signals.map((s) => `<tr><td class="mono">${esc(s.name)}</td><td>${s.raw ?? '—'}</td><td>${s.value ?? '—'} ${esc(s.unit)}</td>
          <td class="mono">${s.byteOrder} start=${s.startBit} len=${s.length}</td><td class="mono">×${s.factor} + ${s.offset}</td></tr>`).join('')}
        </tbody></table></div>
      </div>`;
    })
  );
}

function renderImport(): void {
  view.innerHTML = `
    <div class="panel">
      <h2>导入 CAN trace</h2>
      <p class="small">CSV：generation,channel,id,X|S,rx|tx,hwtime,dlc,HEXDATA；或每行一个 JSON 对象。重导不会产生重复帧，分析结果与导入顺序无关。</p>
      <textarea id="trace-text" placeholder="1,1,100,S,rx,10,8,00 01 02 03 04 05 06 07"></textarea>
      <div class="row" style="margin-top:8px"><button class="action" id="trace-go">导入 trace</button><span id="trace-result" class="small"></span></div>
    </div>
    <div class="panel">
      <h2>导入 / 修订 DBC（带生效区间）</h2>
      <div class="row">
        <input id="dbc-version" type="number" placeholder="版本号" style="width:90px" />
        <input id="dbc-label" placeholder="标签，如 2026 修订" style="width:180px" />
        <input id="dbc-from" type="number" placeholder="validFrom" style="width:110px" />
        <input id="dbc-to" type="number" placeholder="validTo（空=至今）" style="width:150px" />
      </div>
      <textarea id="dbc-text" placeholder="BO_ / SG_ / VAL_ DBC 文本"></textarea>
      <div class="row" style="margin-top:8px"><button class="action" id="dbc-go">保存 DBC 版本</button><span id="dbc-result" class="small"></span></div>
      <p class="small">区间语义：[validFrom, validTo)，端点 half-open；修订后仅受区间影响的旧解码标记为过期。并发审批以版本号冲突检测（HTTP 409）。</p>
    </div>`;
  view.querySelector('#trace-go')!.addEventListener('click', async () => {
    const text = view.querySelector<HTMLTextAreaElement>('#trace-text')!.value;
    try {
      const r = await api<{ inserted: number; parseErrors: string[]; decoded: number; unmatched: number }>('/import/trace', {
        method: 'POST',
        body: JSON.stringify({ text, name: 'ui-paste.csv' }),
      });
      view.querySelector('#trace-result')!.textContent = `入库 ${r.inserted} 帧，解码 ${r.decoded}，未匹配 ${r.unmatched}，错误 ${r.parseErrors.length}`;
      await refresh();
    } catch (err) {
      view.querySelector('#trace-result')!.textContent = (err as Error).message;
    }
  });
  view.querySelector('#dbc-go')!.addEventListener('click', async () => {
    const payload = {
      content: view.querySelector<HTMLTextAreaElement>('#dbc-text')!.value,
      versionNumber: Number(view.querySelector<HTMLInputElement>('#dbc-version')!.value),
      label: view.querySelector<HTMLInputElement>('#dbc-label')!.value,
      validFrom: Number(view.querySelector<HTMLInputElement>('#dbc-from')!.value),
      validTo: (() => { const v = view.querySelector<HTMLInputElement>('#dbc-to')!.value; return v === '' ? null : Number(v); })(),
    };
    try {
      const r = await api<{ decoded: number; unmatched: number }>('/import/dbc', { method: 'POST', body: JSON.stringify(payload) });
      view.querySelector('#dbc-result')!.textContent = `已保存，重解码 ${r.decoded}，未匹配 ${r.unmatched}`;
      await refresh();
    } catch (err) {
      view.querySelector('#dbc-result')!.textContent = (err as Error).message;
    }
  });
}

document.querySelector('#tabs')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (btn) render(btn.dataset.tab as string);
});

refresh().catch((err) => {
  view.innerHTML = `<div class="panel"><h2>初始化失败</h2><pre>${esc(err.message)}</pre></div>`;
});
