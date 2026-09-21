import type {
  ByteOrder,
  DecodedFrame,
  DecodedSignal,
  MessageDef,
  MuxRole,
  RawFrame,
  SignalDef,
} from "./types";

/**
 * 返回信号在统一线性坐标（0=byte0 物理 bit0，MSB-first 位序）上的位段集合。
 * Intel 为单段 [start, start+len)；Motorola 跨字节可能断成两段。
 */
export function bitRanges(
  startBit: number,
  length: number,
  order: ByteOrder,
): { first: number; last: number }[] {
  if (order === "intel") {
    return [{ first: startBit, last: startBit + length - 1 }];
  }
  const positions = motorolaLinearBits(startBit, length).sort((a, b) => a - b);
  const ranges: { first: number; last: number }[] = [];
  for (const p2 of positions) {
    const last = ranges.at(-1);
    if (last && p2 === last.last + 1) last.last = p2;
    else ranges.push({ first: p2, last: p2 });
  }
  return ranges;
}

/** Motorola：按 MSB->LSB 顺序返回每个信号位的线性坐标。DBC 标签在字节内列号=物理位号。 */
export function motorolaLinearBits(startBit: number, length: number): number[] {
  const out: number[] = [];
  let dbc = startBit;
  for (let i = 0; i < length; i++) {
    out.push(Math.floor(dbc / 8) * 8 + (dbc % 8));
    // 下一位：同字节列号递减；到列0后跳到下一字节列7（dbc +15）。
    dbc = dbc % 8 === 0 ? dbc + 15 : dbc - 1;
  }
  return out;
}

/** 从线性 bit 位置（0 = byte0 bit0，LSB-first）读取一个 bit。 */
function readLinearBit(data: number[], linear: number): number {
  const byte = data[Math.floor(linear / 8)] ?? 0;
  return (byte >> (linear % 8)) & 1;
}

export function extractRaw(
  data: number[],
  startBit: number,
  length: number,
  order: ByteOrder,
): number {
  // 统一线性位坐标，按 MSB->LSB 拼值。
  const msbToLsb =
    order === "motorola"
      ? motorolaLinearBits(startBit, length)
      : Array.from({ length }, (_, i) => startBit + i).reverse();
  let raw = 0;
  for (const linear of msbToLsb) {
    raw = raw * 2 + readLinearBit(data, linear);
  }
  return raw;
}

/** 无符号 raw -> 有符号（长度位补码）。 */
export function toSigned(raw: number, length: number): number {
  if (length >= 32) {
    // 32 位用 Math 处理避免 1<<32。
    const sign = Math.pow(2, length - 1);
    return raw >= sign ? raw - Math.pow(2, length) : raw;
  }
  const sign = 1 << (length - 1);
  return (raw ^ sign) - sign;
}

function decodeOne(
  sig: SignalDef,
  data: number[],
  status: DecodedSignal["status"],
  reason?: string,
): DecodedSignal {
  const raw = extractRaw(data, sig.startBit, sig.length, sig.order);
  const signedValue = sig.signed ? toSigned(raw, sig.length) : raw;
  const physical = signedValue * sig.scale + sig.offset;
  return {
    name: sig.name,
    bits: bitRanges(sig.startBit, sig.length, sig.order),
    startBitDbc: sig.startBit,
    length: sig.length,
    order: sig.order,
    raw: sig.signed ? signedValue : raw,
    signed: sig.signed,
    physical,
    unit: sig.unit,
    scale: sig.scale,
    offset: sig.offset,
    enumText: sig.enums[raw] ?? null,
    mux: sig.mux,
    status,
    reason,
  };
}

/**
 * 用一条消息定义解码一帧。
 * 多路复用：先找 mux switch，按 switch raw 选分支；分支未知时分支信号保留 raw（status=unknown）。
 */
export function decodeWithMessage(
  frame: RawFrame,
  msg: MessageDef,
  dbcVersionId: number,
  dbcVersionName: string,
): DecodedFrame {
  const switchSigs = msg.signals.filter((s) => s.mux.type === "switch");
  const branchValues = new Map<string, number>();
  const muxBranches: DecodedFrame["muxBranches"] = [];

  for (const sw of switchSigs) {
    const value = extractRaw(frame.data, sw.startBit, sw.length, sw.order);
    branchValues.set(sw.name, value);
    const hasBranch = msg.signals.some(
      (s) =>
        s.mux.type === "case" &&
        s.mux.switchName === sw.name &&
        s.mux.value === value,
    );
    muxBranches.push({ switch: sw.name, value, known: hasBranch });
  }

  const unknownSwitch = [...branchValues.entries()]
    .filter(([name]) => {
      const b = muxBranches.find((m) => m.switch === name);
      return b ? !b.known : false;
    })
    .map(([name, value]) => ({ name, value }));

  const signals: DecodedSignal[] = msg.signals.map((sig) => {
    if (sig.mux.type === "plain" || sig.mux.type === "switch") {
      return decodeOne(sig, frame.data, "active");
    }
    // case 信号
    const switchValue = branchValues.get(sig.mux.switchName);
    if (switchValue === undefined) {
      return decodeOne(sig, frame.data, "inactive", "缺少多路复用开关定义");
    }
    const branch = muxBranches.find((b) => b.switch === sig.mux.switchName);
    if (branch && !branch.known) {
      return decodeOne(
        sig,
        frame.data,
        "unknown",
        `多路复用分支 ${sig.mux.switchName}=${switchValue} 未知，保留 raw bits`,
      );
    }
    if (switchValue === sig.mux.value) {
      return decodeOne(sig, frame.data, "active");
    }
    return decodeOne(
      sig,
      frame.data,
      "inactive",
      `分支 ${sig.mux.switchName}=${switchValue}，本信号属于 ${sig.mux.value}`,
    );
  });

  return {
    frameId: frame.id,
    dbcVersionId,
    dbcVersionName,
    messageName: msg.name,
    transmitter: msg.transmitter,
    arbId: frame.arbId,
    kind: frame.kind,
    channel: frame.channel,
    hwTime: frame.hwTime,
    gen: frame.gen,
    data: frame.data,
    signals,
    muxBranches,
    error: null,
  };
}

/** 找不到消息定义：保留原始帧并显式报错，信号位仍然允许调用方另作解析。 */
export function decodeUnknownMessage(
  frame: RawFrame,
  dbcVersionId: number,
  dbcVersionName: string,
): DecodedFrame {
  return {
    frameId: frame.id,
    dbcVersionId,
    dbcVersionName,
    messageName: null,
    transmitter: "",
    arbId: frame.arbId,
    kind: frame.kind,
    channel: frame.channel,
    hwTime: frame.hwTime,
    gen: frame.gen,
    data: frame.data,
    signals: [],
    muxBranches: [],
    error: `未在 DBC「${dbcVersionName}」中找到 ${frame.kind === "ext" ? "扩展" : "标准"}帧 0x${frame.arbId.toString(16).toUpperCase()} 的消息定义`,
  };
}

export function isMuxRole(s: MuxRole, t: MuxRole["type"]): boolean {
  return s.type === t;
}
