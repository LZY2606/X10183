import { el, fmtId, fmtTime, toast } from './dom.js';
import { api } from '../api.js';
import type { CounterEvent } from '../types.js';
import type { ViewContext } from './app.js';

const TAG: Record<CounterEvent['event'], string> = {
  ok: 'tag ok',
  wrap: 'tag pass',
  duplicate: 'tag warn',
  gap: 'tag fail'
};
const LABEL: Record<CounterEvent['event'], string> = {
  ok: '正常',
  wrap: '环绕',
  duplicate: '重复',
  gap: '缺帧'
};

export function countersView(ctx: ViewContext): HTMLElement {
  void ctx;
  const root = el('div', { class: 'card' });
  root.append(el('h2', {}, '计数器缺口（按节点 × 采集代次）'));
  const host = el('div', { class: 'muted small' }, '分析中…');
  root.append(host);

  api
    .get<CounterEvent[]>('/api/counters')
    .then((events) => {
      host.replaceChildren();
      if (!events.length) {
        host.append('未配置计数器规则。演示数据已在 动力-v2 中配置 EngineCounter（ECU，4bit）。');
        return;
      }
      const summary = el('div', { class: 'pill-row' });
      for (const ev of ['ok', 'wrap', 'duplicate', 'gap'] as const) {
        const c = events.filter((e) => e.event === ev).length;
        summary.append(el('span', { class: `tag ${TAG[ev]}` }, `${LABEL[ev]} ${c}`));
      }
      const gens = [...new Set(events.map((e) => e.importGen))].sort((a, b) => a - b);
      summary.append(el('span', { class: 'muted small' }, `采集代次：${gens.join(', ')}`));
      host.append(summary);

      const table = el('table');
      table.append(
        el('thead', {}, el('tr', {}, ...['时间', '通道', 'ID', '代次', '节点', '信号', 'raw', '期望', '事件', '说明'].map((h) => el('th', {}, h))))
      );
      const body = el('tbody');
      for (const e of events) {
        body.append(
          el(
            'tr',
            {},
            el('td', { class: 'mono' }, fmtTime(e.hwTime)),
            el('td', {}, String(e.channel)),
            el('td', { class: 'mono' }, fmtId(e.arbId, false)),
            el('td', {}, String(e.importGen)),
            el('td', {}, e.node),
            el('td', { class: 'mono' }, e.signalName),
            el('td', { class: 'mono' }, e.raw === null ? '—' : String(e.raw)),
            el('td', { class: 'mono' }, e.expected === null ? '—' : String(e.expected)),
            el('td', {}, el('span', { class: TAG[e.event] }, LABEL[e.event])),
            el('td', { class: 'small muted' }, e.detail)
          )
        );
      }
      table.append(body);
      host.append(el('div', { style: 'max-height:60vh;overflow:auto;margin-top:8px' }, table));
    })
    .catch((err: Error) => toast(err.message, 'error'));

  return root;
}
