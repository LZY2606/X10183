import type { DB } from './db.js';
import type { RawFrame } from '../src/types.js';
import { bytesToHex } from './bitops.js';

function coerceData(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((v) => Number(v) & 0xff);
  if (typeof value === 'string') {
    const hex = value.startsWith('0x') ? value.slice(2) : value.replace(/\s+/g, '');
    const out: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  throw new Error('无法识别的 data 字段');
}

function normalizeFrame(obj: Record<string, unknown>, index: number): RawFrame {
  const arbId = obj.arbId ?? obj.id ?? obj.canId ?? obj.arbitration;
  const hwTime = obj.hwTime ?? obj.time ?? obj.timestamp ?? obj.hw_time;
  const channel = obj.channel ?? obj.bus ?? 0;
  const extended = obj.extended ?? obj.ext ?? obj.isExtended ?? false;
  if (arbId === undefined || hwTime === undefined) {
    throw new Error(`第 ${index + 1} 行缺少 arbId 或 hwTime`);
  }
  const idNum = Math.floor(Number(arbId));
  if (!Number.isFinite(idNum) || idNum < 0 || idNum > 0x1fffffff) {
    throw new Error(`第 ${index + 1} 行 arbitration id 越界`);
  }
  const t = Number(hwTime);
  if (!Number.isFinite(t) || t < 0) throw new Error(`第 ${index + 1} 行硬件时间非法`);
  return {
    channel: Math.floor(Number(channel)),
    arbId: idNum,
    extended: Boolean(extended) || (typeof arbId === 'number' && arbId > 0x7ff),
    hwTime: t,
    data: coerceData(obj.data ?? obj.bytes ?? '')
  };
}

export function parseTraceText(text: string): RawFrame[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parseJson(trimmed);
  if (/^[\s-]*\d+\.\d+\s/.test(trimmed)) return parseAsc(text);
  return parseCsv(text);
}

function parseJson(text: string): RawFrame[] {
  const parsed = JSON.parse(text) as unknown;
  const arr = Array.isArray(parsed)
    ? parsed
    : ((parsed as { frames?: unknown[] }).frames ?? (parsed as { trace?: unknown[] }).trace);
  if (!Array.isArray(arr)) throw new Error('JSON 必须是数组或含 frames 字段');
  return arr.map((v, i) => normalizeFrame(v as Record<string, unknown>, i));
}

function parseCsv(text: string): RawFrame[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iCh = idx(['channel', 'bus', 'ch']);
  const iId = idx(['arb_id', 'arbid', 'id', 'canid']);
  const iExt = idx(['extended', 'ext', 'is_extended']);
  const iTime = idx(['hw_time', 'hwtime', 'time', 'timestamp']);
  const iData = idx(['data', 'bytes', 'payload']);
  if (iId < 0 || iTime < 0) throw new Error('CSV 表头需要包含 id 与 hw_time 列');
  return lines.slice(1).map((line, row) => {
    const cols = line.split(',');
    return normalizeFrame(
      {
        channel: iCh >= 0 ? cols[iCh] : 0,
        arbId: cols[iId],
        extended: iExt >= 0 ? /^(1|true|x|ext)$/i.test(cols[iExt].trim()) : false,
        hwTime: cols[iTime],
        data: iData >= 0 ? cols[iData] : ''
      },
      row
    );
  });
}

// Vector ASC 简化形式：  0.123456 1  1A2 Rx d 8 01 02 ...   (扩展以 x 标记)
function parseAsc(text: string): RawFrame[] {
  const out: RawFrame[] = [];
  const re = /^\s*(\d+\.\d+)\s+(\d+)\s+([0-9A-Fa-f]+)(x?)\s+(?:Rx|Tx)\s+d\s+(\d)\s+(.*)$/;
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(re);
    if (!m) return;
    const dlc = parseInt(m[5], 10);
    const bytes = m[6].trim().split(/\s+/).slice(0, dlc).map((b) => parseInt(b, 16));
    out.push({
      channel: parseInt(m[2], 10),
      arbId: parseInt(m[3], 16),
      extended: m[4] === 'x',
      hwTime: parseFloat(m[1]),
      data: bytes
    });
  });
  return out;
}

export interface ImportResult {
  importId: number;
  importGen: number;
  frameCount: number;
}

export function importTrace(db: DB, name: string, frames: RawFrame[]): ImportResult {
  const tx = db.transaction((rows: RawFrame[]) => {
    const info = db.prepare('INSERT INTO trace_imports (name) VALUES (?)').run(name);
    const importId = Number(info.lastInsertRowid);
    const genRow = db.prepare('SELECT COUNT(*) AS c FROM trace_imports').get() as { c: number };
    const importGen = genRow.c;
    const stmt = db.prepare(
      `INSERT INTO frames (import_id, import_gen, channel, arb_id, extended, hw_time, data_hex)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of rows) {
      if (f.data.length > 8) throw new Error('CAN 2.0 数据最多 8 字节');
      stmt.run(
        importId,
        importGen,
        f.channel,
        f.arbId,
        f.extended ? 1 : 0,
        f.hwTime,
        bytesToHex(f.data)
      );
    }
    db.prepare('UPDATE trace_imports SET frame_count = ? WHERE id = ?').run(rows.length, importId);
    return { importId, importGen, frameCount: rows.length };
  });
  return tx(frames);
}
