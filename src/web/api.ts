async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json as T;
}

export const api = {
  state: () => req<AppState>('GET', '/api/state'),
  timeline: (params: Record<string, string | number | undefined>) =>
    req<TimelineEntry[]>('GET', '/api/timeline?' + qs(params)),
  decodeFrame: (frameId: number, revisionId?: number) =>
    req<DecodeResponse>('GET', `/api/frames/${frameId}/decode` + (revisionId ? `?revisionId=${revisionId}` : '')),
  series: (key: string, signal: string, revisionId?: number) =>
    req<SeriesPoint[]>('GET', '/api/signals/series?' + qs({ key, signal, revisionId })),
  importTrace: (text: string, note?: string) =>
    req<{ importId: number; frameCount: number }>('POST', '/api/trace/import', { text, note }),
  importDbc: (payload: Record<string, unknown>) =>
    req<{ id: number }>('POST', '/api/dbc/import', payload),
  setInterval: (revisionId: number, effectiveStartMs: number, effectiveEndMs: number | null) =>
    req<unknown>('POST', `/api/dbc/revisions/${revisionId}/interval`, { effectiveStartMs, effectiveEndMs }),
  counter: (params: Record<string, string | number | undefined>) =>
    req<CounterReport>('GET', '/api/checks/counter?' + qs(params)),
  crc: (params: Record<string, string | number | undefined>) =>
    req<CrcReport>('GET', '/api/checks/crc?' + qs(params)),
  createSnapshot: (name: string, note?: string) =>
    req<SnapshotSummary>('POST', '/api/snapshots', { name, note }),
  snapshots: () => req<SnapshotSummary[]>('GET', '/api/snapshots'),
  snapshot: (id: number) => req<SnapshotEntry[]>('GET', `/api/snapshots/${id}`),
  compare: (from: number, to: number) =>
    req<MessageComparison[]>('GET', '/api/compare?' + qs({ from, to })),
  ensureReview: (fromRevisionId: number, toRevisionId: number, messageKey: string) =>
    req<ReviewRow>('POST', '/api/reviews/ensure', { fromRevisionId, toRevisionId, messageKey }),
  decide: (reviewId: number, version: number, decision: string, mapping?: Record<string, string>) =>
    req<ReviewRow>('POST', `/api/reviews/${reviewId}/decide`, { version, decision, mapping }),
};

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  return sp.toString();
}

// ---- 类型（与后端响应一致的结构子集） ----
export interface AppState {
  generations: { name: string; firstSeenMs: number; frameCount: number }[];
  imports: { id: number; importedAtMs: number; format: string; frameCount: number; note: string | null }[];
  revisions: RevisionInfo[];
  snapshots: SnapshotSummary[];
  reviews: ReviewRow[];
}
export interface RevisionInfo {
  id: number; label: string; revision: number;
  effectiveStartMs: number; effectiveEndMs: number | null;
  importedAtMs: number; messageCount: number; docVersion: string | null;
}
export interface TimelineEntry {
  id: number; arbId: number; idKind: string; channel: string;
  hwTimeMs: number; generation: string; txNode: string | null;
  data: number[]; seq: number; messageKey: string;
  decode: DecodeResult; cachedDecode: boolean;
}
export interface DecodeResult {
  matched: boolean; messageName?: string; messageId?: number; idKind?: string;
  revisionId?: number; revisionLabel?: string; revisionNumber?: number;
  muxSwitchValue?: number;
  signals: DecodedSignal[]; undecoded: UndecodedSignal[]; reason?: string;
}
export interface DecodedSignal {
  name: string; raw: number; physical: number; enumLabel?: string; unit?: string;
  factor: number; offset: number; byteOrder: string; signed: boolean;
  startBit: number; length: number;
  bitTrace: { byteIndex: number; bitInByte: number; wireBit: number }[];
  muxRole: string; muxValue?: number; muxBranch?: number;
}
export interface UndecodedSignal {
  name: string; startBit: number; length: number; byteOrder: string;
  muxKind?: string; rawBits: number[]; reason: string;
  bitTrace: { byteIndex: number; bitInByte: number; wireBit: number }[];
}
export interface DecodeResponse {
  frame: TimelineEntry['decode'] extends never ? never : {
    id: number; arbId: number; idKind: string; channel: string;
    hwTimeMs: number; generation: string; txNode: string | null; data: number[];
  };
  result: DecodeResult; cached: boolean; stale: boolean; effectiveRevisionId: number | null;
}
export interface SeriesPoint {
  frameId: number; hwTimeMs: number; generation: string;
  raw: number; physical: number; enumLabel?: string; revisionId: number | null;
}
export interface CounterReport {
  verdict: string; window: number | null; reason?: string;
  perGeneration: {
    generation: string; node: string;
    evidence: {
      frameSeq: number; hwTimeMs: number; generation: string; channel: string; node: string;
      observed: number | null; expected: number | null; findings: string[]; pass: boolean;
    }[];
    gaps: { fromSeq: number; toSeq: number; missing: number[] }[];
    pass: boolean;
  }[];
}
export interface CrcReport {
  verdict: string; reason?: string;
  config: { algo: string; coverStartByte: number | null; coverEndByte: number | null; init: number; xorOut: number };
  evidence: {
    frameSeq: number; hwTimeMs: number; generation: string;
    observed: number | null; computed: number; coveredBytes: number[]; pass: boolean;
  }[];
}
export interface SnapshotSummary { id: number; name: string; createdAtMs: number; frameCount: number; note: string | null }
export interface SnapshotEntry { frame: TimelineEntry; revisionId: number; result: DecodeResult }
export interface MessageComparison {
  id: number; idKind: string; oldName: string | null; newName: string | null;
  presentIn: string[];
  signalDiffs: {
    oldName: string | null; newName: string | null; change: string;
    details: string[]; compatible: boolean;
  }[];
  autoMapping: Record<string, string>; fullyCompatible: boolean;
}
export interface ReviewRow {
  id: number; fromRevisionId: number; toRevisionId: number; messageKey: string;
  status: string; mapping: Record<string, string> | null; version: number; updatedAtMs: number;
}
