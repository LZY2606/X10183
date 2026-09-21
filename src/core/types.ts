export type ByteOrder = 'intel' | 'motorola';
export type ValueType = 'unsigned' | 'signed';
export type MuxKind = 'plain' | 'switch' | 'branch';

export interface EnumValue {
  value: number;
  name: string;
}

export interface SignalDef {
  name: string;
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  valueType: ValueType;
  factor: number;
  offset: number;
  unit: string;
  muxKind: MuxKind;
  muxSwitchName?: string;
  muxValue?: number;
  enums: EnumValue[];
}

export interface MessageDef {
  messageId: number;
  isExtended: boolean;
  name: string;
  dlc: number;
  transmitter: string;
  signals: SignalDef[];
}

export interface DbcDocument {
  name: string;
  messages: MessageDef[];
}

export interface BitPosition {
  linear: number;
  dbc: number;
}

export interface RawFrame {
  generation: number;
  channel: number;
  id: number;
  isExtended: boolean;
  direction: string;
  hwTime: number;
  dlc: number;
  data: number[];
}

export interface StoredFrame extends RawFrame {
  frameId: number;
}

export interface DecodedSignal {
  name: string;
  raw: number | null;
  value: number | null;
  unit: string;
  enumName?: string;
  bitPositions: BitPosition[];
  startBit: number;
  length: number;
  byteOrder: ByteOrder;
  factor: number;
  offset: number;
  muxKind: MuxKind;
  muxSwitchName?: string;
  muxValue?: number;
  active: boolean;
  unknownBranch: boolean;
}

export interface DecodedFrame {
  frameId: number;
  messageId: number;
  isExtended: boolean;
  messageName: string;
  dbcVersionId: number;
  dbcVersionNumber: number;
  signals: DecodedSignal[];
  muxSwitch?: { name: string; raw: number };
  unknownBranch: boolean;
}
