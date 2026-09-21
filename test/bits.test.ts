import { describe, expect, it } from 'vitest';
import {
  compactBitRanges,
  extractRaw,
  hexToBytes,
  physicalValue,
  signalBitPositions,
  signExtend
} from '../src/core/bits.js';
import type { SignalDef } from '../src/core/types.js';

function sig(partial: Partial<SignalDef>): SignalDef {
  return {
    id: 1,
    messageId: 1,
    name: 'S',
    startBit: 0,
    bitLength: 8,
    byteOrder: 'intel',
    sign: '+',
    factor: 1,
    offset: 0,
    minimum: null,
    maximum: null,
    unit: null,
    muxRole: 'normal',
    enumMap: {},
    ...partial
  };
}

describe('Intel / Motorola 位序', () => {
  it('Intel 0|16 占据线性位 0..15', () => {
    expect(signalBitPositions(sig({ startBit: 0, bitLength: 16 }))).toEqual(
      Array.from({ length: 16 }, (_, i) => i)
    );
  });

  it('Motorola 7|16 按 DBC 锯齿序跨两字节', () => {
    expect(signalBitPositions(sig({ startBit: 7, bitLength: 16, byteOrder: 'motorola' }))).toEqual([
      7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8
    ]);
  });

  it('Motorola 23|8 恰好落在第 2 字节', () => {
    expect(signalBitPositions(sig({ startBit: 23, bitLength: 8, byteOrder: 'motorola' }))).toEqual([
      23, 22, 21, 20, 19, 18, 17, 16
    ]);
  });

  it('提取 Intel 跨字节值 0x0064', () => {
    const data = hexToBytes('6400');
    expect(extractRaw(data, sig({ startBit: 0, bitLength: 16 }))).toBe(100);
  });

  it('提取 Motorola 跨字节大端值 0x1234', () => {
    const data = hexToBytes('1234');
    expect(extractRaw(data, sig({ startBit: 7, bitLength: 16, byteOrder: 'motorola' }))).toBe(
      0x1234
    );
  });

  it('跨字节有符号值：小端 F8FF = -8', () => {
    const data = hexToBytes('F8FF');
    const s = sig({ startBit: 0, bitLength: 16, sign: '-' });
    expect(signExtend(extractRaw(data, s), 16, '-')).toBe(-8);
    expect(physicalValue(extractRaw(data, s), s)).toBe(-8);
  });

  it('区间压缩可追到确切 bit 区间', () => {
    expect(compactBitRanges(signalBitPositions(sig({ startBit: 0, bitLength: 16 })))).toEqual([
      '0.0-0.7',
      '1.0-1.7'
    ]);
    expect(
      compactBitRanges(signalBitPositions(sig({ startBit: 7, bitLength: 16, byteOrder: 'motorola' })))
    ).toEqual(['0.7-0.0', '1.7-1.0']);
  });

  it('缩放与偏置：-8 × 0.1 + 50 = 49.2', () => {
    const s = sig({ startBit: 0, bitLength: 16, sign: '-', factor: 0.1, offset: 50 });
    expect(physicalValue(extractRaw(hexToBytes('F8FF'), s), s)).toBeCloseTo(49.2, 6);
  });
});
