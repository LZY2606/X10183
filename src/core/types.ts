export type ByteOrder = 'intel' | 'motorola';

export interface SignalDef {
  name: string;
  start_bit: number;
  length: number;
  byte_order: ByteOrder;
  signed: boolean;
  scale: number;
  offset: number;
  min?: number;
  max?: number;
  unit?: string;
  value_table?: Record<string, string>;
  multiplexer?: boolean;
  mux_value?: number;
  role?: 'counter' | 'crc' | 'data';
}

export interface CrcRule {
  signal: string;
  coverage?: { start_byte: number; end_byte: number };
  polynomial?: number;
  init?: number;
  xor?: number;
}

export interface MessageDef {
  id: number;
  extended: boolean;
  name: string;
  dlc: number;
  senders: string[];
  signals: SignalDef[];
  crc?: CrcRule;
}

export interface DbcDef {
  name: string;
  messages: MessageDef[];
}

export interface CanFrame {
  channel: string;
  hw_timestamp: number;
  arbitration_id: number;
  extended: boolean;
  dlc: number;
  data: string;
  generation: number;
}

export interface DbcVersionInfo {
  id: number;
  name: string;
  version_num: number;
  effective_from: number;
  effective_to: number | null;
  content: DbcDef;
}
