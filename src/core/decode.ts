import { applyScale, extractRaw, signalBitPositions, signExtend } from './bits.js';
import { findMessage } from './dbc.js';
import type {
  DbcDocument,
  DecodedFrame,
  DecodedSignal,
  MessageDef,
  RawFrame,
  SignalDef,
} from './types.js';

function decodeOne(data: number[], sig: SignalDef): DecodedSignal {
  const bitPositions = signalBitPositions(sig, data.length);
  const raw = extractRaw(data, sig);
  if (raw === null) {
    return {
      name: sig.name,
      raw: null,
      value: null,
      unit: sig.unit,
      bitPositions,
      startBit: sig.startBit,
      length: sig.length,
      byteOrder: sig.byteOrder,
      factor: sig.factor,
      offset: sig.offset,
      muxKind: sig.muxKind,
      muxSwitchName: sig.muxSwitchName,
      muxValue: sig.muxValue,
      active: false,
      unknownBranch: false,
    };
  }
  const signed = sig.valueType === 'signed' ? signExtend(raw, sig.length) : raw;
  const value = applyScale(signed, sig.factor, sig.offset);
  const enumName = sig.enums.find((e) => e.value === signed)?.name;
  return {
    name: sig.name,
    raw,
    value,
    unit: sig.unit,
    enumName,
    bitPositions,
    startBit: sig.startBit,
    length: sig.length,
    byteOrder: sig.byteOrder,
    factor: sig.factor,
    offset: sig.offset,
    muxKind: sig.muxKind,
    muxSwitchName: sig.muxSwitchName,
    muxValue: sig.muxValue,
    active: true,
    unknownBranch: false,
  };
}

export interface DecodeResult {
  decoded: DecodedFrame | null;
  message?: MessageDef;
  reason?: string;
}

export function decodeFrame(
  frame: RawFrame,
  doc: DbcDocument,
  versionMeta?: { id: number; versionNumber: number; frameRowId?: number }
): DecodeResult {
  const message = findMessage(doc, frame.id, frame.isExtended);
  if (!message) {
    return { decoded: null, reason: 'no matching message definition in this DBC version' };
  }

  const switchSig = message.signals.find((s) => s.muxKind === 'switch');
  let switchRaw: number | null = null;
  if (switchSig) switchRaw = extractRaw(frame.data, switchSig);

  const knownBranchValues = new Set(
    message.signals
      .filter((s) => s.muxKind === 'branch')
      .map((s) => s.muxValue as number)
  );
  const unknownBranch = switchSig !== undefined && switchRaw !== null && !knownBranchValues.has(switchRaw);

  const signals = message.signals.map((sig): DecodedSignal => {
    if (sig.muxKind === 'plain' || sig.muxKind === 'switch') {
      return decodeOne(frame.data, sig);
    }
    // branch signal: present only when the switch selects this branch.
    if (switchRaw === sig.muxValue) {
      return decodeOne(frame.data, sig);
    }
    // Inactive branch: keep raw bits so no information is dropped.
    return {
      name: sig.name,
      raw: null,
      value: null,
      unit: sig.unit,
      bitPositions: signalBitPositions(sig, frame.data.length),
      startBit: sig.startBit,
      length: sig.length,
      byteOrder: sig.byteOrder,
      factor: sig.factor,
      offset: sig.offset,
      muxKind: sig.muxKind,
      muxSwitchName: sig.muxSwitchName,
      muxValue: sig.muxValue,
      active: false,
      unknownBranch: false,
    };
  });

  return {
    message,
    decoded: {
      frameId: versionMeta?.frameRowId ?? -1,
      messageId: message.messageId,
      isExtended: message.isExtended,
      messageName: message.name,
      dbcVersionId: versionMeta?.id ?? -1,
      dbcVersionNumber: versionMeta?.versionNumber ?? 0,
      signals,
      muxSwitch: switchSig && switchRaw !== null ? { name: switchSig.name, raw: switchRaw } : undefined,
      unknownBranch,
    },
  };
}
