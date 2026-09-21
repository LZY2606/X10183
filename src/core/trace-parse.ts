import type { FrameInput } from './types';

/**
 * 支持两种导入：
 * 1) JSON：[{arbId, extended, channel, hwTimeNs, generation, dataHex}, ...]
 * 2) 每行：(timeNs|timeSec) (id#data 或 id##data 表示扩展帧) [gen=N] [ch=通道]
 *    例：0001200 0x1A0#01 02 03   gen=0 ch=CAN1
 *        0.002 18FEF100##11 22    gen=1
 */
export function parseTrace(text: string): FrameInput[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const json = JSON.parse(trimmed);
    const arr = Array.isArray(json) ? json : json.frames;
    if (!Array.isArray(arr)) throw new Error('JSON trace 必须是数组或 {frames: [...]}');
    return arr.map(normalizeJsonFrame);
  }

  const frames: FrameInput[] = [];
  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    frames.push(parseLine(line));
  }
  return frames;
}

function normalizeJsonFrame(o: Record<string, unknown>): FrameInput {
  const arbId = Number(o.arbId ?? o.id ?? o.canId);
  if (!Number.isFinite(arbId)) throw new Error('帧缺少 arbId');
  return {
    arbId,
    extended: Boolean(o.extended ?? o.isExtended ?? false),
    channel: (o.channel as string | null) ?? null,
    hwTimeNs: Number(o.hwTimeNs ?? o.timeNs ?? o.timestampNs),
    generation: Number(o.generation ?? o.gen ?? 0),
    dataHex: String(o.dataHex ?? o.data ?? '').replace(/^0x/i, ''),
  };
}

function parseId(part: string): { arbId: number; extended: boolean } {
  if (part.includes('##')) {
    const [id] = part.split('##');
    return { arbId: parseNum(id), extended: true };
  }
  const [id] = part.split('#');
  return { arbId: parseNum(id), extended: false };
}

function parseNum(s: string): number {
  const t = s.trim().toLowerCase();
  if (t.startsWith('0x')) return parseInt(t.slice(2), 16);
  if (/^[0-9]+$/.test(t)) return Number(t);
  return parseInt(t, 16);
}

function parseLine(line: string): FrameInput {
  const tokens = line.split(/\s+/);
  let timeNs: number;
  let rest: string[];
  const t0 = tokens[0];
  if (t0.includes('.') && !t0.startsWith('0x')) {
    timeNs = Math.round(Number(t0) * 1_000_000_000);
    rest = tokens.slice(1);
  } else {
    timeNs = parseNum(t0);
    rest = tokens.slice(1);
  }

  const hashIdx = rest.findIndex((t) => t.includes('#'));
  if (hashIdx === -1) throw new Error(`无法解析帧行: ${line}`);
  const hashToken = rest[hashIdx];
  const dataParts: string[] = [];
  // hashToken 可能是 "0x1A0#01" 或 "1A0#"
  const [idPart, firstData] = splitHash(hashToken);
  if (firstData) dataParts.push(firstData);
  let idx = hashIdx + 1;
  while (idx < rest.length && !rest[idx].includes('=') && !rest[idx].includes('#')) {
    dataParts.push(rest[idx]);
    idx++;
  }
  const { arbId, extended } = parseId(idPart.includes('##') ? idPart : `${idPart}#`);

  let generation = 0;
  let channel: string | null = null;
  for (let i = idx; i < rest.length; i++) {
    const m = rest[i].match(/^(gen|generation)=(.+)$/);
    if (m) generation = Number(m[2]);
    const c = rest[i].match(/^ch(annel)?=(.+)$/);
    if (c) channel = c[2];
  }

  return {
    arbId,
    extended,
    channel,
    hwTimeNs: timeNs,
    generation,
    dataHex: dataParts.join(''),
  };
}

function splitHash(token: string): [string, string] {
  const i = token.indexOf('#');
  const doubled = token.startsWith('#', i + 1);
  if (doubled) {
    return [token.slice(0, i + 2), token.slice(i + 2)];
  }
  return [token.slice(0, i + 1), token.slice(i + 1)];
}
