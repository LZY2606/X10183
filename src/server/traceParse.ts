import type { IdKind, RawFrameInput } from '../shared/types.js';
import { normalizeIdKind } from '../shared/types.js';

/** 解析数据字段：hex 空格串 "DE AD BE"、"0xDE,0xAD"、数字数组 */
export function parseData(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => parseData(String(v)));
  }
  const s = String(value ?? '').trim();
  if (!s) return [];
  const tokens = s.split(/[\s,]+/).filter(Boolean);
  return tokens.map((t) => {
    const n = /^0x/i.test(t) ? parseInt(t, 16) : /[a-f]/i.test(t) ? parseInt(t, 16) : Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 255) {
      throw new Error(`无效数据字节: ${t}`);
    }
    return n;
  });
}

function parseId(value: unknown): { id: number; kind?: IdKind } {
  if (typeof value === 'number') return { id: value >>> 0 };
  const s = String(value).trim();
  const id = /^0x/i.test(s) || /[a-f]/i.test(s) ? parseInt(s, 16) : Number(s);
  if (!Number.isFinite(id) || id < 0 || id > 0x1fffffff) {
    throw new Error(`无效 arbitration id: ${s}`);
  }
  return { id: id >>> 0 };
}

/**
 * 接受:
 *  - RawFrameInput[] JSON
 *  - NDJSON（每行一个对象）
 *  - CSV，表头需含 id 与 data；可选 hwTimeMs/hwTimeSec/channel/generation/idKind/txNode
 */
export function parseTraceInput(text: string): RawFrameInput[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('trace 内容为空');

  if (trimmed.startsWith('[')) {
    return normalizeMany(JSON.parse(trimmed) as RawFrameInput[]);
  }
  if (trimmed.startsWith('{')) {
    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('{'));
    if (lines.length === 0) throw new Error('trace JSON 无有效行');
    return normalizeMany(lines.map((l) => JSON.parse(l) as RawFrameInput));
  }
  return parseCsv(trimmed);
}

function normalizeMany(rows: RawFrameInput[]): RawFrameInput[] {
  return rows.map((r) => {
    const { id } = parseId(r.id);
    const idKind = r.idKind ?? normalizeIdKind(id);
    const data = parseData(r.data);
    return {
      ...r,
      id,
      idKind,
      data,
      channel: r.channel ?? 0,
    };
  });
}

function parseCsv(text: string): RawFrameInput[] {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error('CSV 需要表头与至少一行数据');
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iId = idx('id');
  const iData = idx('data');
  if (iId === -1 || iData === -1) throw new Error('CSV 表头需包含 id 与 data 列');
  const iTimeMs = idx('hwtimems') !== -1 ? idx('hwtimems') : idx('time_ms');
  const iTimeSec = idx('hwtimesec') !== -1 ? idx('hwtimesec') : idx('time_sec');
  const iCh = idx('channel') !== -1 ? idx('channel') : idx('bus');
  const iGen = idx('generation') !== -1 ? idx('generation') : idx('gen');
  const iKind = idx('idkind') !== -1 ? idx('idkind') : idx('frame');
  const iNode = idx('txnode') !== -1 ? idx('txnode') : idx('node');

  return rows.slice(1).filter((r) => r.some((c) => c.trim() !== '')).map((cols) => {
    const { id } = parseId(cols[iId]);
    const kindRaw = iKind === -1 ? undefined : cols[iKind]?.trim().toLowerCase();
    const idKind: IdKind | undefined =
      kindRaw === 'ext' || kindRaw === 'extended'
        ? 'extended'
        : kindRaw === 'std' || kindRaw === 'standard'
          ? 'standard'
          : undefined;
    return {
      id,
      idKind: idKind ?? normalizeIdKind(id),
      data: parseData(cols[iData]),
      hwTimeMs: iTimeMs !== -1 && cols[iTimeMs] ? Number(cols[iTimeMs]) : undefined,
      hwTimeSec: iTimeSec !== -1 && cols[iTimeSec] ? Number(cols[iTimeSec]) : undefined,
      channel: iCh !== -1 ? cols[iCh] : 0,
      generation: iGen !== -1 ? cols[iGen] : undefined,
      txNode: iNode !== -1 ? cols[iNode] : undefined,
    };
  });
}

/** 支持引号与引号内逗号的最小 CSV 解析 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
