/**
 * Bit-level signal decoding with full traceability.
 * Every decoded value reports the exact physical bit positions (LSB0 numbering,
 * bit 0 = LSB of byte 0) it was extracted from.
 */

export type ByteOrder = 'intel' | 'motorola';

export interface BitRange {
  /** inclusive start, physical LSB0 bit index */
  start: number;
  /** inclusive end */
  end: number;
}

export interface SignalDef {
  name: string;
  /** DBC start bit (sawtooth/LSB0 position numbering as in DBC files) */
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  factor: number;
  offset: number;
  min?: number;
  max?: number;
  unit?: string;
  /** multiplexing: multiplexor signal, multiplexed signal (switch value), or plain */
  mux: { role: 'multiplexor' } | { role: 'multiplexed'; switchValue: number } | { role: 'none' };
  enumValues: Record<number, string>;
  isCounter: boolean;
}

export interface DecodedSignal {
  name: string;
  /** physical bit positions in order of significance (MSB first) */
  bitPositions: number[];
  /** merged contiguous bit ranges, ascending */
  bitRanges: BitRange[];
  raw: bigint;
  rawHex: string;
  signedRaw: bigint;
  value: number;
  enumLabel?: string;
  unit?: string;
  factor: number;
  offset: number;
  byteOrder: ByteOrder;
  mux: SignalDef['mux'];
}

/**
 * Physical bit positions (LSB0) of a signal, in order of significance
 * (index 0 is the most significant bit of the value).
 *
 * Intel (little endian): startBit is the LSB; bit k of the value is at
 * physical position startBit + k.
 *
 * Motorola (big endian, sawtooth): startBit is the MSB; walking towards
 * less significant bits decrements the bit-in-byte, wrapping to bit 7 of
 * the next byte.
 */
export function signalBitPositions(sig: Pick<SignalDef, 'startBit' | 'length' | 'byteOrder'>): number[] {
  const positions: number[] = [];
  if (sig.byteOrder === 'intel') {
    for (let k = sig.length - 1; k >= 0; k--) positions.push(sig.startBit + k);
  } else {
    let byte = sig.startBit >> 3;
    let bit = sig.startBit & 7;
    for (let k = 0; k < sig.length; k++) {
      positions.push(byte * 8 + bit);
      if (bit === 0) {
        byte += 1;
        bit = 7;
      } else {
        bit -= 1;
      }
    }
  }
  return positions;
}

/** Merge physical positions into contiguous ascending ranges. */
export function mergeBitRanges(positions: number[]): BitRange[] {
  const sorted = [...positions].sort((a, b) => a - b);
  const ranges: BitRange[] = [];
  for (const p of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && p === last.end + 1) last.end = p;
    else ranges.push({ start: p, end: p });
  }
  return ranges;
}

function getBit(data: Uint8Array, pos: number): number {
  const byte = pos >> 3;
  if (byte >= data.length) throw new RangeError(`bit ${pos} outside payload of ${data.length} bytes`);
  return (data[byte] >> (pos & 7)) & 1;
}

/** Extract the unsigned raw value of a signal from a payload. */
export function extractRaw(data: Uint8Array, sig: Pick<SignalDef, 'startBit' | 'length' | 'byteOrder'>): { raw: bigint; bitPositions: number[] } {
  if (sig.length <= 0) throw new RangeError('signal length must be positive');
  const positions = signalBitPositions(sig);
  let raw = 0n;
  for (const pos of positions) {
    raw = (raw << 1n) | BigInt(getBit(data, pos));
  }
  return { raw, bitPositions: positions };
}

/** Interpret an unsigned raw value as two's-complement signed. */
export function toSigned(raw: bigint, length: number): bigint {
  const signBit = 1n << BigInt(length - 1);
  if (raw & signBit) return raw - (1n << BigInt(length));
  return raw;
}

/** Decode one signal, with full bit-level provenance. */
export function decodeSignal(data: Uint8Array, sig: SignalDef): DecodedSignal {
  const { raw, bitPositions } = extractRaw(data, sig);
  const signedRaw = sig.signed ? toSigned(raw, sig.length) : raw;
  const value = Number(signedRaw) * sig.factor + sig.offset;
  const enumLabel = sig.enumValues[Number(signedRaw)];
  return {
    name: sig.name,
    bitPositions,
    bitRanges: mergeBitRanges(bitPositions),
    raw,
    rawHex: '0x' + raw.toString(16).toUpperCase(),
    signedRaw,
    value,
    enumLabel,
    unit: sig.unit,
    factor: sig.factor,
    offset: sig.offset,
    byteOrder: sig.byteOrder,
    mux: sig.mux,
  };
}

/** Render a payload as a 0/1 string, MSB of byte 0 first. */
export function payloadBitString(data: Uint8Array): string {
  let out = '';
  for (const byte of data) out += byte.toString(2).padStart(8, '0');
  return out;
}
