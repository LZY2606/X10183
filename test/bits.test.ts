import { describe, expect, it } from 'vitest';
import { signalBitPositions, extractRaw, toSigned, hexToBytes } from '../src/core/bits';

describe('Intel / Motorola bit 排列（与 cantools 参考一致）', () => {
  it('Intel startBit=0：LSB 0 起，字节内向 MSB，跨字节跳高位字节最左', () => {
    expect(signalBitPositions(0, 16, 'intel')).toEqual([
      0, 15, 14, 13, 12, 11, 10, 9, 8, 23, 22, 21, 20, 19, 18, 17,
    ]);
  });

  it('Intel startBit=7（字节对齐）：完整 byte0 + byte1', () => {
    expect(signalBitPositions(7, 16, 'intel')).toEqual([
      7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8,
    ]);
  });

  it('Intel startBit=15（byte1 LSB）：byte1 + byte2', () => {
    expect(signalBitPositions(15, 16, 'intel')).toEqual([
      15, 14, 13, 12, 11, 10, 9, 8, 23, 22, 21, 20, 19, 18, 17, 16,
    ]);
  });

  it('Motorola startBit=0（对齐）：byte0+byte1 MSB-first', () => {
    expect(signalBitPositions(0, 16, 'motorola')).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('Motorola 非对齐 startBit=7：逐字节占一位的斜线', () => {
    expect(signalBitPositions(7, 4, 'motorola')).toEqual([7, 16, 25, 34]);
  });

  it('Motorola startBit=23 长度 16', () => {
    expect(signalBitPositions(23, 16, 'motorola')).toEqual([
      23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
    ]);
  });

  it('跨字节有符号 Intel：f9ce 以 startBit7（对齐）读出 -12551', () => {
    const raw = extractRaw(
      hexToBytes('f9ce'),
      signalBitPositions(7, 16, 'intel'),
      'intel',
    ).raw;
    expect(Number(toSigned(raw, 16, true))).toBe(-12551);
  });

  it('跨字节有符号 Motorola：a26c startBit0 读出 -23956', () => {
    const raw = extractRaw(
      hexToBytes('a26c'),
      signalBitPositions(0, 16, 'motorola'),
      'motorola',
    ).raw;
    expect(Number(toSigned(raw, 16, true))).toBe(-23956);
  });

  it('Motorola 正值 09c4 = 2500', () => {
    const raw = extractRaw(
      hexToBytes('09c4'),
      signalBitPositions(0, 16, 'motorola'),
      'motorola',
    ).raw;
    expect(Number(toSigned(raw, 16, true))).toBe(2500);
  });
});
