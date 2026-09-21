import { describe, expect, it } from 'vitest';
import { decodeFrame, matchMessage } from '../src/core/decoder.js';
import type { DbcVersion, MessageDef, RawFrame, SignalDef } from '../src/core/types.js';

const dbc: DbcVersion = { id: 1, label: 'v1', effectiveFrom: null, effectiveTo: null, createdAt: 1, notes: null };

function sig(s: Partial<SignalDef>): SignalDef {
  return {
    id: Math.random(), messageId: 1, name: 'X', startBit: 0, bitLength: 8,
    byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: null, maximum: null,
    unit: null, muxRole: 'normal', enumMap: {}, ...s
  };
}

const muxMessage: MessageDef = {
  id: 1, dbcId: 1, canId: 0x300, isExtended: false, name: 'SENSOR_MUX', dlc: 8, transmitter: 'S',
  signals: [
    sig({ name: 'Mux', muxRole: 'switch', startBit: 0, bitLength: 4 }),
    sig({ name: 'Voltage', muxRole: 1, startBit: 8, bitLength: 16, factor: 0.01 }),
    sig({ name: 'Current', muxRole: 2, startBit: 8, bitLength: 16, sign: '-', factor: 0.1 })
  ]
};

function frame(dataHex: string, over: Partial<RawFrame> = {}): RawFrame {
  return { id: 1, canId: 0x300, isExtended: false, channel: 1, hwTime: 0, dataHex, acquisitionGen: 1, importSeq: 1, ...over };
}

describe('多路复用解码', () => {
  it('mux=1 解释 Voltage，Current 保留 raw bits', () => {
    // 01 10 27：mux=1, 0x2710=10000 -> 100.00V
    const d = decodeFrame(frame('0110270000000000'), dbc, muxMessage);
    expect(d.muxValue).toBe(1);
    const v = d.signals.find((s) => s.signalName === 'Voltage')!;
    const c = d.signals.find((s) => s.signalName === 'Current')!;
    expect(v.physical).toBeCloseTo(100, 6);
    expect(v.muxUnknown).toBe(false);
    expect(c.muxUnknown).toBe(true);
    expect(c.physical).toBeNull();
    expect(c.rawBits).toMatch(/^[01]{16}$/);
    expect(c.bitRanges.length).toBeGreaterThan(0);
  });

  it('mux=9 未知分支：所有分支信号都保留 raw bits', () => {
    const d = decodeFrame(frame('09ABCD0000000000'), dbc, muxMessage);
    expect(d.muxValue).toBe(9);
    for (const name of ['Voltage', 'Current']) {
      const s = d.signals.find((x) => x.signalName === name)!;
      expect(s.muxUnknown).toBe(true);
      expect(s.physical).toBeNull();
      expect(s.rawBits).toBeTruthy();
    }
  });

  it('标准帧与扩展帧不混为一类', () => {
    const extMessage: MessageDef = { ...muxMessage, isExtended: true, canId: 0x300 };
    const stdFrame = frame('0110270000000000', { isExtended: false });
    expect(decodeFrame(stdFrame, dbc, extMessage).reason).toBe('ok');
    // 同 id 但帧类型不同 -> 不匹配
    expect(matchMessage(extMessage, { canId: 0x300, isExtended: false })).toBe(false);
    expect(matchMessage(extMessage, { canId: 0x300, isExtended: true })).toBe(true);
  });
});
