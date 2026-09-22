// 共享领域类型（前后端通用）

export type ByteOrder = 'intel' | 'motorola';
export type MuxType = 'none' | 'multiplexor' | 'multiplexed';

export interface RawFrame {
  channel: number;
  arbId: number;          // 29 位扩展 ID 也保存在此
  extended: boolean;      // 扩展帧 / 标准帧区分
  hwTime: number;         // 硬件时间（秒）
  data: number[];         // 0..8 字节
}

export interface Frame extends RawFrame {
  id: number;
  importGen: number;      // 采集代次（导入序号）
  importId: number;
  importedAt: string;
}

export interface ValueDesc {
  raw: number;
  label: string;
}

export interface SignalDef {
  id: number;
  messageDefId: number;
  name: string;
  startBit: number;       // DBC 起点位约定
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  unit: string;
  muxType: MuxType;
  muxSwitch: number | null; // multiplexor 时为自身开关值；multiplexed 时为所属分支
  enums: ValueDesc[];
}

export interface MessageDef {
  id: number;
  dbcId: number;
  arbId: number;
  extended: boolean;
  name: string;
  dlc: number;
  transmitter: string;
  signals: SignalDef[];
}

export interface DbcVersion {
  id: number;
  label: string;
  source: string;
  effectiveFrom: number | null;
  effectiveTo: number | null;
  createdAt: string;
  version: number;
  messages: MessageDef[];
}

export interface RuleCounter {
  signalName: string;
  width: number;
  node: string;
}

export interface RuleChecksum {
  signalName: string;
  algorithm: string;    // crc8 | xor
  startByte: number | null;
  endByte: number | null;
  init: number | null;
  xorIn: number | null;
  xorOut: number | null;
}

export interface DecodedSignal {
  signalDefId: number;
  name: string;
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  unit: string;
  muxType: MuxType;
  muxSwitch: number | null;
  active: boolean;                  // false = 分支不匹配 / 未知
  reason?: string;                  // unknown-mux 等
  raw: number | null;               // null = 保留 raw bits 未解释
  rawBits: string;                  // MSB→LSB 的 bit 串
  bitCells: number[];               // 在 8*DLC 网格中的绝对 bit 下标（MSB→LSB）
  physical: number | null;
  enumLabel: string | null;
}

export interface DecodedFrame {
  frame: Frame;
  dbcId: number | null;
  dbcLabel: string | null;
  messageDefId: number | null;
  messageName: string | null;
  byteOrder: ByteOrder | 'mixed';
  signals: DecodedSignal[];
  undecoded: boolean;
  undecodedReason?: string;
}

export type CounterEventType = 'ok' | 'wrap' | 'duplicate' | 'gap';

export interface CounterEvent {
  frameId: number;
  channel: number;
  arbId: number;
  hwTime: number;
  importGen: number;
  node: string;
  signalName: string;
  raw: number | null;
  expected: number | null;
  event: CounterEventType;
  detail: string;
}

export type CrcStatus = 'unchecked' | 'pass' | 'fail';

export interface CrcEvidence {
  frameId: number;
  arbId: number;
  extended: boolean;
  hwTime: number;
  importGen: number;
  node: string;
  signalName: string;
  algorithm: string;
  startByte: number | null;
  endByte: number | null;
  init: number | null;
  xorIn: number | null;
  xorOut: number | null;
  configured: boolean;
  status: CrcStatus;
  detail: string;
  coverageCells: number[];
  expected: number | null;
  actual: number | null;
}

export interface SignalSeriesPoint {
  frameId: number;
  hwTime: number;
  raw: number | null;
  physical: number | null;
  active: boolean;
  enumLabel: string | null;
}

export interface MessageDiff {
  key: string;
  messageName: string;
  arbId: number;
  extended: boolean;
  status: 'added' | 'removed' | 'changed' | 'identical';
  signals: {
    name: string;
    from: Partial<SignalDef> | null;
    to: Partial<SignalDef> | null;
    status: 'added' | 'removed' | 'changed' | 'identical';
  }[];
}

export interface VersionComparison {
  fromDbcId: number;
  toDbcId: number;
  framesCompared: number;
  messages: MessageDiff[];
}

export type MigrationStatus = 'open' | 'approved' | 'incompatible';

export interface Migration {
  id: number;
  fromDbcId: number;
  toDbcId: number;
  status: MigrationStatus;
  rationale: string;
  mapping: MessageDiff[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: number;
  title: string;
  note: string;
  createdAt: string;
  frameCount: number;
  payload: unknown;
}

export interface ApiError {
  error: string;
}
