import { applySign, extractBits, positionsToBitString, type BitSegment } from './bits';
import { verifyCrc, type CrcEvidence } from './crc';
import type { ByteOrder, DbcDef, MessageDef, SignalDef } from './types';

export interface DecodedSignal {
  name: string;
  raw_unsigned: string;
  raw: string;
  physical: number | null;
  enum_label: string | null;
  unit: string | null;
  byte_order: ByteOrder;
  scale: number;
  offset: number;
  bit_segments: BitSegment[];
  role: string;
  mux: {
    is_switch: boolean;
    mux_value: number | null;
    branch: number | null;
    active: boolean;
  };
  status: 'ok' | 'inactive_branch' | 'unknown_branch';
  raw_bits: string | null;
}

export interface DecodedFrame {
  matched: boolean;
  message: string | null;
  arbitration_id: number;
  extended: boolean;
  mux_branch: number | null;
  signals: DecodedSignal[];
  crc: CrcEvidence | null;
  error?: string;
}

export function findMessage(
  dbc: DbcDef,
  arbitrationId: number,
  extended: boolean,
): MessageDef | undefined {
  return dbc.messages.find((m) => m.id === arbitrationId && m.extended === extended);
}

function decodeSignal(
  sig: SignalDef,
  data: Uint8Array,
  branch: number | null,
  knownBranches: Set<number>,
): DecodedSignal {
  const ext = extractBits(data, sig.start_bit, sig.length, sig.byte_order);
  const signedRaw = applySign(ext.raw, sig.length, sig.signed);
  const physical = Number(signedRaw) * sig.scale + sig.offset;
  const enumLabel = sig.value_table ? sig.value_table[ext.raw.toString()] ?? null : null;
  const isMuxed = sig.mux_value !== undefined;
  let status: DecodedSignal['status'] = 'ok';
  let active = true;
  if (isMuxed) {
    if (branch === null || sig.mux_value !== branch) {
      active = false;
      status =
        branch !== null && !knownBranches.has(branch) ? 'unknown_branch' : 'inactive_branch';
    }
  }
  return {
    name: sig.name,
    raw_unsigned: ext.raw.toString(),
    raw: signedRaw.toString(),
    physical,
    enum_label: enumLabel,
    unit: sig.unit ?? null,
    byte_order: sig.byte_order,
    scale: sig.scale,
    offset: sig.offset,
    bit_segments: ext.segments,
    role: sig.role ?? 'data',
    mux: {
      is_switch: !!sig.multiplexer,
      mux_value: sig.mux_value ?? null,
      branch,
      active,
    },
    status,
    raw_bits:
      status === 'unknown_branch' ? positionsToBitString(ext.positions, data) : null,
  };
}

export function decodeFrame(msg: MessageDef, data: Uint8Array): DecodedFrame {
  const muxSwitch = msg.signals.find((s) => s.multiplexer);
  let branch: number | null = null;
  if (muxSwitch) {
    const ext = extractBits(data, muxSwitch.start_bit, muxSwitch.length, muxSwitch.byte_order);
    branch = Number(ext.raw);
  }
  const knownBranches = new Set(
    msg.signals.filter((s) => s.mux_value !== undefined).map((s) => s.mux_value as number),
  );
  const signals = msg.signals.map((s) => decodeSignal(s, data, branch, knownBranches));
  const crcSignal = msg.crc ? signals.find((s) => s.name === msg.crc!.signal) : undefined;
  const crc = msg.crc
    ? verifyCrc(msg, data, crcSignal ? Number(crcSignal.raw_unsigned) : null)
    : null;
  return {
    matched: true,
    message: msg.name,
    arbitration_id: msg.id,
    extended: msg.extended,
    mux_branch: branch,
    signals,
    crc,
  };
}

export function unmatchedFrame(arbitrationId: number, extended: boolean): DecodedFrame {
  return {
    matched: false,
    message: null,
    arbitration_id: arbitrationId,
    extended,
    mux_branch: null,
    signals: [],
    crc: null,
    error: 'no_matching_message',
  };
}
