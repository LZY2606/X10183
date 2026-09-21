/** 总线刻度 - 共享领域类型 */

export type ByteOrder = 'intel' | 'motorola';
export type IdKind = 'standard' | 'extended';

/** 信号定义（来自某个 DBC 版本，不可变） */
export interface SignalDef {
  name: string;
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  factor: number;
  offset: number;
  unit?: string;
  min?: number;
  max?: number;
  valueTable?: Record<string, string>;
  muxKind?: string;
  sender?: string;
}

export interface MessageDef {
  id: number;
  idKind: IdKind;
  name: string;
  dlc: number;
  signals: SignalDef[];
  sender?: string;
}

export interface DbcDoc {
  version?: string;
  messages: MessageDef[];
}

export interface DbcRevisionInput {
  label: string;
  revision: number;
  effectiveStartMs: number;
  effectiveEndMs: number | null;
  doc: DbcDoc;
}

export interface RawFrameInput {
  id: number | string;
  idKind?: IdKind;
  data: number[] | string;
  hwTimeMs?: number;
  hwTimeSec?: number;
  channel?: number | string;
  generation?: string | number;
  txNode?: string;
}

export interface DecodedSignal {
  name: string;
  raw: number;
  physical: number;
  enumLabel?: string;
  unit?: string;
  factor: number;
  offset: number;
  byteOrder: ByteOrder;
  signed: boolean;
  startBit: number;
  length: number;
  bitTrace: BitCell[];
  muxRole: 'switch' | 'data';
  muxValue?: number;
  muxBranch?: number;
}

export interface BitCell {
  byteIndex: number;
  bitInByte: number;
  wireBit: number;
}

export interface UndecodedSignal {
  name: string;
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  muxKind?: string;
  rawBits: number[];
  bitTrace: BitCell[];
  reason: 'mux-branch-unknown';
}

export interface DecodeResult {
  matched: boolean;
  messageName?: string;
  messageId?: number;
  idKind?: IdKind;
  revisionId?: number;
  revisionLabel?: string;
  revisionNumber?: number;
  muxSwitchValue?: number;
  signals: DecodedSignal[];
  undecoded: UndecodedSignal[];
  reason?: 'no-message-def' | 'no-effective-revision';
}

export type CheckStatus = 'pass' | 'fail' | 'fail-unverified';

export type CheckVerdict = 'pass' | 'fail' | 'unverified';

export interface CounterConfig {
  node: string;
  messageKey: string;
  signalName: string;
  window?: number | null;
}

export interface CrcConfig {
  messageKey: string;
  signalName: string;
  algo: 'crc8' | 'sum8';
  coverStartByte?: number | null;
  coverEndByte?: number | null;
  init?: number | null;
  xorOut?: number | null;
}

export interface ReviewDecision {
  fromRevisionId: number;
  toRevisionId: number;
  messageKey: string;
  status: 'approved' | 'incompatible';
  mapping?: Record<string, string>;
  version: number;
}

export function messageKey(id: number, kind: IdKind): string {
  return `${id >>> 0}:${kind}`;
}

export function normalizeIdKind(id: number, kind?: IdKind): IdKind {
  if (kind === 'standard' || kind === 'extended') return kind;
  return id > 0x7ff ? 'extended' : 'standard';
}
