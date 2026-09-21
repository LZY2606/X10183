import { encodeSignal } from '../shared/codec.js';
import type { DbcDoc, RawFrameInput, SignalDef } from '../shared/types.js';
import { crc8 } from './checks.js';
import type { Service } from './service.js';

export const SEED_T0 = 1_700_000_000_000;

const speedSig: SignalDef = {
  name: 'Speed', startBit: 0, length: 16, byteOrder: 'intel', signed: false,
  factor: 0.1, offset: 0, unit: 'km/h',
};
const tempSigV1: SignalDef = {
  name: 'Temp', startBit: 16, length: 8, byteOrder: 'intel', signed: true,
  factor: 1, offset: -40, unit: '°C',
};
const tempSigV2: SignalDef = {
  name: 'Temp', startBit: 16, length: 12, byteOrder: 'intel', signed: true,
  factor: 0.5, offset: -40, unit: '°C',
};
const counterSig: SignalDef = {
  name: 'Counter', startBit: 24, length: 4, byteOrder: 'intel', signed: false,
  factor: 1, offset: 0,
};
const crcSig: SignalDef = {
  name: 'Crc', startBit: 32, length: 8, byteOrder: 'intel', signed: false,
  factor: 1, offset: 0,
};
const gearSig: SignalDef = {
  name: 'Gear', startBit: 40, length: 3, byteOrder: 'intel', signed: false,
  factor: 1, offset: 0,
  valueTable: { '0': 'P', '1': 'R', '2': 'N', '3': 'D' },
};

const modeSig: SignalDef = {
  name: 'Mode', startBit: 0, length: 4, byteOrder: 'intel', signed: false,
  factor: 1, offset: 0, muxKind: 'm',
  valueTable: { '1': 'A', '2': 'B' },
};
const subASig: SignalDef = {
  name: 'SubA', startBit: 8, length: 8, byteOrder: 'intel', signed: false,
  factor: 1, offset: 0, muxKind: 'm1',
};
const subBSig: SignalDef = {
  name: 'SubB', startBit: 8, length: 8, byteOrder: 'intel', signed: false,
  factor: 0.5, offset: 0, muxKind: 'm2',
};
const motorTempSig: SignalDef = {
  name: 'MotorTemp', startBit: 23, length: 16, byteOrder: 'motorola', signed: true,
  factor: 0.1, offset: -40, unit: '°C',
};

export function seedDocV1(): DbcDoc {
  return {
    version: 'Powertrain_2024A',
    messages: [
      {
        id: 0x100, idKind: 'standard', name: 'EngStatus', dlc: 8, sender: 'ECU1',
        signals: [speedSig, tempSigV1, counterSig, crcSig],
      },
      {
        id: 0x18fef100, idKind: 'extended', name: 'MuxMsg', dlc: 8, sender: 'ECU2',
        signals: [modeSig, subASig, subBSig, motorTempSig],
      },
    ],
  };
}

export function seedDocV2(): DbcDoc {
  return {
    version: 'Powertrain_2025B',
    messages: [
      {
        id: 0x100, idKind: 'standard', name: 'EngStatus', dlc: 8, sender: 'ECU1',
        signals: [speedSig, tempSigV2, counterSig, crcSig, gearSig],
      },
      {
        id: 0x18fef100, idKind: 'extended', name: 'MuxMsg', dlc: 8, sender: 'ECU2',
        signals: [modeSig, subASig, subBSig, motorTempSig],
      },
    ],
  };
}

function engFrame(i: number, v2: boolean, counterOverride?: number, corruptCrc?: boolean): RawFrameInput {
  const tempSig = v2 ? tempSigV2 : tempSigV1;
  const speedRaw = 800 + i * 3;
  const tempRaw = v2 ? Math.round((60 + (i % 20) * 0.5 + 40) / 0.5) : 80 + (i % 30);
  const counter = counterOverride ?? i % 16;
  let data: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  data = encodeSignal(data, speedSig, speedRaw);
  data = encodeSignal(data, tempSig, tempRaw);
  data = encodeSignal(data, counterSig, counter);
  if (v2) data = encodeSignal(data, gearSig, i % 4);
  const crc = crc8(data.slice(0, 3), 0x00, 0x5a);
  data = encodeSignal(data, crcSig, corruptCrc ? (crc + 1) & 0xff : crc);
  return {
    id: 0x100, idKind: 'standard', data,
    hwTimeMs: SEED_T0 + i * 10,
    channel: 0, generation: 'G1', txNode: 'ECU1',
  };
}

function muxFrame(i: number): RawFrameInput {
  const mode = (i % 3) + 1; // 1,2,3 —— 3 为未知分支
  let data: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  data = encodeSignal(data, modeSig, mode);
  data = encodeSignal(data, subASig, 40 + (i % 50));
  const motorRaw = Math.round((-5 + (i % 40) * 0.5 + 40) / 0.1);
  data = encodeSignal(data, motorTempSig, motorRaw);
  return {
    id: 0x18fef100, idKind: 'extended', data,
    hwTimeMs: SEED_T0 + i * 10 + 5,
    channel: 0, generation: 'G1', txNode: 'ECU2',
  };
}

export function seedFrames(): RawFrameInput[] {
  const frames: RawFrameInput[] = [];
  for (let i = 0; i < 60; i++) {
    const v2 = i >= 30;
    let counterOverride: number | undefined;
    if (i === 17) counterOverride = 19; // 缺帧：跳过 17,18
    if (i === 25) counterOverride = 24 % 16; // 重复计数器
    const frame = engFrame(i, v2, counterOverride, i === 22);
    if (i === 28) frame.hwTimeMs = SEED_T0 + 27 * 10; // 重复时间戳
    frames.push(frame);
    frames.push(muxFrame(i));
  }
  // 采集代次 G2：计数器重新开始
  for (let j = 0; j < 8; j++) {
    frames.push({
      ...engFrame(j, true),
      hwTimeMs: SEED_T0 + 800 + j * 10,
      generation: 'G2',
    });
  }
  return frames;
}

export function seedIfEmpty(svc: Service): void {
  if (svc.listGenerations().length > 0 || svc.listRevisions().length > 0) return;
  svc.importDbc({
    label: 'Powertrain',
    revision: 1,
    effectiveStartMs: SEED_T0,
    effectiveEndMs: SEED_T0 + 299,
    doc: seedDocV1(),
  });
  svc.importDbc({
    label: 'Powertrain',
    revision: 2,
    effectiveStartMs: SEED_T0 + 300,
    effectiveEndMs: null,
    doc: seedDocV2(),
  });
  svc.importFrames(seedFrames(), { format: 'seed', note: '内置演示数据' });
}
