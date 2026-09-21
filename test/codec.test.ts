import { describe, it, expect } from 'vitest';
import {
  applySign, bitCells, decodeMessage, describeCells, extractRaw, scale
} from '../src/shared/codec.js';
import { msg, s } from './helpers.js';

const asSig = (startBit: number, length: number, byteOrder: 0 | 1) =>
  ({ startBit, length, byteOrder });

describe('bitCells — Intel 排列', () => {
  it('start=0 len=16 覆盖 B0(LSB) 到 B1(MSB)', () => {
    const cells = bitCells(asSig(0, 16, 1));
    expect(cells[0]).toEqual({ byteIndex: 1, bitInByte: 7, weightIndex: 0 });
    expect(cells[15]).toEqual({ byteIndex: 0, bitInByte: 0, weightIndex: 15 });
    expect(new Set(cells.map((c) => c.byteIndex))).toEqual(new Set([0, 1]));
  });

  it('start=13 len=8 为跨字节锯齿：B1 低3位 + B2 高5位', () => {
    const cells = bitCells(asSig(13, 8, 1));
    const msb = cells[0];
    const lsb = cells[7];
    // start=13 是 LSB 位置：物理 13 = B1 的 0x04
    expect(lsb).toEqual({ byteIndex: 1, bitInByte: 2, weightIndex: 7 });
    // MSB 物理 20 = B2 的 0x20
    expect(msb).toEqual({ byteIndex: 2, bitInByte: 2, weightIndex: 0 });
  });
});

describe('bitCells — Motorola(DBC) 排列', () => {
  it('start=7 len=16 覆盖 B0 低7位+B1 最高位（经典跨字节）', () => {
    const cells = bitCells(asSig(7, 16, 0));
    expect(cells[0]).toEqual({ byteIndex: 0, bitInByte: 0, weightIndex: 0 });
    expect(cells[7]).toEqual({ byteIndex: 0, bitInByte: 7, weightIndex: 7 });
    expect(cells[8]).toEqual({ byteIndex: 1, bitInByte: 0, weightIndex: 8 });
    expect(cells[15]).toEqual({ byteIndex: 1, bitInByte: 7, weightIndex: 15 });
  });

  it('start=15 len=16 为字节对齐的 B1..B2 大端', () => {
    const cells = bitCells(asSig(15, 16, 0));
    expect(cells[0]).toEqual({ byteIndex: 1, bitInByte: 0, weightIndex: 0 });
    expect(cells[15]).toEqual({ byteIndex: 2, bitInByte: 7, weightIndex: 15 });
  });

  it('start=0 len=8 占用 B0 的 0x01..0x80（反向走）', () => {
    const cells = bitCells(asSig(0, 8, 0));
    expect(cells[0]).toEqual({ byteIndex: 0, bitInByte: 7, weightIndex: 0 });
    expect(cells[7]).toEqual({ byteIndex: 0, bitInByte: 0, weightIndex: 7 });
  });
});

describe('提取与有符号解释', () => {
  it('跨字节 16bit Motorola 有符号负值', () => {
    const m = msg({
      arbId: 1,
      name: 'M',
      signals: [s({ name: 'T', startBit: 15, length: 16, byteOrder: 0, signed: true, factor: 1, offset: -40, unit: 'C' })]
    });
    const data = Uint8Array.from([0x00, 0xff, 0xd8, 0, 0, 0, 0, 0]); // -40
    const [out] = decodeMessage(m, data);
    expect(out.rawValue).toBe(0xffd8);
    expect(out.physValue).toBe(-80);
    expect(describeCells(out.bitCells)).toBe('B1b0..B1b7,B2b0..B2b7');
  });

  it('跨字节 Intel 小端有符号值', () => {
    const data = Uint8Array.from([0x78, 0x56, 0, 0, 0, 0, 0, 0]); // 0x5678 LE
    const cells = bitCells(asSig(0, 16, 1));
    const raw = extractRaw(cells, data);
    expect(raw).toBe(0x5678);
    expect(applySign(0xffff, 16, true)).toBe(-1);
    expect(scale(100, 0.5, -10)).toBe(40);
  });

  it('枚举命中', () => {
    const m = msg({
      arbId: 1,
      name: 'M',
      signals: [s({
        name: 'Mode', startBit: 0, length: 4, byteOrder: 1,
        valTable: [{ raw: 2, label: 'Sleep' }]
      })]
    });
    const data = Uint8Array.from([0x20, 0, 0, 0, 0, 0, 0, 0]);
    const [out] = decodeMessage(m, data);
    expect(out.rawValue).toBe(2);
    expect(out.enumLabel).toBe('Sleep');
  });
});

describe('多路复用：分支未知保留 raw bits', () => {
  const m = msg({
    arbId: 9,
    name: 'P',
    signals: [
      s({ name: 'Mux', startBit: 0, length: 4, byteOrder: 1, muxType: 'Mux' }),
      s({ name: 'A', startBit: 8, length: 8, byteOrder: 1, muxType: '0', muxValue: 0 }),
      s({ name: 'B', startBit: 15, length: 8, byteOrder: 0, muxType: '1', muxValue: 1 })
    ]
  });

  it('mux=0：A 解码，B 保留 raw bits', () => {
    const out = decodeMessage(m, Uint8Array.from([0x00, 0x12, 0, 0, 0, 0, 0, 0]));
    expect(out[0].rawValue).toBe(0);
    expect(out[1].signalName).toBe('A');
    expect(out[1].rawValue).toBe(0x12);
    expect(out[1].muxSkipped).toBe(false);
    expect(out[2].signalName).toBe('B');
    expect(out[2].rawValue).toBeNull();
    expect(out[2].physValue).toBeNull();
    expect(out[2].muxSkipped).toBe(true);
    expect(out[2].bitCells.length).toBe(8);
  });

  it('mux=未知值 3：分支信号全部保留 raw bits，开关自身仍解码', () => {
    const out = decodeMessage(m, Uint8Array.from([0x03, 0xab, 0, 0, 0, 0, 0, 0]));
    expect(out[0].rawValue).toBe(3);
    expect(out[1].muxSkipped).toBe(true);
    expect(out[2].muxSkipped).toBe(true);
  });
});
