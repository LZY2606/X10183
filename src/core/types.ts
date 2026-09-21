/** 核心领域类型 —— 纯类型，无运行时依赖 */

export type ByteOrder = 'intel' | 'motorola';
export type Sign = '+' | '-';

/** DBC 信号定义 */
export interface SignalDef {
  id: number;
  messageId: number;
  name: string;
  /** 起始 bit：DBC 约定（Intel=LSB 位号，Motorola=MSB 位号） */
  startBit: number;
  bitLength: number;
  byteOrder: ByteOrder;
  sign: Sign;
  factor: number;
  offset: number;
  minimum: number | null;
  maximum: number | null;
  unit: string | null;
  /** 0=普通信号；字符串数字='Multiplexor'；数字=mux 值 */
  muxRole: 'normal' | 'switch' | number;
  enumMap: Record<number, string>;
}

export interface MessageDef {
  id: number;
  dbcId: number;
  /** CAN arbitration id（已剥离扩展标志） */
  canId: number;
  isExtended: boolean;
  name: string;
  dlc: number;
  transmitter: string | null;
  signals: SignalDef[];
}

export interface DbcVersion {
  id: number;
  label: string;
  /** 生效区间（半开 [effectiveFrom, effectiveTo)，ms 硬件时间；null 表示无界） */
  effectiveFrom: number | null;
  effectiveTo: number | null;
  createdAt: number;
  notes: string | null;
}

/** 原始 CAN 帧（按采集时点保存） */
export interface RawFrame {
  id: number;
  canId: number;
  isExtended: boolean;
  channel: number;
  /** 硬件时间戳（ms） */
  hwTime: number;
  /** 数据负载，十六进制（大写，无空格） */
  dataHex: string;
  /** 采集代次 */
  acquisitionGen: number;
  /** 导入序号（仅用于同时间戳的稳定排序，不影响判定结果） */
  importSeq: number;
}

/** 一个信号在某一帧上的解码证据 */
export interface DecodedSignal {
  signalName: string;
  byteOrder: ByteOrder;
  startBitDbc: number;
  bitLength: number;
  /** 占用的 DBC 位号（线性 0..8*DLC-1，可渲染） */
  bitPositions: number[];
  /** 紧凑区间，如 ["0.0","0.3","1.7"] */
  bitRanges: string[];
  raw: number | null;
  signedRaw: number | null;
  physical: number | null;
  factor: number;
  offset: number;
  unit: string | null;
  muxRole: SignalDef['muxRole'];
  enumValue: string | null;
  /** 多路复用分支未知：未参与解码，仅保留 raw bits */
  muxUnknown: boolean;
  /** 分支未知或证据需要时保留的原始比特串（按 bitPositions 顺序，MSB 在前） */
  rawBits?: string;
}

export interface DecodedFrame {
  frame: RawFrame;
  dbc: DbcVersion | null;
  message: MessageDef | null;
  /** 解析说明（无版本/无消息定义等） */
  reason: string;
  muxValue: number | null;
  signals: DecodedSignal[];
}

export interface CounterRule {
  id: number;
  node: string;
  signalName: string;
  maxValue: number | null;
  dbcId: number | null;
}

export type CounterIssueKind = 'duplicate' | 'missing' | 'wrap';
export interface CounterEvent {
  kind: CounterIssueKind;
  frameId: number;
  hwTime: number;
  acquisitionGen: number;
  expected: number;
  actual: number;
  /** 缺帧时丢失的帧数 */
  lost?: number;
}
export interface CounterReport {
  node: string;
  signalName: string;
  groups: { acquisitionGen: number; count: number }[];
  events: CounterEvent[];
  ordered: boolean;
}

/** CRC 覆盖：线性位号区间（byte*8+bitInByte, 0=LSB） */
export interface CrcCoverage {
  startBit: number;
  bitLength: number;
}
export interface CrcRule {
  id: number;
  messageName: string;
  signalName: string | null;
  coverage: CrcCoverage[];
  init: number | null;
  xorOut: number | null;
  dbcId: number | null;
}
export type CrcStatus = 'passed' | 'failed' | 'unchecked';
export interface CrcEvidence {
  frameId: number;
  hwTime: number;
  expected: number | null;
  computed: number | null;
  status: CrcStatus;
  reason: string;
  coveredBits: number[];
  crcBits: number[];
}
export interface CrcReport {
  messageName: string;
  configured: boolean;
  missingConfig: string[];
  evidences: CrcEvidence[];
}

export type MigrationStatus = 'pending' | 'approved' | 'incompatible';
export interface MigrationMapping {
  id: number;
  fromDbcId: number;
  toDbcId: number;
  canId: number;
  isExtended: boolean;
  fromMessage: string | null;
  toMessage: string | null;
  status: MigrationStatus;
  note: string | null;
  lockVersion: number;
}
