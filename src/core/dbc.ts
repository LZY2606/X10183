import type { ByteOrder, DbcVersion, MessageDef, MultiplexerKind, SignalDef } from "./types.js";

export interface ParsedDbc {
  messages: Array<{
    name: string;
    arbitrationId: number;
    extended: boolean;
    channel: string | null;
    dlc: number;
    transmitter: string | null;
    signals: ParsedSignal[];
  }>;
  channel: string | null;
  effectiveFromNs: bigint | null;
  effectiveToNs: bigint | null;
  name: string | null;
  versionNumber: number | null;
}

export interface ParsedSignal {
  name: string;
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  minimum: number | null;
  maximum: number | null;
  unit: string | null;
  muxKind: MultiplexerKind;
  muxValue: number | null;
  muxSwitchName: string | null;
  muxRanges: Array<[number, number]> | null;
  enums: Record<number, string> | null;
}

interface RawMuxRule {
  switchName: string;
  valueSignal: string;
  ranges: Array<[number, number]>;
}

/**
 * 解析时间标记。支持：
 *   // @busscale effective 2024-01-01T00:00:00Z .. 2024-06-01T00:00:00Z
 *   // @busscale effective-from 2024-01-01T00:00:00Z
 *   // @busscale effective-to 2024-06-01T00:00:00Z
 */
function parseTimeToken(token: string): bigint {
  // ISO 字符串 -> ns（固定以 UTC 解释无时区的时间）
  const iso = token.includes("Z") || /[+-]\d\d:?\d\d$/.test(token) ? token : token + "Z";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间: ${token}`);
  return BigInt(ms) * 1_000_000n;
}

export function parseDbc(text: string): ParsedDbc {
  const lines = text.split(/\r?\n/);
  const messages: ParsedDbc["messages"] = [];
  const enumValues = new Map<string, Record<number, string>>();
  const muxRules: RawMuxRule[] = [];
  let channel: string | null = null;
  let effectiveFromNs: bigint | null = null;
  let effectiveToNs: bigint | null = null;
  let name: string | null = null;
  let versionNumber: number | null = null;

  let current: ParsedDbc["messages"][number] | null = null;

  const boRe = /^BO_\s+(\d+)(x?)\s+(\w+)\s*:\s*(\d+)\s+(\S+)/;
  const sgRe =
    /^\s*SG_\s+(\w+)\s*(M|m\d+|m\d+[A-Za-z_]\w*)?\s*:\s*(\d+)\|(\d+)@(0|1)([+-])\s+\(([^,]*),([^)]*)\)\s+\[([^,]*),([^\]]*)\]\s+"([^"]*)"\s*(.*)$/;
  const valRe = /^VAL_\s+(?:\d+\s+)?(\w+)\s+(.+);$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const pragma = line.match(/^\/\/\s*@busscale\s+(.+)$/) || line.match(/^\/\*\s*@busscale\s+(.+?)\s*\*\/$/);
    if (pragma) {
      const body = pragma[1].trim();
      const range = body.match(/^effective\s+(\S+)\s*\.\.\s*(\S+)/);
      if (range) {
        effectiveFromNs = parseTimeToken(range[1]);
        effectiveToNs = parseTimeToken(range[2]);
      }
      const from = body.match(/^effective-from\s+(\S+)/);
      if (from) effectiveFromNs = parseTimeToken(from[1]);
      const to = body.match(/^effective-to\s+(\S+)/);
      if (to) effectiveToNs = parseTimeToken(to[1]);
      const ch = body.match(/^channel\s+"?([\w-]+)"?/);
      if (ch) channel = ch[1];
      const nm = body.match(/^name\s+"([^"]+)"/);
      if (nm) name = nm[1];
      const ver = body.match(/^version\s+(\d+)/);
      if (ver) versionNumber = Number(ver[1]);
      continue;
    }

    const nsVersion = line.match(/^VERSION\s+"([^"]*)"/);
    if (nsVersion && name === null && nsVersion[1]) name = nsVersion[1];

    const bo = line.match(boRe);
    if (bo) {
      current = {
        arbitrationId: Number(bo[1]),
        extended: bo[2] === "x",
        name: bo[3],
        dlc: Number(bo[4]),
        transmitter: bo[5] === "Vector__XXX" ? null : bo[5],
        channel,
        signals: []
      };
      messages.push(current);
      continue;
    }

    const sg = line.match(sgRe);
    if (sg && current) {
      const muxToken = sg[2];
      let muxKind: MultiplexerKind = "plain";
      let muxValue: number | null = null;
      let muxSwitchName: string | null = null;
      if (muxToken === "M") {
        muxKind = "switch";
      } else if (muxToken) {
        const m = muxToken.match(/^m(\d+)([A-Za-z_]\w*)?$/);
        if (m) {
          muxKind = "value";
          muxValue = Number(m[1]);
          muxSwitchName = m[2] ?? null;
        }
      }
      const unit = sg[16] === "" ? null : sg[16];
      current.signals.push({
        name: sg[1],
        startBit: Number(sg[3]),
        length: Number(sg[4]),
        byteOrder: sg[5] === "0" ? "motorola" : "intel",
        signed: sg[6] === "-",
        scale: Number(sg[7]),
        offset: Number(sg[8]),
        minimum: sg[9].trim() === "" ? null : Number(sg[9]),
        maximum: sg[10].trim() === "" ? null : Number(sg[10]),
        unit,
        muxKind,
        muxValue,
        muxSwitchName,
        muxRanges: null,
        enums: enumValues.get(`${current.name}.${sg[1]}`) ?? null
      });
      continue;
    }

    const val = line.match(valRe);
    if (val && current) {
      const sigName = val[1];
      const pairs = val[2].matchAll(/(-?\d+)\s+"([^"]*)"/g);
      const map: Record<number, string> = {};
      for (const p of pairs) map[Number(p[1])] = p[2];
      enumValues.set(`${current.name}.${sigName}`, map);
      const sig = current.signals.find((s) => s.name === sigName);
      if (sig) sig.enums = map;
      continue;
    }

    // SG_MUL_VAL_ messageName switchSignal valueSignal 0-1 3-3;
    const mul = line.match(/^SG_MUL_VAL_\s+(\w+)\s+(\w+)\s+(\w+)\s+(.+);$/);
    if (mul && current && mul[1] === current.name) {
      const ranges: Array<[number, number]> = [];
      for (const r of mul[4].matchAll(/(\d+)-(\d+)/g)) ranges.push([Number(r[1]), Number(r[2])]);
      muxRules.push({ switchName: mul[2], valueSignal: mul[3], ranges });
      const sig = current.signals.find((s) => s.name === mul[3]);
      if (sig) {
        sig.muxKind = "value";
        sig.muxSwitchName = mul[2];
        sig.muxRanges = ranges.length ? ranges : null;
        sig.muxValue = ranges[0]?.[0] ?? null;
      }
      continue;
    }
  }

  return { messages, channel, effectiveFromNs, effectiveToNs, name, versionNumber };
}

/** 选择帧时间点生效的 DBC 版本：from <= t < to，端点半开。 */
export function selectDbcVersion(versions: DbcVersion[], timeNs: bigint): DbcVersion | null {
  const candidates = versions.filter((v) => {
    const from = v.effectiveFromNs === null ? null : BigInt(v.effectiveFromNs);
    const to = v.effectiveToNs === null ? null : BigInt(v.effectiveToNs);
    if (from !== null && timeNs < from) return false;
    if (to !== null && timeNs >= to) return false;
    return true;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.versionNumber - a.versionNumber);
  return candidates[0];
}

/** 标准帧 id 必须 <= 0x7FF，扩展帧允许 29bit。 */
export function isValidArbId(id: number, extended: boolean): boolean {
  if (!Number.isInteger(id) || id < 0) return false;
  return extended ? id <= 0x1fffffff : id <= 0x7ff;
}

/** 把解析结果提升为带库内 id 的定义（导入时使用）。 */
export function toMessageDefs(
  parsed: ParsedDbc,
  dbcVersionId: number,
  idAllocator: () => number,
  signalIdAllocator: () => number
): MessageDef[] {
  return parsed.messages.map((m) => {
    const messageId = idAllocator();
    return {
      id: messageId,
      dbcVersionId,
      name: m.name,
      arbitrationId: m.arbitrationId,
      extended: m.extended,
      channel: m.channel,
      dlc: m.dlc,
      transmitter: m.transmitter,
      signals: m.signals.map((s) => ({
        id: signalIdAllocator(),
        messageId,
        name: s.name,
        startBit: s.startBit,
        length: s.length,
        byteOrder: s.byteOrder,
        signed: s.signed,
        scale: s.scale,
        offset: s.offset,
        minimum: s.minimum,
        maximum: s.maximum,
        unit: s.unit,
        muxKind: s.muxKind,
        muxValue: s.muxValue,
        muxSwitchName: s.muxSwitchName,
        muxRanges: s.muxRanges ? s.muxRanges.map((r) => [r[0], r[1]] as [number, number]) : null,
        enums: s.enums ? { ...s.enums } : null
      }))
    };
  });
}
