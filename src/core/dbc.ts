import type { ByteOrder } from './bits';

export type MuxRole =
  | { role: 'none' }
  | { role: 'multiplexor' }
  | { role: 'multiplexed'; switchValue: number };

export type SignalKind = 'normal' | 'counter' | 'crc';

export interface SignalDef {
  name: string;
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  signed: boolean;
  factor: number;
  offset: number;
  unit?: string;
  valueTable?: Record<number, string>;
  mux?: MuxRole;
  kind?: SignalKind;
}

export interface CrcRule {
  signal: string;
  coverage?: { startByte: number; endByte: number } | null;
  polynomial?: number | null;
  initial?: number | null;
  xorOut?: number | null;
  reflectIn?: boolean;
  reflectOut?: boolean;
  width?: number;
}

export interface MessageDef {
  arbitrationId: number;
  isExtended: boolean;
  name: string;
  dlc: number;
  sender: string;
  signals: SignalDef[];
  crcRule?: CrcRule;
}

/** A DBC revision, effective for hw timestamps in [validFrom, validTo). */
export interface DbcDefinition {
  name: string;
  validFrom: number;
  validTo: number | null;
  messages: MessageDef[];
}
