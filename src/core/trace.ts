import type { RawFrame } from './types.js';

export interface ParseOutcome {
  frames: RawFrame[];
  errors: string[];
}

function parseData(part: string): number[] {
  const cleaned = part
    .replace(/^0x/i, '')
    .replace(/[\s_]/g, '')
    .replace(/-/g, '');
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new Error(`bad data payload: ${part}`);
  const padded = cleaned.length % 2 === 0 ? cleaned : `0${cleaned}`;
  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 2) bytes.push(parseInt(padded.slice(i, i + 2), 16));
  return bytes;
}

/**
 * Accepted textual trace formats, auto-detected per line:
 *  - CSV:  generation,channel,id,X|S,rx|tx,hwtime,dlc,HEXDATA
 *  - JSONL: {"generation","channel","id","isExtended","direction","hwTime","dlc","data":[..]}
 * Header lines and blank lines are ignored.
 */
export function parseTrace(text: string): ParseOutcome {
  const frames: RawFrame[] = [];
  const errors: string[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    try {
      if (line.startsWith('{')) {
        const obj = JSON.parse(line);
        frames.push(normalizeJson(obj, index + 1));
        return;
      }
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 8 || /generation/i.test(parts[0])) return;
      const [genStr, chStr, idStr, fmt, dir, timeStr, dlcStr, ...dataParts] = parts;
      frames.push({
        generation: Number(genStr),
        channel: Number(chStr),
        id: Number(idStr),
        isExtended: fmt.toUpperCase() === 'X',
        direction: dir.toLowerCase(),
        hwTime: Number(timeStr),
        dlc: Number(dlcStr),
        data: parseData(dataParts.join(',')),
      });
    } catch (err) {
      errors.push(`line ${index + 1}: ${(err as Error).message}`);
    }
  });

  return { frames, errors };
}

function normalizeJson(obj: Record<string, unknown>, lineNo: number): RawFrame {
  const required = ['generation', 'channel', 'id', 'hwTime', 'data'];
  for (const key of required) {
    if (obj[key] === undefined) throw new Error(`JSONL line ${lineNo} missing field ${key}`);
  }
  const data = (obj.data as number[]).map(Number);
  return {
    generation: Number(obj.generation),
    channel: Number(obj.channel),
    id: Number(obj.id),
    isExtended: Boolean(obj.isExtended ?? obj.extended ?? false),
    direction: String(obj.direction ?? 'rx'),
    hwTime: Number(obj.hwTime),
    dlc: obj.dlc === undefined ? data.length : Number(obj.dlc),
    data,
  };
}
