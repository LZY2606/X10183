import type { ByteOrder, SignalDef } from './types.js';

/** 线性位号 -> (字节, 字节内位号)，0 = LSB */
export function splitPos(linear: number): { byte: number; bit: number } {
  return { byte: linear >> 3, bit: linear & 7 };
}

/** 信号占用的线性位号列表（0..8*DLC-1），Intel 从 LSB 向高位，Motorola 按 DBC 锯齿序 */
export function signalBitPositions(sig: {
  startBit: number;
  bitLength: number;
  byteOrder: ByteOrder;
}): number[] {
  const out: number[] = [];
  if (sig.byteOrder === 'intel') {
    for (let i = 0; i < sig.bitLength; i++) out.push(sig.startBit + i);
    return out;
  }
  // Motorola（大端）：startBit 是 MSB 的 DBC 位号
  let row = sig.startBit >> 3;
  let bitInByte = sig.startBit & 7;
  for (let i = 0; i < sig.bitLength; i++) {
    out.push(row * 8 + bitInByte);
    if (bitInByte === 0) {
      row += 1;
      bitInByte = 8;
    }
    bitInByte -= 1;
  }
  return out;
}

/** 读取线性位号上的 bit（0=LSB） */
export function readBit(data: Uint8Array, linear: number): number {
  const { byte, bit } = splitPos(linear);
  if (byte >= data.length) return 0;
  return (data[byte] >> bit) & 1;
}

/** 提取信号原始值（无符号）。Motorola 的 positions 从 MSB 开始；Intel 从 LSB 开始 */
export function extractRaw(data: Uint8Array, sig: SignalDef): number {
  const positions = signalBitPositions(sig);
  let raw = 0;
  if (sig.byteOrder === 'intel') {
    for (let i = 0; i < positions.length; i++) {
      if (readBit(data, positions[i])) raw |= 1 << i;
    }
  } else {
    for (let i = 0; i < positions.length; i++) {
      if (readBit(data, positions[i])) raw |= 1 << (positions.length - 1 - i);
    }
  }
  return raw >>> 0;
}

/** 有符号扩展 */
export function signExtend(raw: number, bitLength: number, sign: '+' | '-'): number {
  if (sign === '+' || bitLength >= 32) return raw;
  const mask = 1 << (bitLength - 1);
  return (raw ^ mask) - mask;
}

/** 物理值 */
export function physicalValue(raw: number, sig: SignalDef): number {
  const v = signExtend(raw, sig.bitLength, sig.sign);
  return v * sig.factor + sig.offset;
}

/** 位号区间压缩：同字节内连续段 -> "byte.bitFrom-bitTo"（bitFrom>=bitTo） */
export function compactBitRanges(positions: number[]): string[] {
  if (positions.length === 0) return [];
  const ranges: string[] = [];
  let start = positions[0];
  let prev = positions[0];
  const flush = (a: number, b: number) => {
    const ba = splitPos(a);
    const bb = splitPos(b);
    if (a === b) ranges.push(`${ba.byte}.${ba.bit}`);
    else ranges.push(`${ba.byte}.${ba.bit}-${bb.byte}.${bb.bit}`);
  };
  for (let i = 1; i < positions.length; i++) {
    const cur = positions[i];
    const sameByte = cur >> 3 === prev >> 3;
    // Motorola 锯齿下降；Intel 线性上升
    const contiguous = sameByte && (cur === prev - 1 || cur === prev + 1);
    if (!contiguous) {
      flush(start, prev);
      start = cur;
    }
    prev = cur;
  }
  flush(start, prev);
  return ranges;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(data: Uint8Array): string {
  return Array.from(data)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}
