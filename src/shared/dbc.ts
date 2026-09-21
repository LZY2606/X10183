export type ByteOrder = 'intel' | 'motorola';
export type MuxRole = 'none' | 'multiplexor' | 'multiplexed';

export interface SignalDef {
  name: string;
  startBit: number;
  bitLength: number;
  byteOrder: ByteOrder;
  isSigned: boolean;
  factor: number;
  offset: number;
  min: number | null;
  max: number | null;
  unit: string;
  muxRole: MuxRole;
  muxValues: number[];
  enumMap: Record<number, string>;
  receiver: string;
}

export interface MessageDef {
  arbitrationId: number;
  isExtended: boolean;
  name: string;
  dlc: number;
  sender: string;
  signals: SignalDef[];
}

export interface DbcFile {
  messages: MessageDef[];
}

const EXTENDED_FLAG = 0x80000000;

export function normalizeArbitrationId(raw: number): { id: number; isExtended: boolean } {
  if (raw & EXTENDED_FLAG) return { id: raw & 0x1fffffff, isExtended: true };
  if (raw > 0x7ff) return { id: raw, isExtended: true };
  return { id: raw, isExtended: false };
}

export function parseDbc(content: string): DbcFile {
  const messages: MessageDef[] = [];
  const byArbKey = new Map<string, MessageDef>();
  let current: MessageDef | null = null;
  const pendingMux: { msgKey: string; signal: string; ranges: number[] }[] = [];
  const pendingEnum: { msgKey: string; signal: string; map: Record<number, string> }[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    let m: RegExpMatchArray | null;

    if ((m = line.match(/^BO_\s+(\d+)\s+([A-Za-z_][\w]*)\s*:\s*(\d+)\s+([A-Za-z_][\w]*)/))) {
      const rawId = Number(m[1]);
      const { id, isExtended } = normalizeArbitrationId(rawId);
      current = {
        arbitrationId: id,
        isExtended,
        name: m[2],
        dlc: Number(m[3]),
        sender: m[4],
        signals: [],
      };
      messages.push(current);
      byArbKey.set(`${isExtended ? 'x' : 's'}:${id}`, current);
      continue;
    }

    if (
      (m = line.match(
        /^SG_\s+([A-Za-z_][\w]*)\s*(M|m(\d+)M?)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)\s*\[\s*([-+0-9.eE]*)\s*\|\s*([-+0-9.eE]*)\s*\]\s*"([^"]*)"\s*(.*)$/,
      ))
    ) {
      if (!current) continue;
      const muxToken = m[2];
      const sig: SignalDef = {
        name: m[1],
        startBit: Number(m[4]),
        bitLength: Number(m[5]),
        byteOrder: m[6] === '1' ? 'intel' : 'motorola',
        isSigned: m[7] === '-',
        factor: Number(m[8]),
        offset: Number(m[9]),
        min: m[10] === '' ? null : Number(m[10]),
        max: m[11] === '' ? null : Number(m[11]),
        unit: m[12],
        muxRole: muxToken === 'M' ? 'multiplexor' : muxToken ? 'multiplexed' : 'none',
        muxValues: muxToken && muxToken !== 'M' && m[3] !== undefined ? [Number(m[3])] : [],
        enumMap: {},
        receiver: (m[13] ?? '').trim(),
      };
      current.signals.push(sig);
      continue;
    }

    if ((m = line.match(/^VAL_\s+(\d+)\s+([A-Za-z_][\w]*)\s+(.*?)\s*;\s*$/))) {
      const { id, isExtended } = normalizeArbitrationId(Number(m[1]));
      const map: Record<number, string> = {};
      const pairRe = /(-?\d+)\s+"([^"]*)"/g;
      let p: RegExpExecArray | null;
      while ((p = pairRe.exec(m[3]))) map[Number(p[1])] = p[2];
      pendingEnum.push({ msgKey: `${isExtended ? 'x' : 's'}:${id}`, signal: m[2], map });
      continue;
    }

    if ((m = line.match(/^SG_MUL_VAL_\s+(\d+)\s+([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)\s+(.+?)\s*;\s*$/))) {
      const { id, isExtended } = normalizeArbitrationId(Number(m[1]));
      const ranges: number[] = [];
      for (const part of m[4].split(',')) {
        const r = part.trim().match(/^(-?\d+)\s*-\s*(-?\d+)$/);
        if (r) {
          for (let v = Number(r[1]); v <= Number(r[2]); v++) ranges.push(v);
        } else if (/^-?\d+$/.test(part.trim())) {
          ranges.push(Number(part.trim()));
        }
      }
      pendingMux.push({ msgKey: `${isExtended ? 'x' : 's'}:${id}`, signal: m[2], ranges });
      continue;
    }
  }

  for (const e of pendingEnum) {
    const msg = byArbKey.get(e.msgKey);
    const sig = msg?.signals.find((s) => s.name === e.signal);
    if (sig) sig.enumMap = e.map;
  }
  for (const mx of pendingMux) {
    const msg = byArbKey.get(mx.msgKey);
    const sig = msg?.signals.find((s) => s.name === mx.signal);
    if (sig && sig.muxRole === 'multiplexed') sig.muxValues = mx.ranges;
  }

  return { messages };
}
