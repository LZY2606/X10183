import type { ByteOrder, DbcVersion, MessageDef, SignalDef } from './types.js';

export interface ParsedSignal {
  name: string;
  mux: 'normal' | 'switch' | number;
  startBit: number;
  bitLength: number;
  byteOrder: ByteOrder;
  sign: '+' | '-';
  factor: number;
  offset: number;
  minimum: number | null;
  maximum: number | null;
  unit: string | null;
}

export interface ParsedMessage {
  canId: number;
  isExtended: boolean;
  name: string;
  dlc: number;
  transmitter: string | null;
  signals: ParsedSignal[];
  enumMap: Record<string, Record<number, string>>;
}

/**
 * 解析 DBC 片段。容忍注释、属性、缺失节点列表。
 * 支持：BO_、SG_（含 M / mN 多路复用）、VAL_、CM_
 */
export function parseDbc(text: string): { messages: ParsedMessage[]; errors: string[] } {
  const errors: string[] = [];
  const messages = new Map<number, ParsedMessage>();

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    const bo = line.match(/^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+([\w-]+)?/);
    if (bo) {
      const rawId = parseInt(bo[1], 10);
      const isExtended = rawId >= 0x80000000;
      const canId = isExtended ? rawId - 0x80000000 : rawId;
      messages.set(rawId, {
        canId,
        isExtended,
        name: bo[2],
        dlc: parseInt(bo[3], 10),
        transmitter: bo[4] && bo[4] !== 'Vector__XXX' ? bo[4] : null,
        signals: [],
        enumMap: {}
      });
      continue;
    }

    const sg = line.match(
      /^SG_\s+(\w+)\s*(M(?:\d+)?|m\d+)?\s*:\s*(\d+)\|(\d+)@(0|1)([+-])\s+\(([^,]+),([^)]+)\)\s+\[([^|]*)\|([^\]]*)\]\s+"([^"]*)"(.*)$/
    );
    if (sg) {
      const owner = [...messages.values()].pop();
      if (!owner) {
        errors.push(`SG_ without BO_: ${sg[1]}`);
        continue;
      }
      const muxTok = sg[2];
      let mux: ParsedSignal['mux'] = 'normal';
      if (muxTok === 'M') mux = 'switch';
      else if (muxTok && /^m\d+$/.test(muxTok)) mux = parseInt(muxTok.slice(1), 10);
      else if (muxTok && /^M\d+$/.test(muxTok)) mux = parseInt(muxTok.slice(1), 10);
      owner.signals.push({
        name: sg[1],
        mux,
        startBit: parseInt(sg[3], 10),
        bitLength: parseInt(sg[4], 10),
        byteOrder: sg[5] === '1' ? 'intel' : 'motorola',
        sign: sg[6] as '+' | '-',
        factor: Number(sg[7]),
        offset: Number(sg[8]),
        minimum: sg[9].trim() === '' ? null : Number(sg[9]),
        maximum: sg[10].trim() === '' ? null : Number(sg[10]),
        unit: sg[11] === '' ? null : sg[11]
      });
      continue;
    }

    const val = line.match(/^VAL_\s+(\d+)\s+(\w+)\s+(.*);$/);
    if (val) {
      const owner = messages.get(parseInt(val[1], 10));
      if (owner) {
        const map: Record<number, string> = {};
        const re = /(-?\d+)\s+"([^"]*)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(val[3]))) map[parseInt(m[1], 10)] = m[2];
        owner.enumMap[val[2]] = map;
      }
    }
  }

  return { messages: [...messages.values()], errors };
}

/** 半开区间 [effectiveFrom, effectiveTo)；null 为无界。返回 t 时刻生效版本（重叠时取最新创建） */
export function effectiveAt(
  versions: Pick<DbcVersion, 'id' | 'effectiveFrom' | 'effectiveTo' | 'createdAt'>[],
  t: number
): DbcVersion['id'] | null {
  const hits = versions.filter(
    (v) =>
      (v.effectiveFrom === null || t >= v.effectiveFrom) &&
      (v.effectiveTo === null || t < v.effectiveTo)
  );
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return hits[0].id;
}

/** 用旧定义解码的结果是否已过期：该帧时刻的生效版本已不是它 */
export function isStaleDecode(
  decodedDbcId: number,
  hwTime: number,
  versions: DbcVersion[]
): boolean {
  return effectiveAt(versions, hwTime) !== decodedDbcId;
}

/** 两版本消息布局差异（用于迁移比较） */
export interface LayoutDiff {
  canId: number;
  isExtended: boolean;
  fromMessage: string | null;
  toMessage: string | null;
  addedSignals: string[];
  removedSignals: string[];
  changedSignals: { name: string; fields: string[] }[];
  compatible: boolean;
}

const SIG_FIELDS: (keyof SignalDef)[] = [
  'startBit',
  'bitLength',
  'byteOrder',
  'sign',
  'factor',
  'offset'
];

export function diffMessages(
  from: MessageDef | undefined,
  to: MessageDef | undefined,
  canId: number,
  isExtended: boolean
): LayoutDiff {
  if (!from || !to) {
    return {
      canId,
      isExtended,
      fromMessage: from?.name ?? null,
      toMessage: to?.name ?? null,
      addedSignals: to ? to.signals.map((s) => s.name) : [],
      removedSignals: from ? from.signals.map((s) => s.name) : [],
      changedSignals: [],
      compatible: false
    };
  }
  const fromByName = new Map(from.signals.map((s) => [s.name, s]));
  const toByName = new Map(to.signals.map((s) => [s.name, s]));
  const addedSignals = to.signals.filter((s) => !fromByName.has(s.name)).map((s) => s.name);
  const removedSignals = from.signals.filter((s) => !toByName.has(s.name)).map((s) => s.name);
  const changedSignals: LayoutDiff['changedSignals'] = [];
  for (const fs of from.signals) {
    const ts = toByName.get(fs.name);
    if (!ts) continue;
    const fields = SIG_FIELDS.filter((f) => String(fs[f]) !== String(ts![f]));
    if (fields.length) changedSignals.push({ name: fs.name, fields });
  }
  return {
    canId,
    isExtended,
    fromMessage: from.name,
    toMessage: to.name,
    addedSignals,
    removedSignals,
    changedSignals,
    compatible: addedSignals.length === 0 && removedSignals.length === 0 && changedSignals.length === 0
  };
}
