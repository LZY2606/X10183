import type { ByteOrder } from './types';

export interface BitPos {
  byte: number;
  bit: number; // 7 = MSB, 0 = LSB
}

export interface BitSegment {
  byte: number;
  bit_from: number; // 7 = MSB
  bit_to: number;
}

export interface BitExtraction {
  raw: bigint; // unsigned raw value
  positions: BitPos[];
  segments: BitSegment[];
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`invalid hex data: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extract `length` bits starting at DBC `startBit` (sawtooth numbering:
 * startBit = byte * 8 + bit, bit 7 = MSB of the byte).
 * Intel: start bit is the LSB of the signal, bits grow upward.
 * Motorola: start bit is the MSB of the signal, bits continue towards
 * the next byte's MSB.
 */
export function extractBits(
  data: Uint8Array,
  startBit: number,
  length: number,
  order: ByteOrder,
): BitExtraction {
  if (length <= 0) throw new Error('length must be positive');
  const positions: BitPos[] = [];
  let raw = 0n;
  if (order === 'intel') {
    for (let i = 0; i < length; i++) {
      const p = startBit + i;
      const byte = p >> 3;
      const bit = p & 7;
      if (byte >= data.length) throw new Error(`bit ${p} out of range`);
      const b = (data[byte] >> bit) & 1;
      raw |= BigInt(b) << BigInt(i);
      positions.push({ byte, bit });
    }
  } else {
    const startByte = startBit >> 3;
    const startBitInByte = startBit & 7;
    const seq = startByte * 8 + (7 - startBitInByte);
    for (let i = 0; i < length; i++) {
      const p = seq + i;
      const byte = p >> 3;
      const bit = 7 - (p & 7);
      if (byte >= data.length) throw new Error(`bit ${p} out of range`);
      const b = (data[byte] >> bit) & 1;
      raw = (raw << 1n) | BigInt(b);
      positions.push({ byte, bit });
    }
  }
  return { raw, positions, segments: toSegments(positions) };
}

function toSegments(positions: BitPos[]): BitSegment[] {
  const segments: BitSegment[] = [];
  for (const pos of positions) {
    const last = segments[segments.length - 1];
    if (
      last &&
      last.byte === pos.byte &&
      (pos.bit === last.bit_to - 1 || pos.bit === last.bit_to + 1)
    ) {
      last.bit_to = pos.bit;
    } else {
      segments.push({ byte: pos.byte, bit_from: pos.bit, bit_to: pos.bit });
    }
  }
  return segments;
}

export function applySign(raw: bigint, length: number, isSigned: boolean): bigint {
  if (!isSigned || length <= 0) return raw;
  const top = 1n << BigInt(length - 1);
  if ((raw & top) === 0n) return raw;
  return raw - (1n << BigInt(length));
}

export function positionsToBitString(positions: BitPos[], data: Uint8Array): string {
  return positions.map((p) => String((data[p.byte] >> p.bit) & 1)).join('');
}
