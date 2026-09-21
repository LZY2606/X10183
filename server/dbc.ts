import type { SignalDef, ByteOrder } from './bitdecode';

export interface MessageDef {
  /** arbitration id without the extended-flag bit */
  id: number;
  isExtended: boolean;
  name: string;
  dlc: number;
  sender: string;
  signals: SignalDef[];
}

export interface DbcFile {
  messages: MessageDef[];
  /** lookup key: `${id}:${isExtended ? 'x' : 's'}` */
  byKey: Map<string, MessageDef>;
}

export function messageKey(id: number, isExtended: boolean): string {
  return `${id}:${isExtended ? 'x' : 's'}`;
}

const SG_RE =
  /^\s*SG_\s+(\w+)\s*(?:(m\d+M?|M)\s*)?:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)\s*\[\s*([-\d.eE+]+)\s*\|\s*([-\d.eE+]+)\s*\]\s*"([^"]*)"\s*(.*)$/;

/** Parse the subset of DBC needed for decoding: BO_, SG_, VAL_, and the
 *  BusScaleCounter signal attribute. Extended ids use the DBC 0x80000000 flag. */
export function parseDbc(content: string): DbcFile {
  const messages: MessageDef[] = [];
  let current: MessageDef | null = null;
  const pendingEnums: { msgId: number; isExtended: boolean; signal: string; table: Record<number, string> }[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('BO_ ')) {
      const m = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/.exec(line);
      if (!m) continue;
      let id = Number(m[1]);
      const isExtended = (id & 0x80000000) !== 0;
      if (isExtended) id &= 0x1fffffff;
      current = { id, isExtended, name: m[2], dlc: Number(m[3]), sender: m[4], signals: [] };
      messages.push(current);
      continue;
    }
    if (line.startsWith('SG_ ') && current) {
      const m = SG_RE.exec(rawLine);
      if (!m) continue;
      const muxToken = m[2];
      let mux: SignalDef['mux'] = { role: 'none' };
      if (muxToken === 'M') mux = { role: 'multiplexor' };
      else if (muxToken && /^m\d+M?$/.test(muxToken)) mux = { role: 'multiplexed', switchValue: Number(muxToken.slice(1).replace(/M$/, '')) };
      current.signals.push({
        name: m[1],
        mux,
        startBit: Number(m[3]),
        length: Number(m[4]),
        byteOrder: (m[5] === '1' ? 'intel' : 'motorola') as ByteOrder,
        signed: m[6] === '-',
        factor: Number(m[7]),
        offset: Number(m[8]),
        min: Number(m[9]),
        max: Number(m[10]),
        unit: m[11] || undefined,
        enumValues: {},
        isCounter: false,
      });
      continue;
    }
    if (line.startsWith('VAL_ ')) {
      const m = /^VAL_\s+(\d+)\s+(\w+)\s+(.*?)\s*;\s*$/.exec(line);
      if (!m) continue;
      let id = Number(m[1]);
      const isExtended = (id & 0x80000000) !== 0;
      if (isExtended) id &= 0x1fffffff;
      const table: Record<number, string> = {};
      const re = /(-?\d+)\s+"([^"]*)"/g;
      let em: RegExpExecArray | null;
      while ((em = re.exec(m[3]))) table[Number(em[1])] = em[2];
      pendingEnums.push({ msgId: id, isExtended, signal: m[2], table });
      continue;
    }
    if (line.startsWith('BA_ ')) {
      // BA_ "BusScaleCounter" SG_ <msgId> <signal> 1;
      const m = /^BA_\s+"BusScaleCounter"\s+SG_\s+(\d+)\s+(\w+)\s+(\d+)\s*;/.exec(line);
      if (m) {
        let id = Number(m[1]);
        const isExtended = (id & 0x80000000) !== 0;
        if (isExtended) id &= 0x1fffffff;
        const msg = messages.find((mm) => mm.id === id && mm.isExtended === isExtended);
        const sig = msg?.signals.find((s) => s.name === m[2]);
        if (sig) sig.isCounter = m[3] !== '0';
      }
      continue;
    }
  }

  for (const e of pendingEnums) {
    const msg = messages.find((mm) => mm.id === e.msgId && mm.isExtended === e.isExtended);
    const sig = msg?.signals.find((s) => s.name === e.signal);
    if (sig) sig.enumValues = e.table;
  }

  const byKey = new Map<string, MessageDef>();
  for (const m of messages) byKey.set(messageKey(m.id, m.isExtended), m);
  return { messages, byKey };
}

export interface DecodedMessageSignal {
  name: string;
  value: number;
  rawHex: string;
  enumLabel?: string;
  unit?: string;
  byteOrder: string;
  factor: number;
  offset: number;
  bitRanges: { start: number; end: number }[];
  bitPositions: number[];
  muxRole: string;
  muxSwitchValue?: number;
  isCounter: boolean;
}
