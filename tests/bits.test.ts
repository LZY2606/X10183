import { describe, expect, it } from 'vitest';
import { encodeRaw, extractRaw, signalBitPositions, signExtend } from '../src/core/bits.js';
import type { SignalDef } from '../src/core/types.js';

function sig(partial: Partial<SignalDef>): SignalDef {
  return {
    name: partial.name ?? 'S',
    startBit: partial.startBit ?? 0,
    length: partial.length ?? 8,
    byteOrder: partial.byteOrder ?? 'intel',
    valueType: partial.valueType ?? 'unsigned',
    factor: partial.factor ?? 1,
    offset: partial.offset ?? 0,
    unit: partial.unit ?? '',
    muxKind: 'plain',
    enums: [],
  };
}

describe('Intel (little-endian) extraction', () => {
  it('reads a 16-bit cross-byte value (DBC 0|16@1 occupies byte0/byte1 little-endian)', () => {
    const data = [0x34, 0x12, 0, 0, 0, 0, 0, 0];
    expect(extractRaw(data, sig({ startBit: 0, length: 16, byteOrder: 'intel' }))).toBe(0x1234);
  });

  it('reads a signed cross-byte negative value', () => {
    const data = [0x00, 0xf0]; // raw 0xf000 in 16 bits = -4096
    const sg = sig({ startBit: 0, length: 16, byteOrder: 'intel', valueType: 'signed' });
    const raw = extractRaw(data, sg)!;
    expect(signExtend(raw, 16)).toBe(-4096);
  });

  it('anchors an unaligned Intel signal via small saw-tooth (4|12@1)', () => {
    // lsbLinear = 4 + 8*1 = 12; occupies linears 12..23 (byte1.high + byte2)
    const data = [0, 0x20, 0x31]; // 12..15 = 0x2 high nibble, 16..23 = 0x31 -> raw 0x312
    const sg = sig({ name: 'U', startBit: 4, length: 12, byteOrder: 'intel' });
    expect(extractRaw(data, sg)).toBe(0x312);
  });

  it('round trips with encodeRaw', () => {
    const sg = sig({ startBit: 4, length: 12, byteOrder: 'intel' });
    const data = new Array(8).fill(0);
    encodeRaw(data, sg, 0b101010101010);
    expect(extractRaw(data, sg)).toBe(0b101010101010);
  });

  it('reports exact per-bit positions (MSB first) for 0|16@1 (byte0/byte1)', () => {
    const positions = signalBitPositions(sig({ startBit: 0, length: 16, byteOrder: 'intel' }));
    expect(positions[0]).toEqual({ linear: 23, dbc: 23 });
    expect(positions[15]).toEqual({ linear: 8, dbc: 8 });
  });
});

describe('Motorola (big-endian) extraction', () => {
  it('reads a byte-0 8-bit signal starting at 7', () => {
    expect(extractRaw([0xab, 0, 0, 0, 0, 0, 0, 0], sig({ startBit: 7, length: 8, byteOrder: 'motorola' }))).toBe(0xab);
  });

  it('walks the saw-tooth: start 8 length 16 covers bits 15..8 then 7..0', () => {
    const positions = signalBitPositions(sig({ startBit: 8, length: 16, byteOrder: 'motorola' }));
    expect(positions.map((p) => p.linear)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('reads a cross-byte Motorola word', () => {
    const data = [0x12, 0x34, 0, 0, 0, 0, 0, 0];
    expect(extractRaw(data, sig({ startBit: 8, length: 16, byteOrder: 'motorola' }))).toBe(0x1234);
  });

  it('round-trips a Motorola signal that spans the byte edge', () => {
    const s = sig({ startBit: 23, length: 16, byteOrder: 'motorola' });
    const data = new Array(8).fill(0);
    encodeRaw(data, s, 0xbeef);
    expect(extractRaw(data, s)).toBe(0xbeef);
    expect(data[2]).toBe(0xbe);
    expect(data[3]).toBe(0xef);
  });

  it('reads a signed Motorola cross-byte value', () => {
    const s = sig({ startBit: 8, length: 16, byteOrder: 'motorola', valueType: 'signed' });
    const data = [0xff, 0xfe]; // -2
    expect(signExtend(extractRaw(data, s)!, 16)).toBe(-2);
  });
});
