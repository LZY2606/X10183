import { describe, expect, it } from 'vitest';
import { computeCrc, missingCrcConfig, verifyCrc } from '../src/core/crc.js';
import { checkCounter } from '../src/core/counters.js';
import type { CrcRule, DbcVersion, DecodedFrame, MessageDef, RawFrame } from '../src/core/types.js';

const dbc: DbcVersion = { id: 1, label: 'v', effectiveFrom: null, effectiveTo: null, createdAt: 1, notes: null };
const message: MessageDef = {
  id: 1, dbcId: 1, canId: 1, isExtended: false, name: 'M', dlc: 8, transmitter: 'N',
  signals: [
    { id: 1, messageId: 1, name: 'Ctr', startBit: 0, bitLength: 4, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: null, maximum: 15, unit: null, muxRole: 'normal', enumMap: {} },
    { id: 2, messageId: 1, name: 'Crc8', startBit: 56, bitLength: 8, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: null, maximum: 255, unit: null, muxRole: 'normal', enumMap: {} }
  ]
};

function makeFrame(id: number, hwTime: number, ctr: number, gen = 1): RawFrame {
  const b = new Uint8Array(8);
  b[0] = ctr;
  // crc 覆盖线性位 0..47（6 字节），初值 0，xor 0
  const crc = computeCrc(b, [{ startBit: 0, bitLength: 56 }], 0);
  b[7] = crc;
  return {
    id, canId: 1, isExtended: false, channel: 1, hwTime,
    dataHex: Buffer.from(b).toString('hex').toUpperCase(), acquisitionGen: gen, importSeq: id
  };
}

function decoded(frames: RawFrame[]): DecodedFrame[] {
  // 直接构造已解码结果以便计数器测试
  return frames.map((f) => {
    const ctr = parseInt(f.dataHex.slice(0, 2), 16) & 0x0f;
    return {
      frame: f, dbc, message, reason: 'ok', muxValue: null,
      signals: [
        { signalName: 'Ctr', byteOrder: 'intel', startBitDbc: 0, bitLength: 4, bitPositions: [0,1,2,3], bitRanges: ['0.0-0.3'], raw: ctr, signedRaw: ctr, physical: ctr, factor: 1, offset: 0, unit: null, muxRole: 'normal', enumValue: null, muxUnknown: false },
        { signalName: 'Crc8', byteOrder: 'intel', startBitDbc: 64, bitLength: 8, bitPositions: [], bitRanges: [], raw: 0, signedRaw: 0, physical: 0, factor: 1, offset: 0, unit: null, muxRole: 'normal', enumValue: null, muxUnknown: false }
      ]
    };
  });
}

describe('计数器', () => {
  it('检测重复（含重复时间戳）', () => {
    const frames = [makeFrame(1, 0, 0), makeFrame(2, 0, 0), makeFrame(3, 10, 1)];
    const r = checkCounter(decoded(frames), { id: 1, node: 'N', signalName: 'Ctr', maxValue: 15, dbcId: 1 });
    expect(r.events.map((e) => e.kind)).toContain('duplicate');
  });

  it('检测缺帧并报告丢失数', () => {
    const frames = [makeFrame(1, 0, 0), makeFrame(2, 10, 3)];
    const r = checkCounter(decoded(frames), { id: 1, node: 'N', signalName: 'Ctr', maxValue: 15, dbcId: 1 });
    const miss = r.events.find((e) => e.kind === 'missing')!;
    expect(miss.lost).toBe(2);
  });

  it('15->0 环绕标记 wrap 且整体仍有序', () => {
    const frames = [makeFrame(1, 0, 14), makeFrame(2, 10, 15), makeFrame(3, 20, 0)];
    const r = checkCounter(decoded(frames), { id: 1, node: 'N', signalName: 'Ctr', maxValue: 15, dbcId: 1 });
    expect(r.events.some((e) => e.kind === 'wrap')).toBe(true);
    expect(r.ordered).toBe(true);
  });

  it('按采集代次分组，代次间互不影响', () => {
    const frames = [makeFrame(1, 0, 5, 1), makeFrame(2, 10, 6, 1), makeFrame(3, 20, 0, 2), makeFrame(4, 30, 1, 2)];
    const r = checkCounter(decoded(frames), { id: 1, node: 'N', signalName: 'Ctr', maxValue: 15, dbcId: 1 });
    expect(r.groups.map((g) => g.acquisitionGen)).toEqual([1, 2]);
    expect(r.ordered).toBe(true);
  });
});

describe('CRC', () => {
  const rule = (over: Partial<CrcRule>): CrcRule => ({
    id: 1, messageName: 'M', signalName: 'Crc8',
    coverage: [{ startBit: 0, bitLength: 48 }], init: 0, xorOut: 0, dbcId: 1, ...over
  });

  it('配置完整时正确帧通过', () => {
    const frames = [makeFrame(1, 0, 0)];
    const r = verifyCrc(frames, message, rule({}));
    expect(r.configured).toBe(true);
    expect(r.evidences[0].status).toBe('passed');
  });

  it('覆盖边界：只覆盖首字节时改第二字节不应影响结果', () => {
    const f1 = makeFrame(1, 0, 0);
    const b2 = new Uint8Array(Buffer.from(f1.dataHex, 'hex'));
    b2[1] ^= 0xff;
    const f2: RawFrame = { ...f1, id: 2, dataHex: Buffer.from(b2).toString('hex').toUpperCase() };
    const r = verifyCrc([f2], message, rule({ coverage: [{ startBit: 0, bitLength: 8 }] }));
    expect(r.evidences[0].status).toBe('passed');
  });

  it('初值/异或/覆盖缺失时只能未核验，绝不过通过', () => {
    const frames = [makeFrame(1, 0, 0)];
    expect(missingCrcConfig(rule({ init: null }))).toContain('init');
    expect(missingCrcConfig(rule({ xorOut: null }))).toContain('xorOut');
    expect(missingCrcConfig(rule({ coverage: [] }))).toContain('coverage');
    for (const r0 of [rule({ init: null }), rule({ xorOut: null }), rule({ coverage: [] })]) {
      const r = verifyCrc(frames, message, r0);
      expect(r.evidences.every((e) => e.status === 'unchecked')).toBe(true);
    }
  });

  it('篡改 CRC 字节判失败', () => {
    const f = makeFrame(1, 0, 7);
    const bad: RawFrame = { ...f, dataHex: f.dataHex.slice(0, 14) + '00' };
    const r = verifyCrc([bad], message, rule({}));
    expect(r.evidences[0].status).toBe('failed');
  });
});
