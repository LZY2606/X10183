export type ByteOrder = 'intel' | 'motorola';

export type MuxRole =
  | { kind: 'none' }
  | { kind: 'switch' }
  | { kind: 'value'; switchValues: number[] };

export interface SignalDef {
  name: string;
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  min: number | null;
  max: number | null;
  unit: string;
  receivers: string[];
  mux: MuxRole;
  enumValues: Record<number, string>;
}

export interface MessageDef {
  id: number;
  extended: boolean;
  name: string;
  dlc: number;
  transmitter: string;
  signals: SignalDef[];
}

export interface DbcDefinition {
  messages: MessageDef[];
}

const EXTENDED_FLAG = 0x80000000;

export function parseDbc(content: string): DbcDefinition {
  const messages: MessageDef[] = [];
  const byId = new Map<number, MessageDef>();
  let current: MessageDef | null = null;

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const bo = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/.exec(line);
    if (bo) {
      const rawId = Number(bo[1]);
      const extended = (rawId & EXTENDED_FLAG) !== 0;
      const id = extended ? rawId & ~EXTENDED_FLAG : rawId;
      current = {
        id,
        extended,
        name: bo[2],
        dlc: Number(bo[3]),
        transmitter: bo[4],
        signals: [],
      };
      messages.push(current);
      byId.set(id, current);
      continue;
    }

    const sg = /^SG_\s+(\w+)\s*(M|m(\d+)M?)?\s*:\s*(\d+)\|(\d+)@(0|1)([+-])\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*\[\s*([^|]*)\|([^\]]*)\]\s*"([^"]*)"\s*(.*)$/.exec(line);
    if (sg && current) {
      const muxToken = sg[2];
      let mux: MuxRole = { kind: 'none' };
      if (muxToken === 'M') {
        mux = { kind: 'switch' };
      } else if (muxToken && muxToken.startsWith('m')) {
        mux = { kind: 'value', switchValues: [Number(sg[3])] };
      }
      const receivers = sg[13]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      current.signals.push({
        name: sg[1],
        startBit: Number(sg[4]),
        length: Number(sg[5]),
        byteOrder: sg[6] === '1' ? 'intel' : 'motorola',
        signed: sg[7] === '-',
        scale: Number(sg[8]),
        offset: Number(sg[9]),
        min: sg[10] === '' ? null : Number(sg[10]),
        max: sg[11] === '' ? null : Number(sg[11]),
        unit: sg[12],
        receivers,
        mux,
        enumValues: {},
      });
      continue;
    }

    const val = /^VAL_\s+(\d+)\s+(\w+)\s+(.*?)\s*;\s*$/.exec(line);
    if (val) {
      const rawId = Number(val[1]);
      const id = rawId & ~EXTENDED_FLAG;
      const msg = byId.get(id);
      if (msg) {
        const sig = msg.signals.find((s) => s.name === val[2]);
        if (sig) {
          const pairRe = /(-?\d+)\s+"([^"]*)"/g;
          let m: RegExpExecArray | null;
          while ((m = pairRe.exec(val[3])) !== null) {
            sig.enumValues[Number(m[1])] = m[2];
          }
        }
      }
      continue;
    }

    const muxVal = /^SG_MUL_VAL_\s+(\d+)\s+(\w+)\s+(\w+)\s+(.+?)\s*;\s*$/.exec(line);
    if (muxVal) {
      const rawId = Number(muxVal[1]);
      const id = rawId & ~EXTENDED_FLAG;
      const msg = byId.get(id);
      if (msg) {
        const sig = msg.signals.find((s) => s.name === muxVal[2]);
        if (sig && sig.mux.kind === 'value') {
          const values: number[] = [];
          for (const part of muxVal[4].split(',')) {
            const range = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(part);
            if (range) {
              const a = Number(range[1]);
              const b = Number(range[2]);
              for (let v = Math.min(a, b); v <= Math.max(a, b); v++) values.push(v);
            } else {
              const single = /^\s*(-?\d+)\s*$/.exec(part);
              if (single) values.push(Number(single[1]));
            }
          }
          sig.mux = { kind: 'value', switchValues: values };
        }
      }
      continue;
    }
  }

  return { messages };
}

export function findMessage(
  def: DbcDefinition,
  arbitrationId: number,
  extended: boolean,
): MessageDef | null {
  for (const msg of def.messages) {
    if (msg.id === arbitrationId && msg.extended === extended) return msg;
  }
  return null;
}
