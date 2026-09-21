import type {
  DecodedSignal,
  DecodeResult,
  MessageDef,
  RawFrame,
  SignalDef
} from "./types.js";
import { applyScale, readRaw, readRawUnsigned, spanFor } from "./bits.js";

export function findSignal(message: MessageDef, name: string): SignalDef | undefined {
  return message.signals.find((s) => s.name === name);
}

/** 找出一条消息的多路开关信号（muxKind="switch"）。 */
export function switchSignals(message: MessageDef): SignalDef[] {
  return message.signals.filter((s) => s.muxKind === "switch");
}

interface ActiveSignal {
  signal: SignalDef;
  unknownMux: boolean;
}

/**
 * 决定哪些信号对当前帧生效：
 * - 普通信号恒生效；
 * - switch 信号恒生效（先解码，得到分支原始值）；
 * - value 信号仅当对应开关原始值匹配时生效；
 * - 扩展多路复用（muxSwitchName 指定）在找不到开关定义时，整组分支保持 raw bits（unknownMux）。
 */
export function selectActiveSignals(
  message: MessageDef,
  frame: RawFrame
): { active: ActiveSignal[]; branches: Record<string, number> } {
  const branches: Record<string, number> = {};
  const active: ActiveSignal[] = [];

  // 1) 先解码所有开关。
  const switches = switchSignals(message);
  for (const sw of switches) {
    const span = spanFor(sw.byteOrder, sw.startBit, sw.length);
    branches[sw.name] = readRawUnsigned(frame.data, span, sw.byteOrder);
    active.push({ signal: sw, unknownMux: false });
  }

  // 2) 普通与分支信号。
  for (const sig of message.signals) {
    if (sig.muxKind === "switch") continue;
    if (sig.muxKind === "plain") {
      active.push({ signal: sig, unknownMux: false });
      continue;
    }
    // value 分支
    const switchName = sig.muxSwitchName ?? switches[0]?.name;
    if (switchName === undefined) {
      // 存在分支信号但没有任何开关定义：无法判定分支，保留 raw bits。
      active.push({ signal: sig, unknownMux: true });
      continue;
    }
    const taken = branches[switchName];
    if (taken === undefined) {
      // 扩展多路复用引用了未定义的开关：保留 raw bits。
      active.push({ signal: sig, unknownMux: true });
      continue;
    }
    const matches = sig.muxRanges
      ? sig.muxRanges.some(([lo, hi]) => taken >= lo && taken <= hi)
      : taken === sig.muxValue;
    if (matches) {
      active.push({ signal: sig, unknownMux: false });
    }
  }

  return { active, branches };
}

function decodeSignal(sig: SignalDef, frame: RawFrame, unknownMux: boolean): DecodedSignal {
  const span = spanFor(sig.byteOrder, sig.startBit, sig.length);
  if (unknownMux) {
    return {
      signalName: sig.name,
      rawValue: readRawUnsigned(frame.data, span, sig.byteOrder),
      value: null,
      enumLabel: null,
      bitSpan: span,
      unknownMux: true
    };
  }
  const raw = readRaw(frame.data, span, sig.byteOrder, sig.signed);
  const scaled = applyScale(raw, sig.scale, sig.offset);
  const enumLabel = sig.enums && sig.enums[raw] !== undefined ? sig.enums[raw] : null;
  return {
    signalName: sig.name,
    rawValue: raw,
    value: enumLabel ?? scaled,
    enumLabel,
    bitSpan: span,
    unknownMux: false
  };
}

export function decodeFrame(frame: RawFrame, message: MessageDef | null): DecodeResult {
  if (!message) {
    return {
      frameId: frame.id,
      dbcVersionId: null,
      messageDefId: null,
      messageName: null,
      signals: [],
      muxBranches: {},
      unclaimedBits: []
    };
  }
  const { active, branches } = selectActiveSignals(message, frame);
  const decoded = active.map((a) => decodeSignal(a.signal, frame, a.unknownMux));

  // 计算未被“已知分支”信号覆盖的 bit（未知 mux 分支的分支信号所占位计入未解释）。
  const claimed = new Set<number>();
  for (const a of active) {
    if (a.unknownMux) continue;
    const span = spanFor(a.signal.byteOrder, a.signal.startBit, a.signal.length);
    for (const cell of span.cells) claimed.add(cell.byte * 8 + cell.bit);
  }
  const unclaimed: number[] = [];
  for (let byte = 0; byte < Math.min(frame.data.length, message.dlc); byte++) {
    for (let bit = 0; bit < 8; bit++) {
      if (!claimed.has(byte * 8 + bit)) unclaimed.push(byte * 8 + bit);
    }
  }

  return {
    frameId: frame.id,
    dbcVersionId: message.dbcVersionId,
    messageDefId: message.id,
    messageName: message.name,
    signals: decoded,
    muxBranches: branches,
    unclaimedBits: unclaimed
  };
}
