import { el, fmtId, fmtTime, toast } from './dom.js';
import { api } from '../api.js';
import type { CrcEvidence } from '../types.js';
import type { ViewContext } from './app.js';

export function checksumsView(ctx: ViewContext): HTMLElement {
  void ctx;
  const root = el('div', { class: 'card' });
  root.append(el('h2', {}, 'CRC / 校验和证据'));
  root.append(el('div', { class: 'muted small', style: 'margin-bottom:8px' }, '覆盖范围、初值、输入/输出异或均可配置；配置不完整或超出 DLC 时只能给出“未核验”，不会报通过。'));
  const host = el('div', { class: 'muted small' }, '分析中…');
  root.append(host);

  api
    .get<CrcEvidence[]>('/api/checksums')
    .then((evs) => {
      host.replaceChildren();
      if (!evs.length) {
        host.append('未配置校验规则。演示数据的 EngineCRC 覆盖 byte 0..5，init=0xFF，xorIn/xorOut=0。');
        return;
      }
      const counts = { pass: 0, fail: 0, unchecked: 0 };
      for (const e of evs) counts[e.status]++;
      host.append(
        el('div', { class: 'pill-row' },
          el('span', { class: 'tag pass' }, `通过 ${counts.pass}`),
          el('span', { class: 'tag fail' }, `失败 ${counts.fail}`),
          el('span', { class: 'tag unchecked' }, `未核验 ${counts.unchecked}`)
        )
      );
      const table = el('table');
      table.append(
        el('thead', {}, el('tr', {},
          ...['时间', '代次', '节点', 'ID', '信号', '算法', '覆盖 byte', 'init/xor', '期望', '实际', '结论', '证据'].map((h) => el('th', {}, h))))
      );
      const body = el('tbody');
      for (const e of evs) {
        body.append(
          el(
            'tr',
            {},
            el('td', { class: 'mono' }, fmtTime(e.hwTime)),
            el('td', {}, String(e.importGen)),
            el('td', {}, e.node),
            el('td', { class: 'mono' }, fmtId(e.arbId, false)),
            el('td', { class: 'mono' }, e.signalName),
            el('td', {}, e.algorithm),
            el('td', { class: 'mono' }, e.configured ? `${e.startByte}..${e.endByte}` : '—'),
            el('td', { class: 'mono' }, e.configured ? `${e.init}/${e.xorIn}/${e.xorOut}` : '—'),
            el('td', { class: 'mono' }, e.expected === null ? '—' : `0x${e.expected.toString(16).padStart(2, '0')}`),
            el('td', { class: 'mono' }, e.actual === null ? '—' : `0x${e.actual.toString(16).padStart(2, '0')}`),
            el('td', {}, el('span', { class: `tag ${e.status === 'pass' ? 'pass' : e.status === 'fail' ? 'fail' : 'unchecked'}` },
              e.status === 'pass' ? '通过' : e.status === 'fail' ? '失败' : '未核验')),
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
