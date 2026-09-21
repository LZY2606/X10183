import type { BitPos, BitRange, ByteOrder } from './types';

/**
 * DBC bit numbering: bit index = byte * 8 + bitInByte, where bit 0 is the LSB
 * of the byte. For intel signals the start bit is the LSB of the signal.
 * For motorola signals the start bit is the MSB of the signal; subsequent
 * bits walk downward within the byte and wrap to bit 7 of the next byte.
 */
export function signalBitPositions(
  startBit: number,
  length: number,
  byteOrder: ByteOrder,
): BitPos[] {
  const positions: BitPos[] = [];
  if (byteOrder === 'intel') {
    for (let i = 0; i < length; i++) {
      const pos = startBit + i;
      positions.push({ byte: Math.floor(pos / 8), bit: pos % 8 });
    }
    return positions;
  }
  // motorola: start bit is MSB, walk down; crossing a byte boundary jumps
  // from bit 0 of byte N to bit 7 of byte N+1 (pos - 1 -> pos + 15).
  let pos = startBit;
  for (let i = 0; i < length; i++) {
    positions.push({ byte: Math.floor(pos / 8), bit: pos % 8 });
    pos = pos % 8 === 0 ? pos + 15 : pos - 1;
  }
  return positions;
}

/** Collapse bit positions into per-byte contiguous ranges (LSB..MSB). */
export function bitRanges(positions: BitPos[]): BitRange[] {
  const byByte = new Map<number, { lo: number; hi: number }>();
  for (const p of positions) {
    const cur = byByte.get(p.byte);
    if (!cur) byByte.set(p.byte, { lo: p.bit, hi: p.bit });
    else {
      cur.lo = Math.min(cur.lo, p.bit);
      cur.hi = Math.max(cur.hi, p.bit);
    }
  }
  return [...byByte.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([byte, { lo, hi }]) => ({ byte, startBit: lo, endBit: hi }));
}

/** Extract the unsigned raw value of a signal from frame data. */
export function extractRaw(
  data: Uint8Array,
  startBit: number,
  length: number,
  byteOrder: ByteOrder,
): number {
  const positions = signalBitPositions(startBit, length, byteOrder);
  let value = 0;
  if (byteOrder === 'intel') {
    // positions[0] is the signal LSB
    for (let i = positions.length - 1; i >= 0; i--) {
      const p = positions[i];
      const bit = (data[p.byte] >> p.bit) & 1;
      value = value * 2 + bit;
    }
    return value;
  }
  // motorola: positions[0] is the signal MSB
  for (const p of positions) {
    const bit = (data[p.byte] >> p.bit) & 1;
    value = value * 2 + bit;
  }
  return value;
}

/** Interpret an unsigned raw value as two's-complement signed. */
export function toSigned(raw: number, length: number): number {
  const signBit = 2 ** (length - 1);
  return raw >= signBit ? raw - 2 ** length : raw;
}

/** Raw signal bits as a 0/1 string, MSB first (signal order). */
export function rawBitsString(
  data: Uint8Array,
  startBit: number,
  length: number,
  byteOrder: ByteOrder,
): string {
  const positions = signalBitPositions(startBit, length, byteOrder);
  const ordered = byteOrder === 'intel' ? [...positions].reverse() : positions;
  return ordered.map((p) => String((data[p.byte] >> p.bit) & 1)).join('');
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

export function bytesToHex(data: Uint8Array | number[]): string {
  return [...data].map((b) => b.toString(16).padStart(2, '0')).join('');
}
