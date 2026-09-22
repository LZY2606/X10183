import { el, toast } from './dom.js';
import { api } from '../api.js';
import type { ViewContext } from './app.js';

const SAMPLE = `[
  {"channel":1,"arbId":300,"extended":false,"hwTime":0.10,"data":[1,0,100,0,0,0,0,0]},
  {"channel":1,"arbId":300,"extended":false,"hwTime":0.60,"data":[2,0,104,0,0,0,0,0]},
  {"channel":2,"arbId":402225153,"extended":true,"hwTime":1.20,"data":[170,187,0,0,0,0,0,0]}
]`;

export function importView(ctx: ViewContext): HTMLElement {
  const traceArea = el('textarea', { placeholder: 'JSON 数组 / CSV(id,hw_time,data,...) / Vector ASC 文本' }, SAMPLE);
  const nameInput = el('input', { value: `采集-${new Date().toISOString().slice(0, 19)}`, style: 'width:240px' });

  const dbcLabel = el('input', { placeholder: '版本标签，如 动力-v3', style: 'width:160px' });
  const fromInput = el('input', { type: 'number', step: '0.001', placeholder: '生效起(null)' , style: 'width:130px' });
  const toInput = el('input', { type: 'number', step: '0.001', placeholder: '生效止(null)', style: 'width:130px' });
  const dbcArea = el('textarea', {
    placeholder: '粘贴 DBC（BO_ / SG_ / VAL_）'
  }, `BO_ 300 SampleMsg: 8 ECU
 SG_ Counter : 0|8@1+ (1,0) [0|255] "" ECU
 SG_ Temperature : 8|16@1- (1,-40) [-40|215] "degC" ECU
 SG_ Mode : 24|2@1+ (1,0) [0|3] "" ECU
VAL_ 300 Mode 0 "Sleep" 1 "Wake" 2 "Run" 3 "Limp" ;
`);

  async function importTrace(): Promise<void> {
    try {
      await api.post('/api/trace/import', { name: nameInput.value || '未命名采集', text: traceArea.value });
      toast('trace 导入完成（原始帧、通道、硬件时间、采集代次已保存）');
      await ctx.refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function importDbc(): Promise<void> {
    try {
      await api.post('/api/dbc', {
        label: dbcLabel.value,
        source: dbcArea.value,
        effectiveFrom: fromInput.value === '' ? null : Number(fromInput.value),
        effectiveTo: toInput.value === '' ? null : Number(toInput.value)
      });
      toast('DBC 版本已保存（含半开生效区间）');
      await ctx.refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function seed(): Promise<void> {
    try {
      await api.post('/api/seed', {});
      toast('演示数据已载入：两版 DBC、两个采集代次、计数器/CRC/mux/扩展帧');
      await ctx.refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return el(
    'div',
    { class: 'grid cols-2' },
    el(
      'div',
      { class: 'card' },
      el('h2', {}, '导入 CAN trace'),
      el('div', { class: 'row', style: 'margin-bottom:8px' }, nameInput),
      traceArea,
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'btn', onclick: importTrace }, '导入 trace'),
        el('button', { class: 'btn ghost', onclick: seed }, '载入演示数据'),
        el('span', { class: 'muted small' }, '导入顺序不影响结果：内部按 (hw_time, 通道, ID, 帧类型, 数据) 确定性重放')
      )
    ),
    el(
      'div',
      { class: 'card' },
      el('h2', {}, '导入 DBC 版本'),
      el('div', { class: 'row', style: 'margin-bottom:8px' }, dbcLabel, fromInput, toInput),
      dbcArea,
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'btn', onclick: importDbc }, '保存 DBC 版本'),
        el('span', { class: 'muted small' }, '生效区间为 [from, to)；同一 arbitration id 的标准帧与扩展帧分别定义')
      )
    )
  );
}
