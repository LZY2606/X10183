export type ByteOrder = 'intel' | 'motorola';

export interface EnumValue {
  value: number;
  label: string;
}

export interface SignalDef {
  name: string;
  /** DBC 风格起始位：b = byteIndex*8 + (7-bitInByteLsb) */
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  factor: number;
  offset: number;
  unit: string | null;
  enums: EnumValue[];
  /** true = 多路选择开关 (SG_ M : ...) */
  muxSwitch: boolean;
  /** 非 null = 仅在该 mux 分支下存在 */
  muxValue: number | null;
  isCounter: boolean;
  isCrc: boolean;
}

export interface CrcRule {
  signal: string;
  /** 覆盖数据字节区间 [coverStart, coverEnd) */
  coverStart: number | null;
  coverEnd: number | null;
  init: number | null;
  xorOut: number | null;
}

export interface CounterRule {
  signal: string;
}

export interface MessageDef {
  arbId: number;
  extended: boolean;
  channel: string | null;
  name: string;
  dlc: number;
  transmitter: string | null;
  signals: SignalDef[];
  crc: CrcRule | null;
  counter: CounterRule | null;
}

export interface DbcDoc {
  nodes: string[];
  messages: MessageDef[];
}

export interface DbcVersionInput {
  label: string;
  startNs: number;
  endNs: number | null;
  doc: DbcDoc;
}

export interface FrameInput {
  arbId: number;
  extended: boolean;
  channel: string | null;
  hwTimeNs: number;
  generation: number;
  dataHex: string;
}

export interface BitSpan {
  /** byte 内从 MSB 起算的 bit 偏移，0..7 */
  startBitInByte: number;
  length: number;
}
