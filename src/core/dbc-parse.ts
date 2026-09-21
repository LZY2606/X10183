import type { ByteOrder, DbcDoc, MessageDef, SignalDef } from './types';

export interface DbcParseOptions {
  /** 可选 sidecar：为消息附加计数器 / CRC 规则 */
  rules?: Array<{
    arbId: number;
    extended?: boolean;
    channel?: string | null;
    counterSignal?: string;
    crc?: {
      signal: string;
      coverStart?: number;
      coverEnd?: number;
      init?: number;
      xorOut?: number;
    };
  }>;
  channel?: string | null;
}

/**
 * 解析 DBC 核心行：BU_ / BO_ / SG_ / VAL_。
 * 扩展帧：id >= 0x80000000（DBC 约定）。
 */
export function parseDbc(text: string, opts: DbcParseOptions = {}): DbcDoc {
  const nodes: string[] = [];
  const messages: MessageDef[] = [];
  const byKey = new Map<string, MessageDef>();
  let current: MessageDef | null = null;
  const enumById = new Map<number, Map<string, { value: number; label: string }[]>>();

  const key = (arbId: number, extended: boolean) =>
    `${extended ? 'x' : 's'}:${arbId}`;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    if (line.startsWith('BU_:')) {
      for (const n of line.slice(4).trim().split(/\s+/)) {
        if (n && !nodes.includes(n)) nodes.push(n);
      }
      continue;
    }

    const bo = line.match(/^BO_\s+(\d+)\s+(\S+?):\s+(\d+)\s+(\S+)/);
    if (bo) {
      const rawId = Number(bo[1]);
      const extended = rawId >= 0x80000000;
      const arbId = extended ? rawId - 0x80000000 : rawId;
      current = {
        arbId,
        extended,
        channel: opts.channel ?? null,
        name: bo[2],
        dlc: Number(bo[3]),
        transmitter: bo[4] === 'Vector__XXX' ? null : bo[4],
        signals: [],
        crc: null,
        counter: null,
      };
      messages.push(current);
      byKey.set(key(arbId, extended), current);
      continue;
    }

    const sg = line.match(
      /^SG_\s+(\w+)\s*(M|m\d+)?\s*:\s*(\d+)\|(\d+)@(0|1)([+-])\s+\(([^,]+),([^)]+)\)\s+\[([^|]*)\|([^\]]*)\]\s+"([^"]*)"\s*(.*)$/,
    );
    if (sg && current) {
      const muxToken = sg[2] ?? '';
      const order: ByteOrder = sg[5] === '1' ? 'intel' : 'motorola';
      const signal: SignalDef = {
        name: sg[1],
        startBit: Number(sg[3]),
        length: Number(sg[4]),
        byteOrder: order,
        signed: sg[6] === '-',
        factor: Number(sg[7]),
        offset: Number(sg[8]),
        unit: sg[13] ? sg[13] : null,
        enums: [],
        muxSwitch: muxToken === 'M',
        muxValue: muxToken.startsWith('m') ? Number(muxToken.slice(1)) : null,
        isCounter: false,
        isCrc: false,
      };
      current.signals.push(signal);
      continue;
    }

    const val = line.match(/^VAL_\s+(\d+)\s+(\w+)\s+(.*);$/);
    if (val) {
      const rawId = Number(val[1]);
      const sigName = val[2];
      const pairs: { value: number; label: string }[] = [];
      const re = /(-?\d+)\s+"([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(val[3]))) {
        pairs.push({ value: Number(m[1]), label: m[2] });
      }
      const map = enumById.get(rawId) ?? new Map();
      map.set(sigName, pairs);
      enumById.set(rawId, map);
    }
  }

  // 附加枚举
  for (const msg of messages) {
    const rawId = msg.extended ? msg.arbId + 0x80000000 : msg.arbId;
    const map = enumById.get(rawId);
    if (!map) continue;
    for (const sig of msg.signals) {
      const pairs = map.get(sig.name);
      if (pairs) sig.enums = pairs;
    }
  }

  // 附加 sidecar 规则
  for (const rule of opts.rules ?? []) {
    const msg = byKey.get(key(rule.arbId, rule.extended ?? false));
    if (!msg) continue;
    if (rule.channel !== undefined) msg.channel = rule.channel;
    if (rule.counterSignal) {
      msg.counter = { signal: rule.counterSignal };
      const sig = msg.signals.find((s) => s.name === rule.counterSignal);
      if (sig) sig.isCounter = true;
    }
    if (rule.crc) {
      const crc = rule.crc;
      msg.crc = {
        signal: crc.signal,
        coverStart: crc.coverStart ?? null,
        coverEnd: crc.coverEnd ?? null,
        init: crc.init ?? null,
        xorOut: crc.xorOut ?? null,
      };
      const sig = msg.signals.find((s) => s.name === crc.signal);
      if (sig) sig.isCrc = true;
    }
  }

  return { nodes, messages };
}
