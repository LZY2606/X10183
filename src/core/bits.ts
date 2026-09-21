import type { BitPosition, SignalDef } from './types.js';

/**
 * Physical linear bit index = byte*8 + q (q = 0 is the byte's LSB). The DBC
 * saw-tooth matrix numbering equals this linear index.
 *
 * Occupied-cell walks:
 *  motorola @0 (startBit = MSB cell): decrement q within a byte; after q=0 of
 *  byte n the next cell is q=7 of byte n+1, physical step +15 (0 -> 15).
 *  Example start=7 length 16:
 *      7,6,5,4,3,2,1,0, 15,14,13,12,11,10,9,8
 *  Example start=8 length 16:
 *      8,7,6,5,4,3,2,1, 23,22,21,20,19,18,17,16
 *
 *  intel @1 (startBit = LSB cell, printed against the signal's most-significant
 *  byte): physical LSB linear = startBit + 8*(byteSpan-1); cells run upward.
 *  Example 0|16@1 (byteSpan 2): physical 8..23.
 */
export function linearToDbc(linear: number): number {
  return linear;
}

export function dbcToLinear(dbc: number): number {
  return dbc;
}

export function intelLsbLinear(startBit: number, length: number): number {
  const byteSpan = Math.ceil(length / 8);
  return startBit + 8 * (byteSpan - 1);
}

/** Occupied physical linear bit indices, MSB first. */
export function signalLinearBits(sig: SignalDef, payloadBytes = 8): number[] {
  const total = payloadBytes * 8;
  const out: number[] = [];

  if (sig.byteOrder === 'intel') {
    const lsb = intelLsbLinear(sig.startBit, sig.length);
    for (let i = sig.length - 1; i >= 0; i--) {
      const linear = lsb + i;
      if (linear >= total) throw new Error(`signal ${sig.name} reaches outside the ${payloadBytes}-byte payload`);
      out.push(linear);
    }
    return out;
  }

  let cur = sig.startBit;
  for (let i = 0; i < sig.length; i++) {
    if (cur < 0 || cur >= total) throw new Error(`signal ${sig.name} reaches outside the ${payloadBytes}-byte payload`);
    out.push(cur);
    if (i < sig.length - 1) cur = cur % 8 === 0 ? cur + 15 : cur - 1;
  }
  return out;
}

export function signalBitPositions(sig: SignalDef, payloadBytes = 8): BitPosition[] {
  return signalLinearBits(sig, payloadBytes).map((linear) => ({ linear, dbc: linear }));
}

export function extractRaw(data: ArrayLike<number>, sig: SignalDef): number | null {
  let bits: number[];
  try {
    bits = signalLinearBits(sig, data.length);
  } catch {
    return null;
  }
  let raw = 0;
  for (const linear of bits) {
    const byte = data[Math.floor(linear / 8)];
    if (byte === undefined) return null;
    raw = (raw << 1) | ((byte >> (linear % 8)) & 1);
  }
  return raw;
}

export function encodeRaw(data: number[], sig: SignalDef, rawValue: number): number[] {
  const bits = signalLinearBits(sig, data.length); // MSB -> LSB
  let value = rawValue >>> 0;
  for (let i = bits.length - 1; i >= 0; i--) {
    const linear = bits[i];
    const byteIndex = Math.floor(linear / 8);
    const bit = linear % 8;
    if (value & 1) data[byteIndex] |= 1 << bit;
    else data[byteIndex] &= ~(1 << bit);
    value >>>= 1;
  }
  return data;
}

export function signExtend(raw: number, length: number): number {
  if (length < 32 && raw >= 1 << (length - 1)) return raw - (1 << length);
  return raw;
}

export function applyScale(raw: number, factor: number, offset: number): number {
  return Number((raw * factor + offset).toFixed(9));
}

export function describeBitSpan(positions: BitPosition[]): string {
  const nums = [...new Set(positions.map((p) => p.dbc))].sort((a, b) => a - b);
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  const span = contiguous ? `bit ${nums[0]}..${nums[nums.length - 1]}` : `bits ${nums.join(',')}`;
  const bytes = [...new Set(nums.map((n) => Math.floor(n / 8)))].sort((a, b) => a - b);
  return `${span} (DBC), byte ${bytes.join(',')}`;
}
