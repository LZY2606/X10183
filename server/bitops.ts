import type { ByteOrder } from '../src/types.js';

// 线性网格（与 cantools 一致）：byte b 的 MSB(bit7)=8b … LSB(bit0)=8b+7。
// cells 返回值位 MSB→LSB 的网格下标。

export function intelCells(startBit: number, length: number): number[] {
  // 从 LSB 起点沿网格向更高值位走：字节内网格递减；抵达 MSB(行首)后跨入下一字节 LSB。
  // 最后反转为值位 MSB→LSB。
  const b = Math.floor(startBit / 8);
  const r = startBit % 8;
  const lsbFirst: number[] = [];
  let cell = b * 8 + (7 - r);
  for (let k = 0; k < length; k++) {
    lsbFirst.push(cell);
    cell = cell % 8 === 0 ? cell + 15 : cell - 1;
  }
  return lsbFirst.reverse();
}

export function motorolaCells(startBit: number, length: number): number[] {
  // 起点为 MSB。同字节内朝 LSB 走（网格递增），到行尾跨入下一字节 MSB。
  const b = Math.floor(startBit / 8);
  const r = startBit % 8;
  const s = 7 - r;
  const cells: number[] = [];
  for (let k = 0; k < length; k++) {
    const p = s + k;
    const byte = b + Math.floor(p / 8);
    const off = p % 8;
    cells.push(byte * 8 + off);
  }
  return cells;
}

export function signalCells(byteOrder: ByteOrder, startBit: number, length: number): number[] {
  return byteOrder === 'intel'
    ? intelCells(startBit, length)
    : motorolaCells(startBit, length);
}

export function extractRaw(data: number[], cells: number[]): number {
  let raw = 0;
  const totalBits = data.length * 8;
  for (const cell of cells) {
    raw = (raw << 1) >>> 0;
    if (cell >= 0 && cell < totalBits) {
      const byte = data[Math.floor(cell / 8)] ?? 0;
      const row = cell % 8; // 0=MSB … 7=LSB
      if ((byte >> (7 - row)) & 1) raw = (raw | 1) >>> 0;
    }
  }
  return raw >>> 0;
}

export function toSigned(raw: number, length: number): number {
  if (length >= 32) return raw | 0;
  const max = 2 ** (length - 1);
  return raw >= max ? raw - 2 ** length : raw;
}

export function rawBitsString(data: number[], cells: number[]): string {
  const totalBits = data.length * 8;
  return cells
    .map((cell) => (cell >= 0 && cell < totalBits
      ? String((data[Math.floor(cell / 8)] >> (7 - (cell % 8))) & 1)
      : '0'))
    .join('');
}

export function bytesToHex(data: number[]): string {
  return data.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}
