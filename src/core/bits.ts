export type ByteOrder = 'intel' | 'motorola';

export interface BitPos {
  byte: number;
  bit: number; // 0..7, 7 is the most significant bit of the byte
}

/**
 * Bit positions occupied by a signal, in significance order.
 * Intel (little-endian): first position is the LSB, positions increase linearly.
 * Motorola (big-endian): first position is the MSB, walking towards lower
 * significance inside a byte, then jumping to bit 7 of the next byte.
 */
export function signalPositions(order: ByteOrder, start: number, length: number): BitPos[] {
  const positions: BitPos[] = [];
  if (order === 'intel') {
    for (let i = 0; i < length; i++) {
      const p = start + i;
      positions.push({ byte: p >> 3, bit: p & 7 });
    }
  } else {
    let byte = start >> 3;
    let bit = start & 7;
    for (let i = 0; i < length; i++) {
      positions.push({ byte, bit });
      bit -= 1;
      if (bit < 0) {
        bit = 7;
        byte += 1;
      }
    }
  }
  return positions;
}

function bitAt(data: Uint8Array, pos: BitPos): number {
  if (pos.byte < 0 || pos.byte >= data.length) return 0;
  return (data[pos.byte] >> pos.bit) & 1;
}

export function extractRaw(data: Uint8Array, order: ByteOrder, start: number, length: number): bigint {
  const positions = signalPositions(order, start, length);
  let raw = 0n;
  if (order === 'intel') {
    for (let i = 0; i < positions.length; i++) {
      raw |= BigInt(bitAt(data, positions[i])) << BigInt(i);
    }
  } else {
    for (const pos of positions) {
      raw = (raw << 1n) | BigInt(bitAt(data, pos));
    }
  }
  return raw;
}

export function packRaw(data: Uint8Array, order: ByteOrder, start: number, length: number, value: bigint): void {
  const positions = signalPositions(order, start, length);
  if (order === 'intel') {
    for (let i = 0; i < positions.length; i++) {
      const bit = Number((value >> BigInt(i)) & 1n);
      setBit(data, positions[i], bit);
    }
  } else {
    for (let i = 0; i < positions.length; i++) {
      const shift = BigInt(positions.length - 1 - i);
      const bit = Number((value >> shift) & 1n);
      setBit(data, positions[i], bit);
    }
  }
}

function setBit(data: Uint8Array, pos: BitPos, value: number): void {
  if (pos.byte < 0 || pos.byte >= data.length) return;
  if (value) data[pos.byte] |= 1 << pos.bit;
  else data[pos.byte] &= ~(1 << pos.bit);
}

export function toSigned(raw: bigint, length: number): bigint {
  if (length <= 0) return raw;
  const signBit = 1n << BigInt(length - 1);
  if (raw & signBit) return raw - (1n << BigInt(length));
  return raw;
}

export function bitLabel(order: ByteOrder, start: number, length: number): string {
  const positions = signalPositions(order, start, length);
  const first = positions[0];
  const last = positions[positions.length - 1];
  return `B${first.byte}.${first.bit}→B${last.byte}.${last.bit}`;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
}
