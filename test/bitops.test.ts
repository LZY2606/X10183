import { describe, expect, it } from 'vitest';
import { extractRaw, intelCells, motorolaCells, signalCells, toSigned } from '../server/bitops.js';

// 网格约定（cantools 兼容）：byte b 的 MSB=8b … LSB=8b+7；cells 按值 MSB→LSB
describe('Intel / Motorola bit 布局', () => {
  it('Intel 0|16 跨字节小端：data=2A 01 → raw=0x012A', () => {
    const cells = intelCells(0, 16);
    expect(cells).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7]);
    expect(extractRaw([0x2a, 0x01, 0, 0, 0, 0, 0, 0], cells)).toBe(0x012a);
  });

  it('Intel 8|16 落在 byte1/2 小端', () => {
    const cells = intelCells(8, 16);
    expect(cells).toContain(8);
    expect(cells).toContain(23);
    expect(extractRaw([0, 0xbb, 0x02, 0, 0, 0, 0, 0], cells)).toBe(0x02bb);
  });

  it('Motorola 7|16 连续 MSB 网格 0..15：data=12 34 → 0x1234', () => {
    const cells = motorolaCells(7, 16);
    expect(cells).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(extractRaw([0x12, 0x34, 0, 0, 0, 0, 0, 0], cells)).toBe(0x1234);
  });

  it('Motorola 23|16 连续网格 16..31（跨字节）', () => {
    const cells = motorolaCells(23, 16);
    expect(cells).toEqual(Array.from({ length: 16 }, (_, i) => i + 16));
    expect(extractRaw([0, 0, 0xab, 0xcd, 0, 0, 0, 0], cells)).toBe(0xabcd);
  });

  it('Motorola 11|8 锯齿跨字节（cantools 基准）', () => {
    expect(motorolaCells(11, 8)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(extractRaw([0, 0x0f, 0xf0, 0, 0, 0, 0, 0], motorolaCells(11, 8))).toBe(0xff);
  });

  it('跨字节有符号值：16 bit 二补数', () => {
    expect(toSigned(0xffff, 16)).toBe(-1);
    expect(toSigned(0x8000, 16)).toBe(-32768);
    expect(toSigned(0x7fff, 16)).toBe(32767);
  });

  it('signalCells 按字节序分派', () => {
    expect(signalCells('intel', 0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(signalCells('motorola', 7, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
