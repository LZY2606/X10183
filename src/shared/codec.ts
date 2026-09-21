import type {
  BitCell,
  ByteOrder,
  MessageDef,
  SignalDef,
} from './types.js';

/** DBC 锯齿轮位置 -> 物理 (byteIndex, bitInByte 7..0) */
export function sawtoothToCell(p: number): BitCell {
  const byteIndex = Math.floor(p / 8);
  const bitInByte = 7 - (p % 8);
  return { byteIndex, bitInByte, wireBit: byteIndex * 8 + (7 - bitInByte) };
}

/** Intel: startBit 是 LSB，向高位逐 bit 行进（小端） */
export function intelBits(startBit: number, length: number): BitCell[] {
  const cells: BitCell[] = [];
  for (let p = startBit; p < startBit + length; p++) cells.push(sawtoothToCell(p));
  return cells;
}

/**
 * Motorola big_endian, DBC sawtooth: startBit 是 MSB。
 * 沿值 bit 高到低行进：行内向低位走，到 LSB 后跳到下一行 MSB (+15)。
 */
export function motorolaBits(startBit: number, length: number): BitCell[] {
  const cells: BitCell[] = [];
  let p = startBit;
  for (let i = 0; i < length; i++) {
    cells.push(sawtoothToCell(p));
    if (p % 8 === 0) p += 15;
    else p -= 1;
  }
  return cells;
}

export function signalCells(sig: Pick<SignalDef, 'startBit' | 'length' | 'byteOrder'>): BitCell[] {
  return sig.byteOrder === 'motorola'
    ? motorolaBits(sig.startBit, sig.length)
    : intelBits(sig.startBit, sig.length);
}

function cellMaxByte(cells: BitCell[]): number {
  return cells.reduce((m, c) => Math.max(m, c.byteIndex), 0);
}

export function readBits(data: ArrayLike<number>, cells: BitCell[]): number {
  let value = 0;
  for (const c of cells) {
    const bit = ((data[c.byteIndex] ?? 0) >> c.bitInByte) & 1;
    value = (value << 1) | bit;
  }
  return value;
}

export function interpretSigned(raw: number, length: number, signed: boolean): number {
  if (!signed) return raw;
  const signBit = 1 << (length - 1);
  return (raw ^ signBit) - signBit;
}

export function physicalValue(raw: number, factor: number, offset: number): number {
  const v = raw * factor + offset;
  return Math.abs(v) < 1e-12 ? 0 : v;
}

export function enumLabelFor(sig: SignalDef, raw: number): string | undefined {
  return sig.valueTable?.[String(raw)];
}

export function encodeBits(data: number[], cells: BitCell[], raw: number): number[] {
  const out = data.slice();
  const need = cellMaxByte(cells) + 1;
  while (out.length < need) out.push(0);
  let v = raw;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    out[c.byteIndex] = (out[c.byteIndex] & ~(1 << c.bitInByte)) | ((v & 1) << c.bitInByte);
    v >>>= 1;
  }
 return out;
}

export function encodeSignal(data: number[], sig: SignalDef, raw: number): number[] {
  return encodeBits(data, signalCells(sig), raw);
}

export function physicalToRaw(sig: SignalDef, physical: number): number {
  return Math.round((physical - sig.offset) / sig.factor);
}

export function orderLabel(bo: ByteOrder): string {
  return bo === 'motorola' ? 'Motorola (big-endian)' : 'Intel (little-endian)';
}

export function frameByteLength(msg: MessageDef | undefined, dataLen: number): number {
  return Math.max(msg?.dlc ?? 0, dataLen);
}
