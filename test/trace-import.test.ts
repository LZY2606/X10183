import { describe, expect, it } from 'vitest';
import { parseTraceText, importTrace } from '../server/trace.js';
import { listFramesOrdered } from '../server/repo.js';
import { memDb } from './helpers.js';
import { decodeTimeline } from '../server/decode.js';

describe('trace 解析', () => {
  it('JSON / CSV / ASC 三格式与扩展帧标记', () => {
    const json = parseTraceText(
      JSON.stringify([
        { channel: 1, arbId: 100, hwTime: 0.1, data: [1, 2] },
        { channel: 2, arbId: 0x18ff0001, extended: true, hwTime: 0.2, data: 'AABB' }
      ])
    );
    expect(json[0].data).toEqual([1, 2]);
    expect(json[1].extended).toBe(true);

    const csv = parseTraceText('hw_time,channel,arb_id,extended,data\n0.5,1,100,0,0102\n0.6,1,419364865,1,aa bb');
    expect(csv[1].arbId).toBe(0x18ff0001);
    expect(csv[1].extended).toBe(true);
    expect(csv[1].data).toEqual([0xaa, 0xbb]);

    const asc = parseTraceText('   0.123456 1  064 Rx d 8 01 02 03 04 05 06 07 08\n   0.5 2  18FF0001x Rx d 2 AA BB\n');
    expect(asc[0].data).toHaveLength(8);
    expect(asc[1].extended).toBe(true);
    expect(asc[1].arbId).toBe(0x18ff0001);
  });
});

describe('导入顺序无关性', () => {
  it('乱序导入（不同代次）后解码结果与有序导入一致', () => {
    const ordered = memDb();
    importTrace(ordered, 'a', [
      { channel: 1, arbId: 100, extended: false, hwTime: 0.1, data: [1] },
      { channel: 1, arbId: 100, extended: false, hwTime: 0.2, data: [2] }
    ]);
    importTrace(ordered, 'b', [
      { channel: 1, arbId: 100, extended: false, hwTime: 0.3, data: [3] }
    ]);

    const shuffled = memDb();
    importTrace(shuffled, 'b-first', [
      { channel: 1, arbId: 100, extended: false, hwTime: 0.3, data: [3] }
    ]);
    importTrace(shuffled, 'a-second', [
      { channel: 1, arbId: 100, extended: false, hwTime: 0.2, data: [2] },
      { channel: 1, arbId: 100, extended: false, hwTime: 0.1, data: [1] }
    ]);

    const canon = (db: ReturnType<typeof memDb>) =>
      decodeTimeline(db, { limit: 100 }).map((d) => ({
        t: d.frame.hwTime,
        ch: d.frame.channel,
        id: d.frame.arbId,
        ext: d.frame.extended,
        data: d.frame.data,
        dbc: d.dbcId,
        msg: d.messageDefId,
        sigs: d.signals.map((s) => [s.name, s.raw, s.physical, s.active])
      }));

    expect(canon(shuffled)).toEqual(canon(ordered));
    expect(listFramesOrdered(shuffled).map((f) => f.hwTime)).toEqual([0.1, 0.2, 0.3]);
    expect(listFramesOrdered(shuffled).map((f) => f.importGen)).toEqual([2, 2, 1]);
  });

  it('重复时间戳仍有确定性顺序（通道/id/数据/主键兜底）', () => {
    const db = memDb();
    importTrace(db, 'g', [
      { channel: 1, arbId: 200, extended: false, hwTime: 1, data: [9] },
      { channel: 1, arbId: 100, extended: false, hwTime: 1, data: [1] },
      { channel: 0, arbId: 100, extended: false, hwTime: 1, data: [0] }
    ]);
    const ids = listFramesOrdered(db).map((f) => `${f.channel}:${f.arbId}:${f.data[0]}`);
    expect(ids).toEqual(['0:100:0', '1:100:1', '1:200:9']);
  });
});
