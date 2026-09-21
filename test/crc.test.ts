import { describe, it, expect } from 'vitest';
import { checkCrcConfig, crc8 } from '../src/shared/crc.js';
import { counterReports, crcReports } from '../src/server/analysis.js';
import { createVersion } from '../src/server/versions.js';
import { importFrames } from '../src/server/frames.js';
import { redecodeAll } from '../src/server/decode.js';
import { msg, s, tempDb, versionInput } from './helpers.js';

function engineMessages(crc: ReturnType<typeof s>['crc']) {
  return msg({
    arbId: 0x100,
    name: 'Engine',
    sender: 'ECM',
    signals: [
      s({ name: 'Cnt', startBit: 32, length: 4, byteOrder: 1, role: 'counter' }),
      s({ name: 'Crc', startBit: 40, length: 8, byteOrder: 1, role: 'crc', crc: crc ?? undefined })
    ]
  });
}

describe('CRC8 规则', () => {
  it('配置不完整时只能“未核验”，不能报通过', () => {
    expect(checkCrcConfig(null).ok).toBe(false);
    expect(checkCrcConfig({ startByte: 0, endByte: 5, polynomial: 0x07, init: null, xorOut: 0 })).toMatchObject({ ok: false });
    expect(checkCrcConfig({ startByte: 0, endByte: 5, polynomial: 0x07, init: 0xff, xorOut: null })).toMatchObject({ ok: false });
    expect(checkCrcConfig({ startByte: 3, endByte: 3, polynomial: 0x07, init: 0, xorOut: 0 })).toMatchObject({ ok: false });
  });

  it('初值与异或值可配置且改变结果', () => {
    const data = Uint8Array.from([0x3c, 0x1f, 0x40, 0x63, 0x00, 0x00, 0, 0]);
    const c1 = checkCrcConfig({ startByte: 0, endByte: 5, polynomial: 0x07, init: 0xff, xorOut: 0 }) as any;
    const c2 = checkCrcConfig({ startByte: 0, endByte: 5, polynomial: 0x07, init: 0x00, xorOut: 0xff }) as any;
    expect(c1.ok).toBe(true);
    expect(crc8(data, c1.config)).not.toBe(crc8(data, c2.config));
  });

  it('覆盖范围边界：CRC 字节本身不纳入覆盖时通过；扩大一个字节后结果不同', () => {
    const data = Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0x00, 0x55, 0, 0]);
    const c = checkCrcConfig({ startByte: 0, endByte: 5, polynomial: 0x07, init: 0, xorOut: 0 }) as any;
    const value = crc8(data, c.config);
    data[5] = value;
    expect(crc8(data, c.config)).toBe(value);
    const cExt = checkCrcConfig({ startByte: 0, endByte: 6, polynomial: 0x07, init: 0, xorOut: 0 }) as any;
    expect(crc8(data, cExt.config)).not.toBe(value);
  });
});

describe('CRC 报告（服务层）', () => {
  it('覆盖越 DLC => invalid；配置缺失 => unchecked；错误值 => fail', () => {
    const db = tempDb();
    const complete = { startByte: 0, endByte: 5, polynomial: 0x07, init: 0xff, xorOut: 0 };
    createVersion(db, versionInput('v1', [engineMessages(complete)]));
    importFrames(db, [
      { arbId: 0x100, idKind: 'std', data: [0x10, 0, 0, 0, 0, 0x00, 0, 0], dlc: 8, hwTimeNs: 0 },
      { arbId: 0x100, idKind: 'std', data: [0x10, 0, 0, 0, 0, 0x01, 0, 0], dlc: 4, hwTimeNs: 1_000 }
    ]);
    redecodeAll();
    const [report] = crcReports(db);
    expect(report.complete).toBe(true);
    expect(report.results[0].status).toBe('fail');
    expect(report.results[1].status).toBe('invalid');
  });

  it('规则未配置 => 全部 unchecked，即使帧数据巧合为 0', () => {
    const db = tempDb();
    createVersion(db, versionInput('v1', [engineMessages(null)]));
    importFrames(db, [
      { arbId: 0x100, idKind: 'std', data: [0, 0, 0, 0, 0, 0, 0, 0], dlc: 8, hwTimeNs: 0 }
    ]);
    redecodeAll();
    const [report] = crcReports(db);
    expect(report.complete).toBe(false);
    expect(report.results[0].status).toBe('unchecked');
  });
});

describe('计数器（服务层）', () => {
  function setup(counterValues: number[], timestampsNs: number[]) {
    const db = tempDb();
    createVersion(db, versionInput('v1', [
      msg({
        arbId: 0x100, name: 'Engine', sender: 'ECM',
        signals: [s({ name: 'Cnt', startBit: 32, length: 4, byteOrder: 1, role: 'counter' })]
      })
    ]));
    importFrames(db, counterValues.map((cnt, i) => ({
      arbId: 0x100, idKind: 'std' as const,
      data: [0, 0, 0, 0, (cnt & 0xf) << 4, 0, 0, 0],
      dlc: 8,
      hwTimeNs: timestampsNs[i]
    })));
    redecodeAll();
    return db;
  }

  it('识别环绕(15->0)、重复(1->1)、缺帧(3->6)，首帧 init', () => {
    const db = setup([14, 15, 0, 1, 1, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6, 7]);
    const [report] = counterReports(db);
    const kinds = report.events.map((e) => e.kind);
    expect(kinds).toEqual(['init', 'wrap', 'repeat', 'missing']);
    const missing = report.events.find((e) => e.kind === 'missing')!;
    expect(missing.gapCount).toBe(1);
    expect(missing.expected).toBe(2);
    expect(missing.actual).toBe(3);
  });

  it('重复时间戳在不同导入顺序下事件一致', () => {
    const values = [0, 1, 1, 2];
    const ts = [5, 5, 5, 6];
    const kindsA = counterReports(setup(values, ts))[0].events.map((e) => `${e.kind}:${e.actual}`);
    const rev = [...values].reverse();
    const kindsB = counterReports(setup(rev, [...ts].reverse()))[0]
      .events.map((e) => `${e.kind}:${e.actual}`);
    // 两组输入仅顺序不同，但相同逻辑序列 => 结果序列一致
    expect(kindsA).toEqual(kindsB);
  });

  it('按采集代次分别检查', () => {
    const db = tempDb();
    createVersion(db, versionInput('v1', [
      msg({ arbId: 0x100, name: 'Engine', sender: 'ECM', signals: [
        s({ name: 'Cnt', startBit: 32, length: 4, byteOrder: 1, role: 'counter' })
      ] })
    ]));
    const frame = (cnt: number, t: number) => ({
      arbId: 0x100, idKind: 'std' as const, data: [0, 0, 0, 0, cnt << 4, 0, 0, 0], dlc: 8, hwTimeNs: t
    });
    importFrames(db, [frame(5, 0), frame(6, 1)], 'G1');
    importFrames(db, [frame(9, 2), frame(10, 3)], 'G2');
    redecodeAll();
    const all = counterReports(db)[0];
    // 不按代次过滤时跨代连续检查会出现一次 missing
    expect(all.events.some((e) => e.kind === 'missing' && e.gapCount === 2)).toBe(true);
    const g1 = counterReports(db, { generation: 1 })[0];
    const g2 = counterReports(db, { generation: 2 })[0];
    expect(g1.events.map((e) => e.kind)).toEqual(['init']);
    expect(g2.events.map((e) => e.kind)).toEqual(['init']);
  });
});
