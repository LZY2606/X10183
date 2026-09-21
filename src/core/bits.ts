// Bit-level extraction with full provenance.
// Absolute bit index convention: bitIndex = byteIndex * 8 + bitInByte,
// bitInByte 0 = least significant bit of that byte (LSB0 / "seen" numbering).

export type ByteOrder = 'intel' | 'motorola';

export interface BitSpan {
  // Ordered absolute bit positions, most-significant value bit first.
  positions: number[];
  // Contiguous byte ranges touched, for UI highlighting.
  bytes: number[];
}

export interface ExtractedBits {
  raw: bigint;
  span: BitSpan;
}

export function motorolaPositions(startBit: number, length: number): number[] {
  // DBC Motorola: startBit is the MOST significant bit of the value.
  // Walking to the next value bit: decrement bit-in-byte; when crossing
  // below bit 0 of a byte, continue at bit 7 of the next byte.
  const positions: number[] = [];
  let pos = startBit;
  for (let i = 0; i < length; i++) {
    if (pos < 0) throw new Error(`motorola bit walk out of range at step ${i}`);
    positions.push(pos);
    pos = pos % 8 === 0 ? pos + 15 : pos - 1;
  }
  return positions;
}

export function intelPositions(startBit: number, length: number): number[] {
  // Intel: startBit is the LEAST significant bit; positions ascend.
  // Returned most-significant-first to match motorolaPositions ordering.
  const positions: number[] = [];
  for (let i = length - 1; i >= 0; i--) positions.push(startBit + i);
  return positions;
}

export function bitPositions(order: ByteOrder, startBit: number, length: number): number[] {
  return order === 'intel'
    ? intelPositions(startBit, length)
    : motorolaPositions(startBit, length);
}

function getBit(data: Uint8Array, absoluteBit: number): number {
  const byte = data[absoluteBit >> 3];
  if (byte === undefined) throw new Error(`bit ${absoluteBit} outside payload of ${data.length} bytes`);
  return (byte >> (absoluteBit & 7)) & 1;
}

export function extractBits(
  data: Uint8Array,
  order: ByteOrder,
  startBit: number,
  length: number,
): ExtractedBits {
  if (length <= 0 || length > 64) throw new Error(`unsupported bit length ${length}`);
  const positions = bitPositions(order, startBit, length);
  let raw = 0n;
  for (const pos of positions) raw = (raw << 1n) | BigInt(getBit(data, pos));
  const bytes = [...new Set(positions.map((p) => p >> 3))].sort((a, b) => a - b);
  return { raw, span: { positions, bytes } };
}

export function toSigned(raw: bigint, length: number): bigint {
  const signBit = 1n << BigInt(length - 1);
  if ((raw & signBit) === 0n) return raw;
  return raw - (1n << BigInt(length));
}
