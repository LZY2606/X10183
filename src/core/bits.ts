export type ByteOrder = 'intel' | 'motorola';

/**
 * Linear bit numbering: index = byte * 8 + bitInByte, bitInByte 7 = MSB.
 * DBC start bits map directly onto this numbering for both byte orders.
 */
export function signalBitPositions(startBit: number, length: number, order: ByteOrder): number[] {
  const positions: number[] = [];
  let pos = startBit;
  for (let k = 0; k < length; k++) {
    positions.push(pos);
    pos = order === 'intel' ? pos + 1 : pos % 8 === 0 ? pos + 15 : pos - 1;
  }
  return positions;
}

export function dataBit(data: Uint8Array, index: number): number {
  const byte = index >> 3;
  if (byte >= data.length) return 0;
  return (data[byte] >> (index & 7)) & 1;
}

export function extractRaw(data: Uint8Array, startBit: number, length: number, order: ByteOrder): bigint {
  const positions = signalBitPositions(startBit, length, order);
  let raw = 0n;
  for (let k = 0; k < length; k++) {
    const bit = dataBit(data, positions[k]);
    if (!bit) continue;
    raw |= 1n << BigInt(order === 'intel' ? k : length - 1 - k);
  }
  return raw;
}

export function toSigned(raw: bigint, length: number): bigint {
  const signBit = 1n << BigInt(length - 1);
  return raw & signBit ? raw - (1n << BigInt(length)) : raw;
}

/** Test/seed helper: write a raw value into a buffer at a signal position. */
export function writeSignal(
  buf: Uint8Array,
  startBit: number,
  length: number,
  order: ByteOrder,
  value: number
): void {
  const positions = signalBitPositions(startBit, length, order);
  let v = value;
  if (v < 0) v = (1 << length) + v;
  for (let k = 0; k < length; k++) {
    const bit = order === 'intel' ? (v >> k) & 1 : (v >> (length - 1 - k)) & 1;
    if (bit) buf[positions[k] >> 3] |= 1 << (positions[k] & 7);
  }
}
