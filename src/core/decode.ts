import { extractRaw, signalBitPositions, toSigned } from './bits';
import type { BitSpan, MessageDef, SignalDef } from './types';

export interface DecodedSignal {
  name: string;
  isCounter: boolean;
  isCrc: boolean;
  muxRole: 'switch' | 'branch' | 'none';
  muxValue: number | null;
  byteOrder: 'intel' | 'motorola';
  factor: number;
  offset: number;
  unit: string | null;
  signed: boolean;
  bitRange: { first: number; last: number };
  bitLength: number;
  bitCells: number[];
  bitSpans: BitSpan[];
  raw: number | null;
  value: number | null;
  enumLabel: string | null;
  outOfDlc: boolean;
  /** mux 分支未知时为 true：仅保留 raw bits，不做解释 */
  unknownBranch: boolean;
}

export interface MuxPayload {
  switchSignal: string;
  switchRaw: number;
  /** 属于未知分支的原始 bit 单元格（线性 MSB-first） */
  bitCells: number[];
  signalNames: string[];
}

export interface DecodedMessage {
  resolved: true;
  messageName: string;
  arbId: number;
  extended: boolean;
  channel: string | null;
  dlcExpected: number;
  transmitter: string | null;
  byteOrderMixed: boolean;
  signals: DecodedSignal[];
  unknownMux: boolean;
  muxPayload: MuxPayload | null;
  truncated: boolean;
}

export interface UnresolvedMessage {
  resolved: false;
  reason:
    | 'no-message-definition'
    | 'channel-mismatch'
    | 'id-type-mismatch';
}

export type DecodeResult = DecodedMessage | UnresolvedMessage;

function aggregateByByte(cells: number[]): BitSpan[] {
  const sorted = [...cells].sort((a, b) => a - b);
  const spans: BitSpan[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let len = 1;
    while (
      i + len < sorted.length &&
      sorted[i + len] === start + len &&
      Math.floor((start + len) / 8) === Math.floor(start / 8)
    ) {
      len++;
    }
    spans.push({
      startBitInByte: start % 8,
      length: len,
    });
    i += len;
  }
  return spans;
}

function decodeSignal(
  sig: SignalDef,
  data: Uint8Array,
  unknown: boolean,
  muxRole: DecodedSignal['muxRole'],
): DecodedSignal {
  const positions = signalBitPositions(sig.startBit, sig.length, sig.byteOrder);
  const { raw: rawBig, outOfDlc } = extractRaw(data, positions, sig.byteOrder);
  const signedBig = toSigned(rawBig, sig.length, sig.signed);
  const rawNum = Number(rawBig);
  const cells = positions.map((p) => p);
  const bitRange = {
    first: Math.min(...positions),
    last: Math.max(...positions),
  };
  let value: number | null = null;
  let enumLabel: string | null = null;
  if (!unknown) {
    value = Number(signedBig) * sig.factor + sig.offset;
    const hit = sig.enums.find((e) => e.value === Number(signedBig));
    if (hit) enumLabel = hit.label;
  }
  return {
    name: sig.name,
    isCounter: sig.isCounter,
    isCrc: sig.isCrc,
    muxRole,
    muxValue: sig.muxValue,
    byteOrder: sig.byteOrder,
    factor: sig.factor,
    offset: sig.offset,
    unit: sig.unit,
    signed: sig.signed,
    bitRange,
    bitLength: sig.length,
    bitCells: cells,
    bitSpans: aggregateByByte(cells),
    raw: unknown ? rawNum : Number(signedBig),
    value,
    enumLabel,
    outOfDlc,
    unknownBranch: unknown,
  };
}

export function decodeMessage(
  msg: MessageDef,
  data: Uint8Array,
): DecodedMessage {
  const switchSigs = msg.signals.filter((s) => s.muxSwitch);
  const muxSwitch = switchSigs.length > 0 ? switchSigs[0] : null;

  let switchRaw: number | null = null;
  if (muxSwitch) {
    const pos = signalBitPositions(
      muxSwitch.startBit,
      muxSwitch.length,
      muxSwitch.byteOrder,
    );
    switchRaw = Number(extractRaw(data, pos, muxSwitch.byteOrder).raw);
  }

  const branchSignals = msg.signals.filter((s) => s.muxValue !== null);
  const knownBranches = new Set(
    branchSignals.map((s) => s.muxValue as number),
  );
  const unknownMux =
    muxSwitch !== null &&
    branchSignals.length > 0 &&
    !knownBranches.has(switchRaw as number);

  const signals: DecodedSignal[] = [];
  for (const sig of msg.signals) {
    if (sig.muxSwitch) {
      signals.push(decodeSignal(sig, data, false, 'switch'));
    } else if (sig.muxValue !== null) {
      const unknown = unknownMux || sig.muxValue !== switchRaw;
      // unknown=false 仅当“被选中的已知分支”
      const selected = !unknownMux && sig.muxValue === switchRaw;
      signals.push(decodeSignal(sig, data, !selected, 'branch'));
    } else {
      signals.push(decodeSignal(sig, data, false, 'none'));
    }
  }

  let muxPayload: MuxPayload | null = null;
  if (unknownMux && muxSwitch) {
    const cells = new Set<number>();
    const names: string[] = [];
    for (const sig of branchSignals) {
      names.push(sig.name);
      for (const p of signalBitPositions(
        sig.startBit,
        sig.length,
        sig.byteOrder,
      )) {
        cells.add(p);
      }
    }
    muxPayload = {
      switchSignal: muxSwitch.name,
      switchRaw: switchRaw as number,
      bitCells: [...cells].sort((a, b) => a - b),
      signalNames: [...new Set(names)],
    };
  }

  const orders = new Set(msg.signals.map((s) => s.byteOrder));
  const truncated = data.length < msg.dlc;

  return {
    resolved: true,
    messageName: msg.name,
    arbId: msg.arbId,
    extended: msg.extended,
    channel: msg.channel,
    dlcExpected: msg.dlc,
    transmitter: msg.transmitter,
    byteOrderMixed: orders.size > 1,
    signals,
    unknownMux,
    muxPayload,
    truncated,
  };
}
