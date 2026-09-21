export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface BitCell { byte: number; bit: number }
export interface DecodedSignal {
  signalName: string;
  rawValue: number;
  value: number | string | null;
  enumLabel: string | null;
  bitSpan: { cells: BitCell[]; dbcStart: number };
  unknownMux: boolean;
}
export interface DecodedFrame {
  view: {
    frame: {
      id: number; channel: string | null; arbitrationId: number; extended: boolean;
      hwTimeNs: string; data: Uint8Array | { type: "Buffer"; data: number[] };
    };
    generation: string;
    importLabel: string;
  };
  version: { id: number; name: string; versionNumber: number; effectiveFromNs: string | null; effectiveToNs: string | null } | null;
  message: {
    id: number; name: string; arbitrationId: number; extended: boolean; dlc: number; transmitter: string | null;
    signals: Array<{
      name: string; startBit: number; length: number; byteOrder: "intel" | "motorola";
      signed: boolean; scale: number; offset: number; unit: string | null;
      muxKind: string; muxValue: number | null;
      enums: Record<number, string> | null;
    }>;
  } | null;
  decode: {
    signals: DecodedSignal[];
    muxBranches: Record<string, number>;
    unclaimedBits: number[];
  };
  stale: boolean;
  staleReason: string | null;
}

export interface AppState {
  versions: Array<{ id: number; name: string; versionNumber: number; effectiveFromNs: string | null; effectiveToNs: string | null }>;
  definitions: Record<string, AppState["definitions"][string]>;
  frames: DecodedFrame[];
  counters: CounterReport[];
  crc: CrcEvidenceView[];
  mappings: MappingView[];
  counterRules: unknown[];
  crcRules: unknown[];
  snapshots: Array<{ id: number; label: string; createdAt: string; pinnedDbcVersionId: number; payloadJson: string }>;
}

export interface CounterEvent {
  type: string; frameId: number; hwTimeNs: string; generation: string;
  nodeName: string; expected: number | null; actual: number | null; detail: string;
}
export interface CounterReport { key: string; nodeName: string; generation: string; verdict: string; events: CounterEvent[] }
export interface CrcEvidenceView {
  frameId: number; hwTimeNs: string;
  rule: { id: number; arbitrationId: number; extended: boolean; signalName: string; widthBits: number };
  verdict: string; expected: number | null; actual: number | null;
  coveredBytes: number[] | null; crcByte: number[] | null; reason: string;
}
export interface MappingView {
  id: number; fromVersionId: number; toVersionId: number; messageDefKey: string;
  fromMessageName: string; toMessageName: string | null; signalMappings: string;
  status: string; note: string | null; lockVersion: number;
}

export function dataHex(f: DecodedFrame["view"]["frame"]): string {
  const d = f.data as unknown;
  if (d instanceof Uint8Array) return BufferLike.toHex(d);
  const obj = d as { type?: string; data?: number[] };
  if (obj && obj.type === "Buffer") return BufferLike.toHex(new Uint8Array(obj.data!));
  return "";
}

const BufferLike = {
  toHex(u: Uint8Array): string {
    return [...u].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
};
