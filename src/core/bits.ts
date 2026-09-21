import type { ByteOrder } from './types';

/**
 * DBC 位编号（线性）：byte0 的 MSB=0 … LSB=7；byte1 的 MSB=8 … LSB=15。
 * Intel：startBit 是信号 LSB；向高位走时字节内编号下降，跨字节跳到下一字节同列。
 * Motorola：startBit 是信号 MSB；字节内编号上升，跨字节跳到下一字节 MSB。
 */
export function signalBitPositions(
  startBit: number,
  length: number,
  order: ByteOrder,
): number[] {
  const out: number[] = [];
  const byteIndex = Math.floor(startBit / 8);
  const m = startBit % 8; // 起始字节内 MSB 偏移（0=最高位）

  if (order === 'intel') {
    // startBit = 信号 LSB 的 DBC 编号。
    // 起始字节内先占用 m+1 位（s, s-1, ... 8b），之后每跨一字节从该字节最低位（7 列）向上。
    for (let i = 0; i < length; i++) {
      if (i <= m) {
        out.push(startBit - i);
      } else {
        const j = i - (m + 1);
        const row = 1 + Math.floor(j / 8);
        const col = 7 - (j % 8); // MSB 偏移
        out.push((byteIndex + row) * 8 + col);
      }
    }
    return out;
  }

  // Motorola：startBit = MSB；字节内向低位走，跨字节跳到下一字节最高位
  for (let i = 0; i < length; i++) {
    const row = Math.floor((m + i) / 8);
    const col = (m + i) % 8;
    out.push((byteIndex + row) * 8 + col);
  }
  return out;
}

export interface ExtractResult {
  raw: bigint;
  outOfDlc: boolean;
  positionsMsbFirst: number[];
}

export function extractRaw(
  data: Uint8Array,
  positions: number[],
  order: ByteOrder,
): ExtractResult {
  let outOfDlc = false;
  const ordered = order === 'motorola' ? positions : [...positions].reverse();
  let raw = 0n;
  for (const p of ordered) {
    const byte = Math.floor(p / 8);
    const bit = 7 - (p % 8);
    if (byte >= data.length) {
      outOfDlc = true;
      raw <<= 1n;
      continue;
    }
    raw = (raw << 1n) | ((BigInt(data[byte]) >> BigInt(bit)) & 1n);
  }
  return { raw, outOfDlc, positionsMsbFirst: ordered };
}

/** 按信号位宽做符号扩展，返回可能为负的 bigint */
export function toSigned(raw: bigint, length: number, signed: boolean): bigint {
  if (!signed) return raw;
  const top = 1n << BigInt(length - 1);
  if (raw & top) {
    return raw - (1n << BigInt(length));
  }
  return raw;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('非法 hex: 长度必须为偶数');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
