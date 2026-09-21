import { extractBits, toSigned, describeBits, type BitRange } from "./bits";
import type { MessageDef, SignalDef } from "./dbc";

export interface DecodedSignal {
  name: string;
  /** exact payload bit coverage, MSB first */
  bits: BitRange[];
  bitRangeText: string;
  byteOrder: "intel" | "motorola";
  raw: string; // bigint as string for JSON safety
  signedRaw: string;
  physical: number;
  unit: string;
  enumLabel: string | null;
  scale: number;
  offset: number;
  muxRole: SignalDef["muxRole"];
  muxValue: number | null;
  /** false when the mux branch is unknown and only raw bits are preserved */
  resolved: boolean;
}

export interface DecodedFrame {
  messageName: string;
  arbitrationId: number;
  isExtended: boolean;
  sender: string;
  /** active multiplexor value, null when the message has no multiplexor */
  muxBranch: number | null;
  /** true when a multiplexor exists but no defined branch matches */
  muxUnknown: boolean;
  signals: DecodedSignal[];
}

function decodeSignal(sig: SignalDef, data: Uint8Array, resolved: boolean): DecodedSignal {
  const { raw, bits } = extractBits(data, sig.startBit, sig.length, sig.byteOrder);
  const signedRaw = sig.signed ? toSigned(raw, sig.length) : raw;
  const physical = Number(signedRaw) * sig.scale + sig.offset;
  const enumLabel = sig.enums[Number(signedRaw)] ?? null;
  return {
    name: sig.name,
    bits,
    bitRangeText: describeBits(bits),
    byteOrder: sig.byteOrder,
    raw: raw.toString(),
    signedRaw: signedRaw.toString(),
    physical,
    unit: sig.unit,
    enumLabel,
    scale: sig.scale,
    offset: sig.offset,
    muxRole: sig.muxRole,
    muxValue: sig.muxValue,
    resolved,
  };
}

/**
 * Decode one frame payload with a message definition.
 * Multiplexed signals whose branch is not active — or whose multiplexor value
 * matches no defined branch — are kept as raw bits with resolved=false.
 */
export function decodeFrame(msg: MessageDef, data: Uint8Array): DecodedFrame {
  const mux = msg.signals.find((s) => s.muxRole === "multiplexor") ?? null;
  let muxBranch: number | null = null;
  let muxUnknown = false;
  if (mux) {
    const ext = extractBits(data, mux.startBit, mux.length, mux.byteOrder);
    muxBranch = Number(mux.signed ? toSigned(ext.raw, mux.length) : ext.raw);
    muxUnknown = !msg.signals.some(
      (s) => s.muxRole === "multiplexed" && s.muxValue === muxBranch,
    );
  }

  const signals: DecodedSignal[] = [];
  for (const sig of msg.signals) {
    if (sig.muxRole === "multiplexed") {
      const active = muxBranch !== null && sig.muxValue === muxBranch;
      if (muxUnknown || !active) {
        // Unknown or inactive branch: preserve raw bits, mark unresolved.
        signals.push(decodeSignal(sig, data, false));
        continue;
      }
    }
    signals.push(decodeSignal(sig, data, true));
  }

  return {
    messageName: msg.name,
    arbitrationId: msg.arbitrationId,
    isExtended: msg.isExtended,
    sender: msg.sender,
    muxBranch,
    muxUnknown,
    signals,
  };
}
