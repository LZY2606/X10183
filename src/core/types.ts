export type ByteOrder = 'intel' | 'motorola';

export interface CrcCoverage {
  startByte: number; // inclusive
  endByte: number;   // inclusive
}

export interface CrcConfig {
  width?: number;
  polynomial?: number;
  init?: number;
  xorOut?: number;
  reflectIn?: boolean;
  reflectOut?: boolean;
  coverage?: CrcCoverage;
}

export type SignalRole = 'data' | 'counter' | 'crc' | 'mux';

export interface SignalDef {
  name: string;
  startBit: number; // DBC-style start bit (LSB for intel, MSB for motorola)
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  min?: number;
  max?: number;
  unit?: string;
  valueTable?: Record<number, string>;
  role?: SignalRole;
  muxValues?: number[]; // multiplexed signal: active branches
  crc?: CrcConfig;      // when role === 'crc'
}

export interface MessageDef {
  arbitrationId: number;
  isExtended: boolean;
  name: string;
  dlc: number;
  sender: string; // transmitting node
  signals: SignalDef[];
}

export interface DbcLayout {
  messages: MessageDef[];
}

export interface FrameInput {
  channel: string;
  hwTimestamp: number; // hardware timestamp (us)
  arbitrationId: number;
  isExtended: boolean;
  dlc: number;
  data: string; // hex string, e.g. "1122334455667788"
}

export interface FrameRow extends FrameInput {
  id: number;
  importId: number;
  generation: number;
  seq: number;
}

export interface BitPos {
  byte: number;
  bit: number; // 0..7, 0 = LSB
}

export interface BitRange {
  byte: number;
  startBit: number; // lowest bit index in byte (0 = LSB)
  endBit: number;   // highest bit index in byte
}

export interface DecodedSignal {
  name: string;
  role: SignalRole;
  active: boolean;
  byteOrder: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  unit?: string;
  rawValue: number | null;
  physicalValue: number | null;
  enumLabel: string | null;
  bits: BitPos[];
  ranges: BitRange[];
  rawBits: string | null; // preserved raw bits (e.g. unknown mux branch)
  muxValues?: number[];
}

export type CrcStatus = 'pass' | 'fail' | 'unverified';

export interface CrcEvidence {
  signal: string;
  status: CrcStatus;
  reason?: string;
  expected?: number;
  actual?: number;
  coverage?: CrcCoverage;
  coveredBytesHex?: string;
  config?: Required<Omit<CrcConfig, 'coverage'>>;
}

export interface DecodeResult {
  matched: boolean;
  reason?: string;
  messageName?: string;
  sender?: string;
  arbitrationId: number;
  isExtended: boolean;
  muxValue: number | null;
  muxBranch: 'none' | 'known' | 'unknown';
  signals: DecodedSignal[];
  crc: CrcEvidence[];
}
