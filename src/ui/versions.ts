import { el, toast } from './dom.js';
import { api } from '../api.js';
import type { ViewContext } from './app.js';

export function versionsView(ctx: ViewContext): HTMLElement {
  const root = el('div', { class: 'grid' });
  if (!ctx.state.dbcs.length) {
    root.append(el('div', { class: 'card muted' }, '还没有 DBC 版本。到“导入”页保存 DBC 或载入演示数据。'));
    return root;
  }

  for (const v of ctx.state.dbcs) {
    const from = el('input', { type: 'number', step: '0.001', value: v.effectiveFrom ?? '', style: 'width:120px' });
    const to = el('input', { type: 'number', step: '0.001', value: v.effectiveTo ?? '', style: 'width:120px' });

    const msgRows = v.messages
      .map(
        (m) =>
          el(
            'tr',
            {},
            el('td', { class: 'mono' }, `0x${m.arbId.toString(16).toUpperCase()}`),
            el('td', {}, el('span', { class: `tag ${m.extended ? 'ext' : 'std'}` }, m.extended ? '扩展' : '标准')),
            el('td', { class: 'mono' }, m.name),
            el('td', {}, `${m.dlc}B`),
            el('td', {}, m.transmitter || '—'),
            el('td', { class: 'small muted' }, m.signals.map((s) => s.name).join(', '))
          )
      );

    const table = el(
      'table',
      {},
      el('thead', {}, el('tr', {}, ...['arbitration id', '帧类型', '消息', 'DLC', '发送节点', '信号'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...msgRows)
    );

    root.append(
      el(
        'div',
        { class: 'card' },
        el(
          'div',
          { class: 'row' },
          el('h2', { style: 'margin:0' }, v.label),
          el('span', { class: 'badge' }, `版本号 ${(v as unknown as { version?: number }).version ?? ''}`),
          el('span', { class: 'muted small' }, `#${v.id} · 生效 [${v.effectiveFrom ?? '−∞'}, ${v.effectiveTo ?? '+∞'})`)
        ),
        table,
        el('h3', {}, '修订生效区间（乐观并发：携带版本号，冲突即拒绝）'),
        el(
          'div',
          { class: 'row' },
          el('label', { class: 'inline' }, 'from', from),
          el('label', { class: 'inline' }, 'to', to),
          el(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                try {
                  await api.patch(`/api/dbc/${v.id}`, {
                    effectiveFrom: from.value === '' ? null : Number(from.value),
                    effectiveTo: to.value === '' ? null : Number(to.value),
                    expectedVersion: await fetchVersion(v.id)
                  });
                  toast('区间已修订；仅受影响时点的解码被标记为过期');
                  await ctx.refresh();
                } catch (err) {
                  toast((err as Error).message, 'error');
                  await ctx.refresh();
                }
              }
            },
            '保存修订'
          ),
          el('span', { class: 'muted small' }, '修订后冻结的调查快照仍指向旧定义；过期解码在重新打开帧时重算')
        )
      )
    );
  }
  return root;
}

async function fetchVersion(id: number): Promise<number> {
  const list = await api.get<unknown[]>('/api/dbc');
  const v = (list as { id: number; version?: number }[]).find((x) => x.id === id);
  return v?.version ?? 1;
}
