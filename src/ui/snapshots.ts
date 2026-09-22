import { el, fmtId, fmtTime, toast } from './dom.js';
import { api } from '../api.js';
import { bitGrid } from './bitgrid.js';
import type { ViewContext } from './app.js';

interface SnapshotListItem {
  id: number;
  title: string;
  note: string;
  createdAt: string;
  frameCount: number;
}

interface SnapshotDetail extends SnapshotListItem {
  payload: Array<{
    frameId: number;
    arbId: number;
    extended: boolean;
    hwTime: number;
    channel: number;
    dataHex: string;
    dbcId: number | null;
    dbcLabel: string | null;
    messageName: string | null;
    signals: Array<{
      name: string;
      active: boolean;
      reason?: string;
      raw: number | null;
      rawBits: string;
      bitCells: number[];
      physical: number | null;
      enumLabel: string | null;
      muxType: string;
      byteOrder: 'intel' | 'motorola';
      startBit?: number;
      length?: number;
    }>;
  }>;
}

export function snapshotsView(ctx: ViewContext): HTMLElement {
  const root = el('div', { class: 'grid' });
  const title = el('input', { value: `调查快照-${new Date().toISOString().slice(0, 19)}`, style: 'width:260px' });
  const note = el('input', { placeholder: '说明（可选）', style: 'flex:1;min-width:180px' });
  const listHost = el('div');

  async function refreshList(): Promise<void> {
    const items = await api.get<SnapshotListItem[]>('/api/snapshots');
    listHost.replaceChildren();
    for (const item of items) {
      listHost.append(el(
        'div',
        { class: 'card', style: 'margin-top:10px' },
        el('div', { class: 'row' },
          el('strong', {}, item.title),
          el('span', { class: 'badge' }, `${item.frameCount} 帧`),
          el('span', { class: 'muted small' }, item.createdAt),
          el('button', {
            class: 'btn ghost',
            onclick: () => openSnapshot(item.id).catch((e) => toast(e.message, 'error'))
          }, '展开冻结内容')
        ),
        item.note ? el('div', { class: 'muted small' }, item.note) : null
      ));
    }
  }

  async function openSnapshot(id: number): Promise<void> {
    const snap = await api.get<SnapshotDetail>(`/api/snapshots/${id}`);
    const first = snap.payload[0];
    if (!first) return;
    const signals = first.signals.map((s) => ({
      signalDefId: 0,
      name: s.name,
      startBit: s.startBit ?? s.bitCells[0] ?? 0,
      length: s.length ?? s.bitCells.length,
      byteOrder: s.byteOrder,
      signed: false,
      scale: 1,
      offset: 0,
      unit: '',
      muxType: s.muxType as never,
      muxSwitch: null,
      active: s.active,
      reason: s.reason,
      raw: s.raw,
      rawBits: s.rawBits,
      bitCells: s.bitCells,
      physical: s.physical,
      enumLabel: s.enumLabel
    }));
    const win = el('div', { class: 'card' },
      el('h2', {}, `快照冻结内容 · 首帧 ${fmtId(first.arbId, first.extended)} @ ${fmtTime(first.hwTime)}s`),
      el('div', { class: 'muted small' }, `定义指针：${first.dbcLabel ?? '无 DBC'}；即使之后修订生效区间，以下 raw bits 与解码值不变。`),
      bitGrid(signals as never, first.dataHex.length / 2 || 8),
      el('h3', {}, '冻结解码表'),
      (() => {
        const table = el('table');
        table.append(el('thead', {}, el('tr', {}, ...['时间', 'DBC', '消息', '信号', 'raw bits', '物理值'].map((h) => el('th', {}, h)))));
        const body = el('tbody');
        for (const fr of snap.payload.slice(0, 50)) {
          for (const s of fr.signals) {
            body.append(el('tr', {},
              el('td', { class: 'mono' }, fmtTime(fr.hwTime)),
              el('td', {}, fr.dbcLabel ?? '—'),
              el('td', {}, fr.messageName ?? '未解码'),
              el('td', { class: 'mono' }, s.name),
              el('td', {}, el('span', { class: 'bits-string' }, s.rawBits)),
              el('td', { class: 'mono' }, s.physical === null ? '—' : String(s.physical))
            ));
          }
        }
        table.append(body);
        return table;
      })()
    );
    listHost.append(win);
  }

  root.append(
    el('div', { class: 'card' },
      el('h2', {}, '冻结调查快照'),
      el('div', { class: 'row' }, title, note,
        el('button', {
          class: 'btn',
          onclick: async () => {
            try {
              await api.post('/api/snapshots', { title: title.value, note: note.value });
              toast('快照已冻结');
              await refreshList();
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }
        }, '生成快照')
      )
    ),
    listHost
  );
  void refreshList().catch((e) => toast(e.message, 'error'));
  return root;
}
