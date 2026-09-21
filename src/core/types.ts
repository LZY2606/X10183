// 核心领域类型定义。

export type ByteOrder = "intel" | "motorola";

/** 信号引用的单个 bit：byte 为字节下标（0 起），bit 为该字节内 bit 位（0=LSB）。 */
export interface BitCell {
  byte: number;
  bit: number;
}

/** 一个信号覆盖的 bit 区间，按“数据位序”排列（Intel: LSB→MSB；Motorola: MSB→LSB）。 */
export interface BitSpan {
  cells: BitCell[];
  /** 起始 DBC bit 编号（用于 UI 布局对照）。 */
  dbcStart: number;
}

export type MultiplexerKind = "plain" | "switch" | "value";

export interface SignalDef {
  id: number;
  messageId: number;
  name: string;
  startBit: number; // DBC 编号
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  minimum: number | null;
  maximum: number | null;
  unit: string | null;
  /** 多路复用类型：plain=普通；switch=多路开关 M；value=分支信号 mN（含扩展 mN:M）。 */
  muxKind: MultiplexerKind;
  /** value 分支：所属开关的匹配原始值。 */
  muxValue: number | null;
  /** value 分支：开关信号名（扩展多路复用）；null 表示隐式单开关。 */
  muxSwitchName: string | null;
  /** SG_MUL_VAL_ 扩展范围（存在时优先于 muxValue）。 */
  muxRanges: Array<[number, number]> | null;
  enums: Record<number, string> | null;
}

export interface MessageDef {
  id: number;
  dbcVersionId: number;
  name: string;
  arbitrationId: number;
  extended: boolean;
  channel: string | null;
  dlc: number;
  transmitter: string | null;
  signals: SignalDef[];
}

export interface DbcVersion {
  id: number;
  name: string;
  versionNumber: number;
  /** 生效区间（采集硬件时间 ns），[effectiveFrom, effectiveTo)。null 端点表示开放。 */
  effectiveFromNs: string | null;
  effectiveToNs: string | null;
  sourceText: string;
}

export interface RawFrame {
  id: number;
  importId: number;
  channel: string | null;
  arbitrationId: number;
  extended: boolean;
  /** 硬件时间，纳秒，以字符串承载 bigint。 */
  hwTimeNs: string;
  data: Buffer;
  /** 帧在其导入批次中的序号（重复时间戳时仍保持确定性）。 */
  seqInImport: number;
}

export interface DecodedSignal {
  signalName: string;
  rawValue: number;
  value: number | string | null;
  enumLabel: string | null;
  bitSpan: BitSpan;
  /** 该信号是否因处于未知 mux 分支而仅保留 raw bits。 */
  unknownMux: boolean;
}

export interface DecodeResult {
  frameId: number;
  dbcVersionId: number | null;
  messageDefId: number | null;
  messageName: string | null;
  signals: DecodedSignal[];
  /** 命中的多路复用分支原始值（按开关名）。 */
  muxBranches: Record<string, number>;
  /** 原始帧中未被任何已激活信号覆盖的 Intel bit 位（如未知 mux 分支）。 */
  unclaimedBits: number[];
}

export type RuleVerdict = "pass" | "fail" | "unchecked";

export interface CounterRule {
  id: number;
  channel: string | null;
  arbitrationId: number;
  extended: boolean;
  signalName: string;
  bits: number;
  factor: number;
  /** 期望值差，通常等于 factor。 */
  increment: number;
  nodeName: string;
}

export type CounterEventType =
  | "ok"
  | "wrap"
  | "duplicate"
  | "gap"
  | "jump"
  | "missing-signal"
  | "duplicate-timestamp";

export interface CounterEvent {
  type: CounterEventType;
  frameId: number;
  hwTimeNs: string;
  generation: string;
  nodeName: string;
  expected: number | null;
  actual: number | null;
  detail: string;
}

export interface CounterReport {
  key: string;
  nodeName: string;
  generation: string;
  verdict: RuleVerdict;
  events: CounterEvent[];
}

export interface CrcRule {
  id: number;
  channel: string | null;
  arbitrationId: number;
  extended: boolean;
  signalName: string;
  widthBits: number;
  startByte: number | null;
  lengthBytes: number | null;
  polynomial: number | null;
  init: number | null;
  xorOut: number | null;
  reflectInput: boolean;
  reflectOutput: boolean;
}

export interface CrcEvidence {
  frameId: number;
  hwTimeNs: string;
  rule: CrcRule;
  verdict: RuleVerdict;
  expected: number | null;
  actual: number | null;
  coveredBytes: number[] | null;
  crcByte: number | null;
  reason: string;
}

export type MappingStatus = "proposed" | "approved" | "incompatible";

export interface MigrationMapping {
  id: number;
  fromVersionId: number;
  toVersionId: number;
  messageDefKey: string;
  fromMessageName: string;
  toMessageName: string | null;
  signalMappings: string; // JSON: {fromSignal: {toSignal, kind}}
  status: MappingStatus;
  note: string | null;
  /** 乐观锁版本号：并发审批冲突检测。 */
  lockVersion: number;
}

export interface Snapshot {
  id: number;
  label: string;
  createdAt: string;
  pinnedDbcVersionId: number;
  payloadJson: string;
}

export interface ImportBatch {
  id: number;
  label: string;
  /** 采集代次标识。 */
  generation: string;
  importedAt: string;
  frameCount: number;
}
