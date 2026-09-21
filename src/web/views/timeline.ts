import { api, type AppState, type DecodeResult, type TimelineEntry } from '../api.js';
import { badge, clear, fmtBytes, fmtHex, fmtNum, fmtTime, h } from '../dom.js';

const SIG_COLORS = ['#4da3ff', '#3ecf8e', '#f5b942', '#ff8fa3', '#b78bff', '#5ad1d1', '#ff9f5a', '#9fd356'];

export function timelineView(state: AppState): HTMLElement {
  const root = h('div');
  const genOptions = ['', ...state.generations.map((g) => g.name)];
  const genSel = h('select', {}, ...genOptions.map((g) => h('option', { value: g, text: g || '全部代次' })));
  const keyInput = h('input', { placeholder: '消息键 如 256:standard', style: 'width:170px' });
  const limitInput = h('input', { type: 'number', value: 200, style: 'width:80px' });
  const listPanel = h('div', { class: 'panel' });
  const detailPanel = h('div', { class: 'panel' }, h('span', { class: 'muted', text: '点击左侧帧查看解码详情' }));

  async function load(): Promise<void> {
    clear(listPanel);
    listPanel.append(h('h2', { text: '帧时间轴' }));
    try {
      const entries = await api.timeline({
        generation: genSel.value || undefined,
        key: keyInput.value || undefined,
        limit: Number(limitInput.value) || 200,
      });
      listPanel.append(renderTable(entries));
    } catch (e) {
      listPanel.append(h('div', { class: 'err', text: String(e) }));
    }
  }

  function renderTable(entries: TimelineEntry[]): HTMLElement {
    const table = h('table');
    table.append(
      h('tr', {},
        h('th', { text: '硬件时间' }), h('th', { text: 'ID' }), h('th', { text: '类型' }),
        h('th', { text: '通道' }), h('th', { text: '代次' }), h('th', { text: '节点' }),
        h('th', { text: '数据' }), h('th', { text: '消息' }), h('th', { text: 'DBC 版本' }),
      )
    );
    for (const e of entries) {
      const tr = h(
        'tr',
        { class: 'clickable', onclick: () => { select(tr); showDetail(e); } },
        h('td', { class: 'mono', text: fmtTime(e.hwTimeMs) }),
        h('td', { class: 'mono', text: fmtHex(e.arbId, e.idKind === 'extended' ? 8 : 3) }),
        h('td', { text: e.idKind === 'extended' ? '扩展' : '标准' }),
        h('td', { text: e.channel }),
        h('td', { text: e.generation }),
        h('td', { text: e.txNode ?? '—' }),
        h('td', { class: 'mono', text: fmtBytes(e.data) }),
        h('td', { text: e.decode.matched ? (e.decode.messageName ?? '') : '(未定义)' }),
        h('td', {}, e.decode.revisionLabel
          ? badge(`${e.decode.revisionLabel}#${e.decode.revisionNumber}`, 'info')
          : h('span', { class: 'muted', text: '—' })),
      );
      table.append(tr);
    }
    return h('div', { class: 'scroll-x' }, table);
  }

  function select(tr: HTMLElement): void {
    root.querySelectorAll('tr.selected').forEach((el) => el.classList.remove('selected'));
    tr.classList.add('selected');
  }

  async function showDetail(entry: TimelineEntry): Promise<void> {
    clear(detailPanel);
    detailPanel.append(h('h2', { text: `帧 #${entry.id} 解码` }));
    let decode: DecodeResult = entry.decode;
    let stale = false;
    try {
      const resp = await api.decodeFrame(entry.id);
      decode = resp.result;
      stale = resp.stale;
    } catch { /* 使用时间轴内联结果 */ }

    const head = h('dl', { class: 'kv' },
      h('dt', { text: 'Arbitration ID' }), h('dd', { text: `${fmtHex(entry.arbId, entry.idKind === 'extended' ? 8 : 3)} (${entry.idKind === 'extended' ? '扩展帧' : '标准帧'})` }),
      h('dt', { text: '硬件时间' }), h('dd', { text: fmtTime(entry.hwTimeMs) }),
      h('dt', { text: '通道 / 代次 / 节点' }), h('dd', { text: `${entry.channel} / ${entry.generation} / ${entry.txNode ?? '—'}` }),
      h('dt', { text: '原始数据' }), h('dd', { text: fmtBytes(entry.data) }),
    );
    detailPanel.append(head);

    if (!decode.matched) {
      detailPanel.append(h('p', {}, badge('未匹配', 'warn'), ` 没有适用于该时点的消息定义（${decode.reason}）`));
      return;
    }
    detailPanel.append(h('p', {},
      badge(`采用定义 ${decode.revisionLabel}#${decode.revisionNumber}`, 'info'),
      stale ? badge(' 已过期（存在更新版本）', 'warn') : '',
      ` 消息 ${decode.messageName}`,
      decode.muxSwitchValue !== undefined ? ` mux=${decode.muxSwitchValue}` : '',
    ));

    detailPanel.append(bitGrid(entry.data, decode));
    detailPanel.append(signalTable(decode));
    if (decode.undecoded.length) detailPanel.append(undecodedBlock(decode));
  }

  function bitGrid(data: number[], decode: DecodeResult): HTMLElement {
    const wrap = h('div');
    wrap.append(h('h3', { text: 'Bit 布局（列 = 字节内 bit 7..0）' }));
    const owners = new Map<string, number>(); // "byte:bit" -> 信号序号
    decode.signals.forEach((s, i) => s.bitTrace.forEach((c) => owners.set(`${c.byteIndex}:${c.bitInByte}`, i)));
    decode.undecoded.forEach((u, i) => u.bitTrace.forEach((c) => {
      const k = `${c.byteIndex}:${c.bitInByte}`;
      if (!owners.has(k)) owners.set(k, decode.signals.length + i);
    }));

    const grid = h('div', { class: 'bitgrid' });
    const header = h('div', { class: 'bitrow' }, h('div', { class: 'bitcell', text: '' }));
    for (let bit = 7; bit >= 0; bit--) header.append(h('div', { class: 'bitcell', text: String(bit) }));
    grid.append(header);
    for (let byte = 0; byte < Math.max(data.length, 1); byte++) {
      const row = h('div', { class: 'bitrow' }, h('div', { class: 'bitcell', text: `B${byte}` }));
      for (let bit = 7; bit >= 0; bit--) {
        const owner = owners.get(`${byte}:${bit}`);
        const val = ((data[byte] ?? 0) >> bit) & 1;
        const cell = h('div', { class: 'bitcell', text: String(val) });
        if (owner !== undefined) {
          cell.classList.add('sig');
          cell.style.background = SIG_COLORS[owner % SIG_COLORS.length];
        }
        row.append(cell);
      }
      grid.append(row);
    }
    wrap.append(grid);

    const legend = h('div', { class: 'bit-legend' });
    decode.signals.forEach((s, i) => {
      legend.append(h('span', {},
        h('span', { class: 'sw', style: `background:${SIG_COLORS[i % SIG_COLORS.length]}` }),
        `${s.name} [${s.startBit}|${s.length}]`));
    });
    decode.undecoded.forEach((u, i) => {
      legend.append(h('span', {},
        h('span', { class: 'sw', style: `background:${SIG_COLORS[(decode.signals.length + i) % SIG_COLORS.length]}` }),
        `${u.name} (raw)`));
    });
    wrap.append(legend);
    return wrap;
  }

  function signalTable(decode: DecodeResult): HTMLElement {
    const table = h('table');
    table.append(h('tr', {},
      h('th', { text: '信号' }), h('th', { text: '原始值' }), h('th', { text: '物理值' }),
      h('th', { text: '枚举' }), h('th', { text: '缩放/偏置' }), h('th', { text: '字节序' }),
      h('th', { text: 'bit 区间' }), h('th', { text: 'mux' }),
    ));
    for (const s of decode.signals) {
      const wires = s.bitTrace.map((c) => c.wireBit);
      table.append(h('tr', {},
        h('td', { text: s.name }),
        h('td', { class: 'mono', text: String(s.raw) }),
        h('td', { class: 'mono', text: `${fmtNum(s.physical)}${s.unit ? ' ' + s.unit : ''}` }),
        h('td', { text: s.enumLabel ?? '—' }),
        h('td', { class: 'mono', text: `×${s.factor} +${s.offset}${s.signed ? ' (有符号)' : ''}` }),
        h('td', { text: s.byteOrder === 'motorola' ? 'Motorola' : 'Intel' }),
        h('td', { class: 'mono', text: `start ${s.startBit}, len ${s.length} → wire ${Math.min(...wires)}..${Math.max(...wires)}` }),
        h('td', { text: s.muxRole === 'switch' ? 'switch' : s.muxBranch !== undefined ? `m${s.muxBranch}` : '—' }),
      ));
    }
    return h('div', { class: 'scroll-x' }, table);
  }

  function undecodedBlock(decode: DecodeResult): HTMLElement {
    const box = h('div');
    box.append(h('h3', { text: '未解码信号（mux 分支未知，保留 raw bits）' }));
    for (const u of decode.undecoded) {
      box.append(h('div', { class: 'mono', text: `${u.name} [${u.startBit}|${u.length}] ${u.byteOrder} raw=${u.rawBits.join('')}` }));
    }
    return box;
  }

  root.append(
    h('div', { class: 'panel' },
      h('div', { class: 'form-row' },
        h('label', {}, '代次 ', genSel),
        h('label', {}, '消息键 ', keyInput),
        h('label', {}, '条数 ', limitInput),
        h('button', { class: 'primary', text: '刷新', onclick: () => void load() }),
      ),
    ),
    h('div', { class: 'split' }, h('div', {}, listPanel), h('div', {}, detailPanel)),
  );
  void load();
  return root;
}
