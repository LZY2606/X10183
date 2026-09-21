import type { ByteOrder } from './bits';

export type SignalRole = 'counter' | 'crc';

export interface SignalDef {
  name: string;
  start: number;
  length: number;
  order: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  min: number | null;
  max: number | null;
  unit: string;
  receiver: string;
  mux: { type: 'static' } | { type: 'multiplexor' } | { type: 'multiplexed'; value: number };
  values: Record<number, string>;
  role: SignalRole | null;
}

export interface CrcRule {
  polynomial?: number;
  init?: number;
  xorOut?: number;
  startByte?: number;
  endByte?: number; // exclusive
}

export interface MessageDef {
  id: number;
  extended: boolean;
  name: string;
  dlc: number;
  sender: string;
  signals: SignalDef[];
  crcRule: CrcRule | null;
}

export interface DbcDef {
  messages: MessageDef[];
}

export function messageKey(id: number, extended: boolean): string {
  return `${extended ? 'x' : 's'}:${id.toString(16)}`;
}

export function findMessage(dbc: DbcDef, id: number, extended: boolean): MessageDef | undefined {
  return dbc.messages.find((m) => m.id === id && m.extended === extended);
}

const EXTENDED_FLAG = 0x80000000;

function splitRawId(rawId: number): { id: number; extended: boolean } {
  if (rawId & EXTENDED_FLAG) {
    return { id: rawId & 0x1fffffff, extended: true };
  }
  return { id: rawId, extended: false };
}

const BO_RE = /^BO_\s+(\d+)\s+([A-Za-z_][\w]*)\s*:\s*(\d+)\s+([A-Za-z_][\w]*)/;
const SG_RE =
  /^SG_\s+([A-Za-z_][\w]*)\s*(?:(M)|m(\d+))?\s*:\s*(\d+)\|(\d+)@(0|1)([+-])\s*\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)\s*\[\s*([-+0-9.eE]+)\s*\|\s*([-+0-9.eE]+)\s*\]\s*"([^"]*)"\s*([\w]*)/;
const VAL_RE = /^VAL_\s+(\d+)\s+([A-Za-z_][\w]*)\s+(.*?)\s*;/;
const VAL_PAIR_RE = /(-?\d+)\s+"([^"]*)"/g;
const ROLE_RE = /^BA_\s+"BusScaleRole"\s+SG_\s+(\d+)\s+([A-Za-z_][\w]*)\s+"(\w+)"\s*;/;
const CRC_RE = /^BA_\s+"BusScaleCrc"\s+BO_\s+(\d+)\s+"([^"]*)"\s*;/;

export function parseDbc(text: string): DbcDef {
  const messages: MessageDef[] = [];
  const byRawId = new Map<number, MessageDef>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const bo = BO_RE.exec(line);
    if (bo) {
      const rawId = Number(bo[1]);
      const { id, extended } = splitRawId(rawId);
      const msg: MessageDef = {
        id,
        extended,
        name: bo[2],
        dlc: Number(bo[3]),
        sender: bo[4],
        signals: [],
        crcRule: null,
      };
      messages.push(msg);
      byRawId.set(rawId, msg);
      continue;
    }

    const sg = SG_RE.exec(line);
    if (sg && messages.length > 0) {
      const msg = messages[messages.length - 1];
      const mux = sg[2]
        ? ({ type: 'multiplexor' } as const)
        : sg[3] !== undefined
          ? ({ type: 'multiplexed', value: Number(sg[3]) } as const)
          : ({ type: 'static' } as const);
      msg.signals.push({
        name: sg[1],
        start: Number(sg[4]),
        length: Number(sg[5]),
        order: sg[6] === '1' ? 'intel' : 'motorola',
        signed: sg[7] === '-',
        scale: Number(sg[8]),
        offset: Number(sg[9]),
        min: sg[10] === '' ? null : Number(sg[10]),
        max: sg[11] === '' ? null : Number(sg[11]),
        unit: sg[12],
        receiver: sg[13] ?? '',
        mux,
        values: {},
        role: null,
      });
      continue;
    }

    const val = VAL_RE.exec(line);
    if (val) {
      const msg = byRawId.get(Number(val[1]));
      const sig = msg?.signals.find((s) => s.name === val[2]);
      if (sig) {
        for (const pair of val[3].matchAll(VAL_PAIR_RE)) {
          sig.values[Number(pair[1])] = pair[2];
        }
      }
      continue;
    }

    const role = ROLE_RE.exec(line);
    if (role) {
      const msg = byRawId.get(Number(role[1]));
      const sig = msg?.signals.find((s) => s.name === role[2]);
      if (sig && (role[3] === 'counter' || role[3] === 'crc')) {
        sig.role = role[3];
      }
      continue;
    }

    const crc = CRC_RE.exec(line);
    if (crc) {
      const msg = byRawId.get(Number(crc[1]));
      if (msg) {
        msg.crcRule = parseCrcRule(crc[2]);
      }
      continue;
    }
  }

  return { messages };
}

function parseCrcRule(body: string): CrcRule {
  const rule: CrcRule = {};
  for (const part of body.split(/[;,]/)) {
    const [key, value] = part.split('=').map((s) => s.trim());
    if (!key || value === undefined || value === '') continue;
    const num = value.toLowerCase().startsWith('0x') ? parseInt(value, 16) : Number(value);
    if (Number.isNaN(num)) continue;
    switch (key) {
      case 'poly':
        rule.polynomial = num;
        break;
      case 'init':
        rule.init = num;
        break;
      case 'xor':
        rule.xorOut = num;
        break;
      case 'start':
        rule.startByte = num;
        break;
      case 'end':
        rule.endByte = num;
        break;
    }
  }
  return rule;
}
