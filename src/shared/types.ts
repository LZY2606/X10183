// 总线刻度 — 核心领域类型（前后端共享）

/** 帧 ID 类别：标准帧（11bit）与扩展帧（29bit）不可混为一类 */
export type IdKind = 'std' | 'ext';

/** 字节序（DBC 约定） */
export type ByteOrder = 1 | 0; // 1 = Intel(little-endian), 0 = Motorola(big-endian)

/** 信号特殊角色：计数器 / CRC 校验 */
export type SignalRole = 'counter' | 'crc' | null;

/** 多路复用类型 */
export type MuxType = null | 'Mux' | string; // 'Mux' = 开关信号；数字N = 在第N分支下的信号

export interface ValTableEntry {
  raw: number;
  label: string;
}

/** DBC 信号定义（带版本身份） */
export interface SignalDef {
  id?: number;
  versionId: number;
  messageId?: number;
  name: string;
  startBit: number; // DBC start bit 编号
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  factor: number;
  offset: number;
  unit: string;
  min: number | null;
  max: number | null;
  muxType: MuxType;
  muxValue: number | null;
  role: SignalRole;
  /** CRC 角色专用配置；配置不完整 => 未核验 */
  crc?: CrcConfig | null;
  /** 计数器模值（默认 16），0/1 视为配置非法 */
  counterModulus?: number | null;
  valTable: ValTableEntry[];
}

/** CRC 规则：覆盖范围、初值、异或值可配置 */
export interface CrcConfig {
  /** 覆盖的连续字节区间 [startByte, endByte]（半开），相对 DLC 做边界校验 */
  startByte: number;
  endByte: number;
  polynomial: number; // 默认 0x07
  init: number | null; // 必填，否则未核验
  xorOut: number | null; // 必填，否则未核验
  reflect?: boolean;
}

/** DBC 消息定义 */
export interface MessageDef {
  id?: number;
  versionId: number;
  /** 去掉扩展标志位的原始 CAN id */
  arbId: number;
  idKind: IdKind;
  name: string;
  length: number; // DLC
  sender: string;
  signals: SignalDef[];
}

export interface DbcVersionInput {
  label: string;
  /** 生效区间（半开 [effectiveFrom, effectiveTo)，null = 开区间），按采集硬件时间 */
  effectiveFromNs: number | null;
  effectiveToNs: number | null;
  dbcText?: string | null;
  messages?: MessageDef[];
  note?: string;
}

export interface DbcVersion {
  id: number;
  label: string;
  revision: number;
  effectiveFromNs: number | null;
  effectiveToNs: number | null;
  note: string | null;
  createdAt: string;
}

export interface RawFrame {
  id?: number;
  channel: number;
  arbId: number;
  idKind: IdKind;
  /** 原始字节（0..8），保持导入顺序的不可变载荷 */
  data: Uint8Array;
  dlc: number;
  /** 硬件时间（纳秒），同一时间戳允许重复 */
  hwTimeNs: number;
  /** 采集代次（导入批次） */
  generation: number;
  rxOrder: number;
}

/** 解码后的单个信号：数值必须能追溯到确切 bit 区间 */
export interface DecodedSignal {
  frameDecodeId?: number;
  signalName: string;
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  factor: number;
  offset: number;
  unit: string;
  role: SignalRole;
  muxType: MuxType;
  muxValue: number | null;
  /** 按位物理坐标，按 MSB->LSB 排列 */
  bitCells: BitCell[];
  /** 从 bitCells 提取的无符号原始值 */
  rawValue: number | null;
  /** 解释后的物理值 */
  physValue: number | null;
  /** 枚举标签 */
  enumLabel: string | null;
  /** 该信号是否为多路复用未知分支（保留 raw bits） */
  muxSkipped: boolean;
  /** bit 区间超出实际 DLC */
  overrun?: boolean;
}

export interface BitCell {
  /** 字节序号 0..7 */
  byteIndex: number;
  /** 该字节内从 MSB 起的位序号 0..7（0 = 0x80） */
  bitInByte: number;
  /** 该位在信号中的权重位次（0 = 信号 MSB） */
  weightIndex: number;
}

export interface FrameDecode {
  id?: number;
  frameId: number;
  versionId: number;
  messageName: string;
  arbId: number;
  idKind: IdKind;
  channel: number;
  hwTimeNs: number;
  generation: number;
  dlc: number;
  dataB64: string;
  signals: DecodedSignal[];
  staleReason: StaleReason | null;
}

export type StaleReason =
  | 'message-removed'
  | 'moved'
  | 'changed'
  | null;

/** 计数器检查事件 */
export interface CounterEvent {
  frameId: number;
  hwTimeNs: number;
  generation: number;
  kind: 'wrap' | 'repeat' | 'missing' | 'init';
  expected: number | null;
  actual: number | null;
  /** 缺失数量（缺帧时） */
  gapCount: number;
  detail: string;
}

export interface CounterReport {
  key: string;
  node: string;
  messageName: string;
  signalName: string;
  modulus: number;
  events: CounterEvent[];
  checked: number;
}

export type CrcStatus = 'pass' | 'fail' | 'unchecked' | 'invalid';

export interface CrcResult {
  frameId: number;
  hwTimeNs: number;
  generation: number;
  status: CrcStatus;
  expected: number | null;
  actual: number | null;
  coveredBytes: number[];
  reason: string;
}

export interface CrcReport {
  key: string;
  node: string;
  messageName: string;
  signalName: string;
  config: CrcConfig | null;
  complete: boolean;
  results: CrcResult[];
}

export interface VersionCompareEntry {
  arbId: number;
  idKind: IdKind;
  messageNameA: string | null;
  messageNameB: string | null;
  relation: 'added' | 'removed' | 'unchanged' | 'compatible' | 'incompatible';
  reason: string;
}

export interface VersionCompare {
  versionA: DbcVersion;
  versionB: DbcVersion;
  entries: VersionCompareEntry[];
  frameImpact: {
    arbId: number;
    idKind: IdKind;
    messageName: string;
    frameCount: number;
    relation: VersionCompareEntry['relation'];
  }[];
}

export interface MigrationMapping {
  id?: number;
  fromVersionId: number;
  toVersionId: number;
  arbId: number;
  idKind: IdKind;
  status: 'approved' | 'incompatible';
  /** 信号迁移说明（旧信号 -> 新信号） */
  signalMapping: { from: string; to: string }[];
  note: string | null;
  revision: number;
  createdAt?: string;
}

export interface Snapshot {
  id: number;
  label: string;
  createdAt: string;
  frameCount: number;
  versionIds: number[];
  payload: SnapshotPayload;
}

export interface SnapshotPayload {
  frozenAtNs: number;
  decodes: FrameDecode[];
  versions: DbcVersion[];
}
