// 总线刻度 — 演示数据：两个 DBC 版本 × 两个采集代次，含 mux/计数器/CRC/扩展帧
import type Database from 'better-sqlite3';
import { bitCells } from '../shared/codec.js';
import { crc8 } from '../shared/crc.js';
import type { DbcVersionInput, IdKind, MessageDef, SignalDef } from '../shared/types.js';
import { importFrames, type ImportFrameInput } from './frames.js';
import { redecodeAll } from './decode.js';
import { createVersion } from './versions.js';
import { createSnapshot } from './snapshots.js';

function put(cells: ReturnType<typeof bitCells>, value: number, length: number) {
  const bytes = new Uint8Array(8);
  cells.forEach((cell, i) => {
    const shift = length - 1 - i;
    if ((value >> shift) & 1) bytes[cell.byteIndex] |= 1 << (7 - cell.bitInByte);
  });
  return bytes;
}

function sig(
  partial: Partial<SignalDef> &
    Pick<SignalDef, 'name' | 'startBit' | 'length' | 'byteOrder'>
): SignalDef {
  return {
    versionId: 0,
    name: partial.name,
    startBit: partial.startBit,
    length: partial.length,
    byteOrder: partial.byteOrder,
    signed: partial.signed ?? false,
    factor: partial.factor ?? 1,
    offset: partial.offset ?? 0,
    unit: partial.unit ?? '',
    min: partial.min ?? null,
    max: partial.max ?? null,
    muxType: partial.muxType ?? null,
    muxValue: partial.muxValue ?? null,
    role: partial.role ?? null,
    crc: partial.crc ?? null,
    counterModulus: partial.counterModulus ?? null,
    valTable: partial.valTable ?? []
  };
}

function engineV1(): MessageDef[] {
  return [
    {
      versionId: 0,
      arbId: 0x100,
      idKind: 'std',
      name: 'EngineData',
      length: 8,
      sender: 'ECM',
      signals: [
        sig({ name: 'EngineSpeed', startBit: 0, length: 16, byteOrder: 1, factor: 0.25, unit: 'rpm', min: 0, max: 16383.75 }),
        sig({ name: 'CoolantTemp', startBit: 23, length: 16, byteOrder: 0, signed: true, factor: 1, offset: -40, unit: 'degC' }),
        sig({ name: 'AliveCounter', startBit: 32, length: 4, byteOrder: 1, role: 'counter' }),
        sig({
          name: 'Crc8', startBit: 40, length: 8, byteOrder: 1, role: 'crc',
          crc: { startByte: 0, endByte: 5, polynomial: 0x07, init: 0xff, xorOut: 0x00 }
        })
      ]
    },
    {
      versionId: 0,
      arbId: 0x200,
      idKind: 'std',
      name: 'PowerState',
      length: 8,
      sender: 'BCM',
      signals: [
        sig({ name: 'S_Mux', startBit: 0, length: 4, byteOrder: 1, muxType: 'Mux' }),
        sig({
          name: 'Mode', startBit: 4, length: 4, byteOrder: 1,
          valTable: [
            { raw: 0, label: 'Init' },
            { raw: 1, label: 'Run' },
            { raw: 2, label: 'Sleep' }
          ]
        }),
        sig({ name: 'Voltage', startBit: 8, length: 16, byteOrder: 1, factor: 0.01, unit: 'V', muxType: '0', muxValue: 0 }),
        sig({ name: 'Current', startBit: 23, length: 16, byteOrder: 0, signed: true, factor: 0.01, unit: 'A', muxType: '1', muxValue: 1 })
      ]
    },
    {
      versionId: 0,
      arbId: 0x18fef100,
      idKind: 'ext',
      name: 'EEC1_Broadcast',
      length: 8,
      sender: 'ECM',
      signals: [
        sig({ name: 'RoadSpeed', startBit: 7, length: 16, byteOrder: 0, factor: 1 / 256, unit: 'km/h' })
      ]
    }
  ];
}

function engineV2(): MessageDef[] {
  // EngineSpeed 缩放 0.25 -> 1（兼容：仅缩放）；扩展帧 RoadSpeed 起始位改变（不兼容布局）
  const v2 = engineV1();
  v2[0].signals[0] = sig({
    name: 'EngineSpeed', startBit: 0, length: 16, byteOrder: 1, factor: 1, unit: 'rpm'
  });
  v2[2].signals[0] = sig({
    name: 'RoadSpeed', startBit: 15, length: 16, byteOrder: 0, factor: 1 / 256, unit: 'km/h'
  });
  return v2;
}

type ByteArr = number[];

function engineFrame(speedRaw: number, tempSigned: number, counter: number, crcBad = false): ByteArr {
  const bytes = new Uint8Array(8);
  const merge = (b: Uint8Array) => b.forEach((v, i) => { bytes[i] |= v; });
  merge(put(bitCells({ startBit: 0, length: 16, byteOrder: 1 }), speedRaw, 16));
  merge(put(bitCells({ startBit: 23, length: 16, byteOrder: 0 }), tempSigned & 0xffff, 16));
  merge(put(bitCells({ startBit: 32, length: 4, byteOrder: 1 }), counter & 0xf, 4));
  const crc = crc8(bytes, { startByte: 0, endByte: 5, polynomial: 0x07, init: 0xff, xorOut: 0, reflect: false });
  bytes[5] = crcBad ? crc ^ 0xff : crc;
  return [...bytes];
}

function powerFrame(mux: number, mode: number, value: number): ByteArr {
  const bytes = new Uint8Array(8);
  const merge = (b: Uint8Array) => b.forEach((v, i) => { bytes[i] |= v; });
  merge(put(bitCells({ startBit: 0, length: 4, byteOrder: 1 }), mux & 0xf, 4));
  merge(put(bitCells({ startBit: 4, length: 4, byteOrder: 1 }), mode & 0xf, 4));
  if (mux === 0) merge(put(bitCells({ startBit: 8, length: 16, byteOrder: 1 }), value & 0xffff, 16));
  if (mux === 1) merge(put(bitCells({ startBit: 23, length: 16, byteOrder: 0 }), value & 0xffff, 16));
  return [...bytes];
}

function extFrame(speedRaw: number): ByteArr {
  const bytes = new Uint8Array(8);
  put(bitCells({ startBit: 7, length: 16, byteOrder: 0 }), speedRaw & 0xffff, 16).forEach((v, i) => {
    bytes[i] |= v;
  });
  return [...bytes];
}

export function isSeeded(db: Database.Database): boolean {
  const row = db.prepare('SELECT COUNT(*) c FROM dbc_versions').get() as { c: number };
  return row.c > 0;
}

export function seed(db: Database.Database): void {
  if (isSeeded(db)) return;

  // v1 先生效并覆盖全部早期时间，导入两代 trace 后再收窄并引入 v2
  const v1Input: DbcVersionInput = {
    label: 'DBC v1（初始）',
    effectiveFromNs: null,
    effectiveToNs: null,
    messages: engineV1(),
    note: '出厂定义：Intel 转速、Motorola 水温、4bit 计数器、CRC8 覆盖 B0..B4'
  };
  const v1 = createVersion(db, v1Input);

  const gen1Frames: ImportFrameInput[] = [];
  const counters = [14, 15, 0, 1, 1, 3, 4, 5];
  const timesNs = [0, 1, 2, 3, 3, 4, 5, 6].map((ms) => ms * 1_000_000);
  counters.forEach((cnt, i) => {
    gen1Frames.push({
      channel: 0,
      arbId: 0x100,
      idKind: 'std',
      data: engineFrame(4000 + i * 16, 60 + i, cnt, i === 6),
      hwTimeNs: timesNs[i]
    });
  });
  gen1Frames.push({ channel: 0, arbId: 0x200, idKind: 'std', data: powerFrame(0, 1, 1234), hwTimeNs: 1_500_000 });
  gen1Frames.push({ channel: 0, arbId: 0x200, idKind: 'std', data: powerFrame(1, 2, -40 & 0xffff), hwTimeNs: 2_500_000 });
  gen1Frames.push({ channel: 0, arbId: 0x200, idKind: 'std', data: powerFrame(3, 0, 0), hwTimeNs: 3_500_000 });
  gen1Frames.push({ channel: 1, arbId: 0x18fef100, idKind: 'ext', data: extFrame(20480), hwTimeNs: 800_000 });
  gen1Frames.push({ channel: 1, arbId: 0x18fef100, idKind: 'ext', data: extFrame(20736), hwTimeNs: 5_200_000 });

  const gen2Frames: ImportFrameInput[] = [
    { channel: 0, arbId: 0x100, idKind: 'std', data: engineFrame(4160, 72, 9), hwTimeNs: 20_000_000 },
    { channel: 0, arbId: 0x100, idKind: 'std', data: engineFrame(4176, 73, 10), hwTimeNs: 21_000_000 },
    { channel: 0, arbId: 0x100, idKind: 'std', data: engineFrame(4192, 74, 11), hwTimeNs: 22_000_000 },
    { channel: 0, arbId: 0x200, idKind: 'std', data: powerFrame(0, 1, 1300), hwTimeNs: 20_500_000 },
    { channel: 1, arbId: 0x18fef100, idKind: 'ext', data: extFrame(21248), hwTimeNs: 21_500_000 }
  ];

  importFrames(db, gen1Frames, '采集代次 G1：台架首跑');
  importFrames(db, gen2Frames, '采集代次 G2：修订后复测');
  redecodeAll();

  // 冻结调查快照：即使随后 DBC 修订，快照仍指向 v1 旧定义
  createSnapshot(db, '基线调查：DBC v1 全量解码');

  // 引入 v2：v1 仅覆盖 [0ns, 10ms)，v2 覆盖 [10ms, ...)
  db.prepare('UPDATE dbc_versions SET effective_from_ns = ?, effective_to_ns = ?, revision = revision + 1 WHERE id = ?')
    .run(0, 10_000_000, v1.id);
  createVersion(db, {
    label: 'DBC v2（转速缩放修订）',
    effectiveFromNs: 10_000_000,
    effectiveToNs: null,
    messages: engineV2(),
    note: 'EngineSpeed 因子 0.25->1；扩展帧 RoadSpeed 布局调整（不兼容）'
  });
  // v1 生效区间内、定义已改的老解码标记过期；再全量重放得到当前状态
  redecodeAll();
}
