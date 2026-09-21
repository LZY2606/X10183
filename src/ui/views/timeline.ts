import { api, fmtId, fmtNs } from '../api';
import type { DecodedMessage } from '../../core/decode';

interface FrameRow {
  id: number;
  arbId: number;
  extended: boolean;
  channel: string | null;
  hwTimeNs: number;
  generation: number;
  dataHex: string;
  dlc: number;
  messageName: string | null;
  versionId: number | null;
  versionLabel: string | null;
}

export async function renderTimeline(root: HTMLElement) {
  root.innerHTML = `<div class="loading">加载帧…</div>`;
  const frames = await api<FrameRow[]>('/api/frames?limit=500');
  const versions = await api<any[]>('/api/dbc/versions');
  const vmap = new Map(versions.map((v) => [v.id, v]));

  root.innerHTML = `
    <div class="toolbar">
      <label>版本视角：
        <select id="vsel">
          <option value="">按采集时点自动选择</option>
          ${versions.map((v) => `<option value="${v.id}">${v.label}</option>`).join('')}
        </select>
      </label>
      <label>过滤：<input id="filter" placeholder="如 256 / 512 / extended" style="width:180px"></label>
      <span class="hint">共 ${frames.length} 帧（最多显示 500）</span>
    </div>
    <div class="split">
      <div class="pane">
        <table class="grid" id="grid">
          <thead><tr><th>#</th><th>硬件时间</th><th>ID</th><th>ch</th><th>gen</th><th>DLC</th><th>消息</th><th>定义版本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="pane detail" id="detail"><div class="placeholder">点击左侧帧查看 bit 布局与信号曲线证据</div></div>
    </div>`;

  const tbody = root.querySelector<HTMLTableSectionElement>('#grid tbody')!;
  const filter = root.querySelector<HTMLInputElement>('#filter')!;
  const vsel = root.querySelector<HTMLSelectElement>('#vsel')!;

  function draw() {
    const q = filter.value.trim().toLowerCase();
    const shown = frames.filter((f) => {
      if (!q) return true;
      return (
        f.arbId.toString(16).includes(q) ||
        f.arbId.toString().includes(q) ||
        (q === 'extended' && f.extended) ||
        (f.messageName ?? '').toLowerCase().includes(q)
      );
    });
    tbody.innerHTML = shown
      .map(
        (f) => `<tr data-id="${f.id}">
          <td>${f.id}</td><td>${fmtNs(f.hwTimeNs)}</td>
          <td class="mono">${fmtId(f.arbId, f.extended)}</td>
          <td>${f.channel ?? '—'}</td><td>${f.generation}</td><td>${f.dlc}</td>
          <td>${f.messageName ? `<span class="tag">${f.messageName}</span>` : '<span class="muted">未解析</span>'}</td>
          <td class="muted">${f.versionLabel ?? '—'}</td>
        </tr>`,
      )
      .join('');
    tbody.querySelectorAll('tr').forEach((tr) =>
      tr.addEventListener('click', () => showFrame(Number(tr.dataset.id))),
    );
  }

  async function showFrame(id: number) {
    const detail = root.querySelector<HTMLElement>('#detail')!;
    detail.innerHTML = `<div class="loading">解码帧 ${id}…</div>`;
    const vid = vsel.value ? Number(vsel.value) : undefined;
    const r = await api<any>(`/api/frames/${id}/decode${vid ? `?versionId=${vid}` : ''}`);
    renderDetail(detail, r, vmap);
  }

  filter.addEventListener('input', draw);
  vsel.addEventListener('change', () => {
    const selected = tbody.querySelector<HTMLTableRowElement>('tr.selected');
    if (selected) void showFrame(Number(selected.dataset.id));
  });
  draw();
}

function renderDetail(el: HTMLElement, r: any, vmap: Map<number, any>) {
  if (!r.resolution?.resolved) {
    el.innerHTML = `<div class="error-box">无法解析：${r.resolution?.reason ?? 'unknown'}
      <div class="hint">帧 ${r.frame.id} · ${fmtId(r.frame.arbId, r.frame.extended)} · ${fmtNs(r.frame.hwTimeNs)} · gen ${r.frame.generation}</div></div>`;
    return;
  }
  const d = r.decoded as DecodedMessage;
  const sigColor = new Map<string, string>();
  const palette = ['#4f9cff', '#ff9f43', '#2ecc71', '#e84393', '#a29bfe', '#00cec9', '#fdcb6e', '#e17055'];
  d.signals.forEach((s, i) => {
    if (s.muxRole === 'branch' && s.unknownBranch) return;
    sigColor.set(s.name, palette[i % palette.length]);
  });

  el.innerHTML = `
    <h3>${d.messageName} <span class="muted">${fmtId(d.arbId, d.extended)}</span></h3>
    <div class="meta">
      版本：<b>${r.resolution.version.label}</b>（${fmtNs(r.resolution.version.startNs)} → ${r.resolution.version.endNs == null ? '∞' : fmtNs(r.resolution.version.endNs)}）
      · 发射节点：${d.transmitter ?? '—'} · 期望 DLC：${d.dlcExpected}
      ${d.byteOrderMixed ? ' · <span class="warn">该消息混用 Intel/Motorola 字节序</span>' : ''}
      ${d.unknownMux ? ' · <span class="warn">多路复用分支未知：保留 raw bits</span>' : ''}
      ${d.truncated ? ' · <span class="warn">帧短于定义 DLC</span>' : ''}
    </div>
    ${bitLayout(r.frame.dataHex, d, sigColor)}
    <h4>信号（每个值可追到 bit 区间）</h4>
    <table class="grid signals">
      <thead><tr><th>信号</th><th>字节序</th><th>缩放/偏置</th><th>raw（bits）</th><th>物理值</th><th>枚举</th><th>bit 区间</th></tr></thead>
      <tbody>${d.signals
        .map((s) => {
          const color = sigColor.get(s.name) ?? '#999';
          const phys = s.value == null ? '—' : `${s.value}${s.unit ? ' ' + s.unit : ''}`;
          return `<tr style="box-shadow: inset 3px 0 0 ${color}">
            <td><b>${s.name}</b>${s.isCounter ? ' <span class="tag2">counter</span>' : ''}${s.isCrc ? ' <span class="tag2">crc</span>' : ''}${s.muxRole === 'switch' ? ' <span class="tag2">mux switch</span>' : ''}${s.unknownBranch ? ' <span class="tag2 warn">未知分支 raw</span>' : ''}</td>
            <td>${s.byteOrder}${s.signed ? '/signed' : ''}</td>
            <td class="mono">×${s.factor} ${s.offset >= 0 ? '+' : '−'}${Math.abs(s.offset)}</td>
            <td class="mono">${s.raw} (0x${(s.raw ?? 0).toString(16)})${s.outOfDlc ? ' <span class="warn">超出 DLC</span>' : ''}</td>
            <td>${phys}</td>
            <td>${s.enumLabel ?? '—'}</td>
            <td class="mono">bit ${s.bitRange.first}–${s.bitRange.last}（共 ${s.bitLength} 位）</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table>
    ${d.muxPayload ? muxBox(d) : ''}
    ${crcBox(r.crc)}
    ${freezeButton(r.frame.id)}`;

  el.querySelector('#freeze')?.addEventListener('click', async () => {
    const name = `调查 #${r.frame.id} @ ${fmtNs(r.frame.hwTimeNs)}`;
    const res = await api('/api/investigations', {
      method: 'POST',
      body: JSON.stringify({ name, frameIds: [r.frame.id] }),
    });
    alert(`已冻结调查 #${res.id}，永久指向版本 ${res.frozenVersionIds.join(', ')}`);
  });
}

function byteCellSpans(dlcsig: unknown) {
  return '';
}

function bitLayout(hex: string, d: DecodedMessage, color: Map<string, string>): string {
  const bytes = hex.replace(/\s/g, '').match(/.{2}/g) ?? [];
  const cellOwner = new Map<number, string>();
  for (const s of d.signals) {
    if (s.unknownBranch) continue;
    for (const c of s.bitCells) if (!cellOwner.has(c)) cellOwner.set(c, s.name);
  }
  const unknownCells = d.muxPayload ? new Set(d.muxPayload.bitCells) : new Set<number>();
  let html = `<div class="bit-layout"><div class="bytes">`;
  bytes.forEach((byte, bi) => {
    html += `<div class="byte"><div class="byte-idx">byte ${bi}</div><div class="bits">`;
    for (let k = 0; k < 8; k++) {
      const linear = bi * 8 + k;
      const owner = cellOwner.get(linear);
      const cls = owner
        ? 'owned'
        : unknownCells.has(linear)
          ? 'mux-unknown'
          : 'gap';
      const style = owner ? `style="background:${color.get(owner)}22;border-color:${color.get(owner)}"` : '';
      html += `<div class="bit ${cls}" ${style} title="linear bit ${linear}${owner ? ' · ' + owner : ''}">${(parseInt(byte, 16) >> (7 - k)) & 1}</div>`;
    }
    html += `</div><div class="byte-hex mono">0x${byte.toUpperCase()}</div></div>`;
  });
  html += `</div><div class="legend">${[...color.entries()].map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('')}<span><i class="unk"></i>未知 mux 分支 raw</span><span><i class="g"></i>空洞</span></div></div>`;
  void byteCellSpans;
  return html;
}

function muxBox(d: DecodedMessage): string {
  const p = d.muxPayload!;
  return `<div class="box warnbox">
    <b>多路复用分支未知</b>：开关信号 <code>${p.switchSignal}</code>=${p.switchRaw}，DBC 未定义该分支。
    保留原始 bit：${p.bitCells.join(', ')}；涉及信号位：${p.signalNames.join(', ')}
  </div>`;
}

function crcBox(crc: any): string {
  if (!crc) return '';
  const cls =
    crc.status === 'pass' ? 'okbox' : crc.status === 'fail' ? 'errbox' : 'neutralbox';
  return `<div class="box ${cls}">
    <b>CRC 证据：${crc.status.toUpperCase()}</b>
    <div class="hint">${crc.reason ?? ''}信号 <code>${crc.rule.signal}</code>
      · 覆盖字节 [${crc.rule.coverStart ?? '?'}, ${crc.rule.coverEnd ?? '?'})
      · init=0x${(crc.rule.init ?? 0).toString(16)} · xor=0x${(crc.rule.xorOut ?? 0).toString(16)}
      ${crc.expected != null ? `· 期望 0x${crc.expected.toString(16)} / 实际 0x${(crc.actual ?? 0).toString(16)}` : '（配置不完整，仅“未核验”）'}</div>
  </div>`;
}

function freezeButton(frameId: number): string {
  return `<button id="freeze" class="primary">将该帧解码冻结为调查快照 (#${frameId})</button>`;
}
