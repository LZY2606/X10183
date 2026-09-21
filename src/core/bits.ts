import type { BitCell, BitSpan, ByteOrder } from "./types.js";

/** DBC bit 编号 -> (byte, bitInByte)，两套字节序的网格编号一致（MSB 为字节内小值）。 */
export function dbcToCell(dbcIndex: number): BitCell {
  return { byte: Math.floor(dbcIndex / 8), bit: 7 - (dbcIndex % 8) };
}

/** Intel(小端) bit 区间：从 LSB 起始位向高位连续走。返回顺序为 LSB→MSB。 */
export function intelSpan(startBit: number, length: number): BitSpan {
  const cells: BitCell[] = [];
  for (let i = 0; i < length; i++) {
    const p = startBit + i;
    cells.push({ byte: Math.floor(p / 8), bit: p % 8 });
  }
  return { cells, dbcStart: startBit };
}

/**
 * Motorola(大端) bit 区间。起始位为 MSB，随后向 LSB 移动；
 * 越过本字节边界后跳到下一高字节的 LSB 继续（“锯齿”），与 cantools/Vector 一致。
 * 返回顺序为 MSB→LSB。
 */
export function motorolaSpan(startBit: number, length: number): BitSpan {
  const cells: BitCell[] = [];
  const startByte = Math.floor(startBit / 8);
  const startCol = startBit % 8; // 字节内 DBC 列号（0=MSB）
  let byte = startByte;
  let col = startCol;
  for (let i = 0; i < length; i++) {
    cells.push({ byte, bit: 7 - col });
    if (i < length - 1) {
      if (col < 7) {
        col += 1;
      } else {
        byte += 1;
        col = 0;
      }
    }
  }
  return { cells, dbcStart: startBit };
}

export function spanFor(order: ByteOrder, startBit: number, length: number): BitSpan {
  return order === "intel" ? intelSpan(startBit, length) : motorolaSpan(startBit, length);
}

/** 按 bit 区间从数据中取原始无符号整数。span 顺序即位值序（首位为该序的最高位）。 */
export function readRawUnsigned(data: Buffer, span: BitSpan, order: ByteOrder): number {
  let value = 0;
  if (order === "intel") {
    // cells: LSB→MSB
    for (const cell of span.cells) {
      const b = (data[cell.byte] >> cell.bit) & 1;
      value = value | (b << (span.cells.indexOf(cell)));
    }
  } else {
    // cells: MSB→LSB
    for (let i = 0; i < span.cells.length; i++) {
      const cell = span.cells[i];
      const b = (data[cell.byte] >> cell.bit) & 1;
      value = (value << 1) | b;
    }
  }
  return value >>> 0;
}

export function readRaw(data: Buffer, span: BitSpan, order: ByteOrder, signed: boolean): number {
  const u = readRawUnsigned(data, span, order);
  if (!signed) return u;
  const n = span.cells.length;
  const signBit = 1 << (n - 1);
  return u & signBit ? u - (1 << n) : u;
}

/** 8×8 网格（行=字节0→7，列=MSB→LSB）中，Intel 编号到行列的换算，供 UI 布局。 */
export function intelIndexToGrid(index: number): { row: number; col: number } {
  return { row: Math.floor(index / 8), col: 7 - (index % 8) };
}

/** DBC bit 编号到网格行列。 */
export function dbcIndexToGrid(index: number): { row: number; col: number } {
  return { row: Math.floor(index / 8), col: index % 8 };
}

export function applyScale(raw: number, scale: number, offset: number): number {
  return raw * scale + offset;
}
