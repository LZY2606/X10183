// 总线刻度 — Intel/Motorola 位布局编解码（纯函数，前后端与测试共享）
import type {
  BitCell, ByteOrder, DecodedSignal, MessageDef, SignalDef, ValTableEntry
} from './types.js';

/**
 * 计算信号占用的物理 bit 坐标，按信号权重 MSB->LSB 排列。
 *
 * DBC 物理位编号：字节 N 内 0x01 位编号为 N*8，0x80 位编号为 N*8+7。
 *  - Intel(小端)：start bit 是 LSB，其后各位物理编号严格 +1（连续锯齿）。
 *  - Motorola(大端)：start bit 是 MSB，起始字节内向编号小的方向走完，
 *    跨字节跳到下一个更高字节的 0x80 继续。
 */
export function bitCells(sig: Pick<SignalDef, 'startBit' | 'length' | 'byteOrder'>): BitCell[] {
  const cells: BitCell[] = [];
  if (sig.length <= 0) return cells;

  if (sig.byteOrder === 0) {
    // Motorola / big-endian，锯齿走法
    const startByte = Math.floor(sig.startBit / 8);
    const startBitInByte = sig.startBit % 8; // 0 = 该字节最右(0x01)
    for (let k = 0; k < sig.length; k++) {
      let p: number;
      if (k <= startBitInByte) {
        p = startByte * 8 + startBitInByte - k;
      } else {
        const t = k - startBitInByte - 1;
        const offsetInRow = t % 8;
        const row = Math.floor(t / 8) + 1;
        p = (startByte + row) * 8 + 7 - offsetInRow;
      }
      cells.push({
        byteIndex: Math.floor(p / 8),
        bitInByte: 7 - (p % 8),
        weightIndex: k
      });
    }
  } else {
    // Intel / little-endian：物理编号从 start 起严格递增（LSB->MSB），再反转为权重序
    for (let k = 0; k < sig.length; k++) {
      const p = sig.startBit + k;
      cells.unshift({
        byteIndex: Math.floor(p / 8),
        bitInByte: 7 - (p % 8),
        weightIndex: k
      });
    }
    cells.forEach((c, i) => {
      c.weightIndex = i;
    });
  }
  return cells;
}

/** 从原始字节按 bitCells 提取无符号值；任一 bit 超出 data 长度返回 null */
export function extractRaw(cells: BitCell[], data: Uint8Array): number | null {
  let value = 0;
  for (const cell of cells) {
    if (cell.byteIndex >= data.length) return null;
    const bit = (data[cell.byteIndex] >> (7 - cell.bitInByte)) & 1;
    value = value * 2 + bit;
  }
  return value;
}

/** 无符号 -> 二补码有符号 */
export function applySign(raw: number, length: number, signed: boolean): number {
  if (!signed) return raw;
  const limit = 2 ** length;
  return raw >= limit / 2 ? raw - limit : raw;
}

/** 物理值 = raw*factor + offset */
export function scale(raw: number, factor: number, bias: number): number {
  return raw * factor + bias;
}

export function enumLabel(table: ValTableEntry[], raw: number): string | null {
  const hit = table.find((e) => e.raw === raw);
  return hit ? hit.label : null;
}

/** 原始 bit 的紧凑描述（便于证据展示）："B0b7..B0b4,B1b7"（MSB->LSB） */
export function describeCells(cells: BitCell[]): string {
  const groups: string[] = [];
  let start: BitCell | null = null;
  let prev: BitCell | null = null;
  const flush = () => {
    if (!start) return;
    if (prev && start.byteIndex === prev.byteIndex && start.bitInByte === prev.bitInByte) {
      groups.push(`B${start.byteIndex}b${start.bitInByte}`);
    } else if (prev) {
      groups.push(`B${start.byteIndex}b${start.bitInByte}..B${prev.byteIndex}b${prev.bitInByte}`);
    }
  };
  for (const cell of cells) {
    const contig =
      prev && cell.byteIndex === prev.byteIndex && cell.bitInByte === prev.bitInByte + 1;
    if (!contig) {
      flush();
      start = cell;
    }
    prev = cell;
  }
  flush();
  return groups.join(',');
}

/** 还原原始 bit 串（0/1，MSB 在前），未知分支保留 raw bits 用 */
export function rawBitString(cells: BitCell[], data: Uint8Array): string {
  let out = '';
  for (const cell of cells) {
    if (cell.byteIndex >= data.length) {
      out += 'x';
    } else {
      out += String((data[cell.byteIndex] >> (7 - cell.bitInByte)) & 1);
    }
  }
  return out;
}

/** 解码单条消息的全部信号（含多路复用分支选择与未知分支保留） */
export function decodeMessage(
  message: MessageDef,
  data: Uint8Array
): DecodedSignal[] {
  const byMux = message.signals.find((s) => s.muxType === 'Mux');
  let muxRaw: number | null = null;
  if (byMux) {
    muxRaw = extractRaw(bitCells(byMux), data);
  }

  return message.signals.map((sig): DecodedSignal => {
    const cells = bitCells(sig);
    const overrun = cells.some((c) => c.byteIndex >= data.length);
    const base = {
      signalName: sig.name,
      startBit: sig.startBit,
      length: sig.length,
      byteOrder: sig.byteOrder,
      signed: sig.signed,
      factor: sig.factor,
      offset: sig.offset,
      unit: sig.unit,
      role: sig.role,
      muxType: sig.muxType,
      muxValue: sig.muxValue,
      bitCells: cells,
      overrun
    } as const;

    // 多路复用分支信号：开关值未知或不匹配 => 保留 raw bits
    if (typeof sig.muxType === 'string' && sig.muxType !== 'Mux') {
      if (muxRaw === null || sig.muxValue === null || muxRaw !== sig.muxValue) {
        return {
          ...base,
          rawValue: null,
          physValue: null,
          enumLabel: null,
          muxSkipped: true
        };
      }
    }

    const raw = extractRaw(cells, data);
    if (raw === null) {
      return {
        ...base,
        rawValue: null,
        physValue: null,
        enumLabel: null,
        muxSkipped: false
      };
    }
    const signedRaw = applySign(raw, sig.length, sig.signed);
    const phys = scale(signedRaw, sig.factor, sig.offset);
    return {
      ...base,
      rawValue: raw,
      physValue: Number.isFinite(phys) ? Number(phys.toFixed(9)) : phys,
      enumLabel: enumLabel(sig.valTable ?? [], raw),
      muxSkipped: false
    };
  });
}

/** 选择在某个硬件时间点生效的 DBC 版本（半开区间，左闭右开） */
export function pickVersionAt<T extends {
  effectiveFromNs: number | null;
  effectiveToNs: number | null;
}>(versions: T[], hwTimeNs: number): T | null {
  const hit = versions.find(
    (v) =>
      (v.effectiveFromNs === null || hwTimeNs >= v.effectiveFromNs) &&
      (v.effectiveToNs === null || hwTimeNs < v.effectiveToNs)
  );
  return hit ?? null;
}
