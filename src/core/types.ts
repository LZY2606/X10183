// 核心领域模型：所有纯逻辑模块共用，可在 Node 测试与浏览器中使用。

/** 帧类别：标准帧与扩展帧绝不能混为一类。 */
export type IdKind = "std" | "ext";

/** 帧存储行（原始证据，不经解码）。 */
export interface RawFrame {
  id: number;
  /** 逻辑通道，例如 can0 / can1。 */
  channel: string;
  /** CAN arbitration id（不含 IDE 位）。 */
  arbId: number;
  kind: IdKind;
  /** 原始数据字节，长度 0-8。 */
  data: number[];
  /** 硬件时间戳（秒，浮点保留原始精度字符串由调用方负责）。 */
  hwTime: number;
  /** 采集代次（导入批次标签），计数器按节点 + 代次分别检查。 */
  gen: string;
  /** 导入来源与源内序号，保证不同导入顺序结果相同。 */
  source: string;
  seq: number;
}

/** DBC 信号的多路复用角色。 */
export type MuxRole =
  | { type: "plain" }
  | { type: "switch" }
  | { type: "case"; switchName: string; value: number };

export type ByteOrder = "intel" | "motorola";

/** MSB-first 线性坐标下的连续位段（bit 0 = byte0 物理最低位）。 */
export interface BitRange {
  first: number;
  last: number;
}

/** 一条信号定义（某个 DBC 版本内）。 */
export interface SignalDef {
  name: string;
  startBit: number;
  length: number;
  order: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  unit: string;
  mux: MuxRole;
  /** raw 值 -> 枚举文本。 */
  enums: Record<number, string>;
}

export interface MessageDef {
  arbId: number;
  kind: IdKind;
  name: string;
  dlc: number;
  transmitter: string;
  signals: SignalDef[];
}

export interface DbcVersion {
  id: number;
  /** DBC 版本名/修订号。 */
  name: string;
  /** 生效区间：半开 [effectiveFrom, effectiveTo)；to 为 null 表示开放。 */
  effectiveFrom: number;
  effectiveTo: number | null;
  sourceText: string;
  importedAt: number;
}

/** 解码后单个信号。 */
export interface DecodedSignal {
  name: string;
  /** 信号占用的确切线性位段；Motorola 跨字节信号可能为两段。 */
  bits: BitRange[];
  startBitDbc: number;
  length: number;
  order: ByteOrder;
  raw: number;
  signed: boolean;
  physical: number;
  unit: string;
  scale: number;
  offset: number;
  enumText: string | null;
  mux: MuxRole;
  /** active=在当前多路复用分支中；inactive=不属于该分支；unknown=分支未知但保留 raw。 */
  status: "active" | "inactive" | "unknown";
  /** 该信号未参与解码的原因（inactive/unknown 时）。 */
  reason?: string;
}

export interface DecodedFrame {
  frameId: number;
  dbcVersionId: number;
  dbcVersionName: string;
  messageName: string | null;
  /** 发送节点（来自 BO_ 定义），计数器按节点 + 代次分组。 */
  transmitter: string;
  arbId: number;
  kind: IdKind;
  channel: string;
  hwTime: number;
  gen: string;
  data: number[];
  signals: DecodedSignal[];
  /** 多路复用分支解析证据。 */
  muxBranches: { switch: string; value: number; known: boolean }[];
  error: string | null;
}

/** 计数器事件。 */
export interface CounterEvent {
  frameId: number;
  channel: string;
  hwTime: number;
  gen: string;
  arbId: number;
  kind: IdKind;
  node: string;
  type: "wrap" | "duplicate" | "missing";
  expected: number;
  actual: number;
  detail: string;
}

export type CheckVerdict = "pass" | "fail" | "unverified";

export interface CrcEvidence {
  frameId: number;
  channel: string;
  hwTime: number;
  gen: string;
  verdict: CheckVerdict;
  expected: number | null;
  actual: number | null;
  poly: number;
  init: number;
  xorOut: number;
  coveredBits: { first: number; last: number }[];
  crcBits: BitRange[] | null;
  detail: string;
}

/** CRC 规则配置（按消息定义）。不完整 -> 只能给“未核验”。 */
export interface CrcRule {
  messageName: string;
  /** 覆盖信号名列表；缺省（null）= 除 crc 与计数器外全部信号。 */
  coverSignals: string[] | null;
  crcSignal: string;
  poly: number;
  init: number;
  xorOut: number;
}

/** 计数器规则：信号名按消息配置。 */
export interface CounterRule {
  messageName: string;
  signalName: string;
  width: number;
}

export interface Snapshot {
  id: number;
  name: string;
  createdAt: number;
  /** 冻结时使用的 DBC 版本 id 与消息名（每条帧解码）。 */
  entries: {
    frameId: number;
    dbcVersionId: number;
    messageName: string | null;
    error: string | null;
  }[];
}

export interface MigrationMapping {
  signalName: string;
  fromVersionId: number;
  toVersionId: number;
  oldSignal: string | null;
  newSignal: string | null;
  /** identical=布局语义一致；adapted=可迁移但有差异；incompatible=无法兼容。 */
  classification: "identical" | "adapted" | "incompatible";
  note: string;
}

export interface MigrationRecord {
  id: number;
  messageName: string;
  fromVersionId: number;
  toVersionId: number;
  status: "pending" | "approved" | "rejected";
  /** 乐观并发版本号。 */
  lockVersion: number;
  mappings: MigrationMapping[];
  summary: string;
  createdAt: number;
  updatedAt: number;
}
