import { decodeFrame, type DecodedFrame } from "./decode";
import { findMessage, type DbcDefinition } from "./dbc";

export interface FrameRef {
  frameId: number;
  arbitrationId: number;
  isExtended: boolean;
  data: Uint8Array;
}

export interface SignalDiff {
  signal: string;
  status: "changed" | "only_in_a" | "only_in_b" | "unresolved_in_b" | "unresolved_in_a";
  a: { physical: number; raw: string; enumLabel: string | null } | null;
  b: { physical: number; raw: string; enumLabel: string | null } | null;
}

export interface FrameImpact {
  frameId: number;
  arbitrationId: number;
  isExtended: boolean;
  messageA: string | null;
  messageB: string | null;
  muxBranchA: number | null;
  muxBranchB: number | null;
  diffs: SignalDiff[];
}

function decodeWith(
  dbc: DbcDefinition,
  frame: FrameRef,
): { message: string | null; decoded: DecodedFrame | null } {
  const msg = findMessage(dbc, frame.arbitrationId, frame.isExtended);
  if (!msg) return { message: null, decoded: null };
  return { message: msg.name, decoded: decodeFrame(msg, frame.data) };
}

/** Compare how two DBC versions interpret the same batch of frames. */
export function compareVersions(
  a: DbcDefinition,
  b: DbcDefinition,
  frames: FrameRef[],
): FrameImpact[] {
  const impacts: FrameImpact[] = [];
  for (const frame of frames) {
    const da = decodeWith(a, frame);
    const db = decodeWith(b, frame);
    const diffs: SignalDiff[] = [];
    const names = new Set<string>();
    da.decoded?.signals.forEach((s) => names.add(s.name));
    db.decoded?.signals.forEach((s) => names.add(s.name));
    for (const name of [...names].sort()) {
      const sa = da.decoded?.signals.find((s) => s.name === name) ?? null;
      const sb = db.decoded?.signals.find((s) => s.name === name) ?? null;
      const pack = (s: typeof sa) =>
        s ? { physical: s.physical, raw: s.raw, enumLabel: s.enumLabel } : null;
      if (sa && !sb) diffs.push({ signal: name, status: "only_in_a", a: pack(sa), b: null });
      else if (!sa && sb) diffs.push({ signal: name, status: "only_in_b", a: null, b: pack(sb) });
      else if (sa && sb) {
        if (sa.resolved && !sb.resolved)
          diffs.push({ signal: name, status: "unresolved_in_b", a: pack(sa), b: pack(sb) });
        else if (!sa.resolved && sb.resolved)
          diffs.push({ signal: name, status: "unresolved_in_a", a: pack(sa), b: pack(sb) });
        else if (sa.raw !== sb.raw || sa.physical !== sb.physical || sa.enumLabel !== sb.enumLabel)
          diffs.push({ signal: name, status: "changed", a: pack(sa), b: pack(sb) });
      }
    }
    if (diffs.length > 0 || da.message !== db.message) {
      impacts.push({
        frameId: frame.frameId,
        arbitrationId: frame.arbitrationId,
        isExtended: frame.isExtended,
        messageA: da.message,
        messageB: db.message,
        muxBranchA: da.decoded?.muxBranch ?? null,
        muxBranchB: db.decoded?.muxBranch ?? null,
        diffs,
      });
    }
  }
  return impacts;
}
