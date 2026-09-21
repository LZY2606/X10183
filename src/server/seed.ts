import { getDb } from './db';
import { addVersion } from './services';
import { importTrace } from './db';
import { xorCrc8 } from '../core/crc';
import { contentHash } from './hash';
import type { DbcDoc, FrameInput } from '../core/types';

const MS = 1_000_000;

export function docV1(): DbcDoc {
  return {
    nodes: ['NODE_A', 'NODE_B', 'DIAG', 'EXT_SENSOR'],
    messages: [
      {
        arbId: 0x100,
        extended: false,
        channel: 'CAN1',
        name: 'MOTOR_STATUS',
        dlc: 8,
        transmitter: 'NODE_A',
        signals: [
          { name: 'RollingCounter', startBit: 7, length: 4, byteOrder: 'intel', signed: false, factor: 1, offset: 0, unit: null, enums: [], muxSwitch: false, muxValue: null, isCounter: true, isCrc: false },
          { name: 'Crc8', startBit: 15, length: 8, byteOrder: 'intel', signed: false, factor: 1, offset: 0, unit: null, enums: [], muxSwitch: false, muxValue: null, isCounter: false, isCrc: true },
          { name: 'Temp', startBit: 23, length: 16, byteOrder: 'intel', signed: false, factor: 0.1, offset: -40, unit: 'degC', enums: [], muxSwitch: false, muxValue: null, isCounter: false, isCrc: false },
          { name: 'Voltage', startBit: 32, length: 16, byteOrder: 'motorola', signed: false, factor: 0.01, offset: 0, unit: 'V', enums: [], muxSwitch: false, muxValue: null, isCounter: false, isCrc: false },
        ],
        crc: { signal: 'Crc8', coverStart: 2, coverEnd: 8, init: 0xff, xorOut: 0x00 },
        counter: { signal: 'RollingCounter' },
      },
      {
        arbId: 0x200,
        extended: false,
        channel: 'CAN1',
        name: 'DIAG_MUX',
        dlc: 8,
        transmitter: 'DIAG',
        signals: [
          { name: 'Mode', startBit: 7, length: 4, byteOrder: 'intel', signed: false, factor: 1, offset: 0, unit: null, enums: [{ value: 0, label: 'RPM_MODE' }, { value: 1, label: 'PRESSURE_MODE' }], muxSwitch: true, muxValue: null, isCounter: false, isCrc: false },
          { name: 'EngineRpm', startBit: 15, length: 16, byteOrder: 'intel', signed: false, factor: 0.25, offset: 0, unit: 'rpm', enums: [], muxSwitch: false, muxValue: 0, isCounter: false, isCrc: false },
          { name: 'Pressure', startBit: 15, length: 16, byteOrder: 'intel', signed: false, factor: 1, offset: 0, unit: 'kPa', enums: [], muxSwitch: false, muxValue: 1, isCounter: false, isCrc: false },
        ],
        crc: null,
        counter: null,
      },
      {
        arbId: 0x18fe4a00,
        extended: true,
        channel: 'CAN2',
        name: 'EXT_SIGNED',
        dlc: 8,
        transmitter: 'EXT_SENSOR',
        signals: [
          { name: 'PositionMoto', startBit: 0, length: 16, byteOrder: 'motorola', signed: true, factor: 0.01, offset: 0, unit: 'm', enums: [], muxSwitch: false, muxValue: null, isCounter: false, isCrc: false },
          { name: 'TorqueIntel', startBit: 15, length: 16, byteOrder: 'intel', signed: true, factor: 0.5, offset: 0, unit: 'Nm', enums: [], muxSwitch: false, muxValue: null, isCounter: false, isCrc: false },
        ],
        crc: null,
        counter: null,
      },
    ],
  };
}

export function docV2(): DbcDoc {
  const v1 = docV1();
  const motor = v1.messages[0];
  motor.signals = [
    { name: 'RollingCounter', startBit: 31, length: 8, byteOrder: 'intel', signed: false, factor: 1, offset: 0, unit: null, enums: [], muxSwitch: false, muxValue: null, isCounter: true, isCrc: false },
    { name: 'Crc8', startBit: 15, length: 8, byteOrder: 'intel', signed: false, factor: 1, offset: 0, unit: null, enums: [], muxSwitch: false, muxValue: null, isCounter: false, isCrc: true },
    { name: 'Temp', startBit: 47, length: 16, byteOrder: 'intel', signed: false, factor: 0.5, offset: -20, unit: 'degC', enums: [], muxSwitch: false, muxValue: null, isCounter: false, isCrc: false },
    { name: 'Voltage', startBit: 32, length: 16, byteOrder: 'motorola', signed: false, factor: 0.01, offset: 0, unit: 'V', enums: [], muxSwitch: false, muxValue: null, isCounter: false, isCrc: false },
  ];
  // 修订版 CRC 配置故意不完整：只能“未核验”
  motor.crc = { signal: 'Crc8', coverStart: 2, coverEnd: null, init: 0xff, xorOut: null };
  const diag = v1.messages[1];
  diag.signals[0] = { ...diag.signals[0], startBit: 11, length: 4 };
  return v1;
}

/** 按 DBC 位编号写入信号并自动生成 CRC */
function motorFrame(counter: number, tempRaw: number, voltageRaw: number, opts?: { crcBad?: boolean }): string {
  const bytes = new Uint8Array(8);
  // Intel：参数为信号 LSB 的 DBC 编号
  const setIntel = (value: number, dbcLsb: number, len: number) => {
    const byteIndex = Math.floor(dbcLsb / 8);
    const lsbInByte = 7 - (dbcLsb % 8);
    for (let i = 0; i < len; i++) {
      const lsb = lsbInByte + i;
      const byte = byteIndex + Math.floor(lsb / 8);
      const bit = lsb % 8;
      bytes[byte] |= ((value >> i) & 1) << bit;
    }
  };
  // Motorola：参数为 MSB 的 DBC 起始位
  const setMoto = (value: number, dbcStart: number, len: number) => {
    const byteIndex = Math.floor(dbcStart / 8);
    const msbInByte = dbcStart % 8;
    for (let i = 0; i < len; i++) {
      const byte = byteIndex + Math.floor((msbInByte + i) / 8);
      const bit = 7 - ((msbInByte + i) % 8);
      bytes[byte] |= ((value >> (len - 1 - i)) & 1) << bit;
    }
  };
  setIntel(tempRaw & 0xffff, 23, 16);
  setMoto(voltageRaw & 0xffff, 32, 16);
  setIntel(counter & 0x0f, 7, 4);
  let crc = xorCrc8(bytes.subarray(2, 8), 0xff, 0x00);
  if (opts?.crcBad) crc ^= 0x55;
  setIntel(crc, 15, 8);
  return Buffer.from(bytes).toString('hex');
}

function muxFrame(mode: number, payloadRaw: number): string {
  const bytes = new Uint8Array(8);
  const setIntel = (value: number, dbcLsb: number, len: number) => {
    const byteIndex = Math.floor(dbcLsb / 8);
    const lsbInByte = 7 - (dbcLsb % 8);
    for (let i = 0; i < len; i++) {
      const lsb = lsbInByte + i;
      const byte = byteIndex + Math.floor(lsb / 8);
      const bit = lsb % 8;
      bytes[byte] |= ((value >> i) & 1) << bit;
    }
  };
  setIntel(mode & 0x0f, 7, 4);
  setIntel(payloadRaw & 0xffff, 15, 16);
  return Buffer.from(bytes).toString('hex');
}

function signedFrame(positionS16: number, torqueS16: number): string {
  const bytes = new Uint8Array(8);
  // PositionMoto: motorola 16 bit 起始 7（跨字节 MSB-first：byte0 + byte1）
  bytes[0] = (positionS16 >> 8) & 0xff;
  bytes[1] = positionS16 & 0xff;
  // TorqueIntel: intel 16 bit 起始 16（byte2 低）
  bytes[2] = torqueS16 & 0xff;
  bytes[3] = (torqueS16 >> 8) & 0xff;
  return Buffer.from(bytes).toString('hex');
}

function seedFrames(): FrameInput[] {
  const f: FrameInput[] = [];
  // gen0: 计数器 1..15 正常推进 + 15->0 环绕；随后重复值与缺帧；含重复时间戳
  const seq = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0];
  seq.forEach((c, i) => {
    f.push({
      arbId: 0x100,
      extended: false,
      channel: 'CAN1',
      hwTimeNs: (10 + i * 10) * MS,
      generation: 0,
      dataHex: motorFrame(c, 250 + i, 1200 + i),
    });
  });
  // 重复计数器值（0 后又来 0）
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 170 * MS, generation: 0, dataHex: motorFrame(0, 266, 1216) });
  // 缺帧：期望 1，实际 4
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 180 * MS, generation: 0, dataHex: motorFrame(4, 267, 1217) });
  // CRC 边界错误帧（覆盖范围 [1,7) 内被篡改）
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 190 * MS, generation: 0, dataHex: motorFrame(5, 268, 1218, { crcBad: true }) });
  // 重复时间戳：同节点同代次同硬件时间
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 200 * MS, generation: 0, dataHex: motorFrame(6, 269, 1219) });
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 200 * MS, generation: 0, dataHex: motorFrame(7, 270, 1220) });
  // gen1 独立序列（按节点×代次分组）
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 300 * MS, generation: 1, dataHex: motorFrame(0, 300, 1300) });
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 310 * MS, generation: 1, dataHex: motorFrame(1, 301, 1301) });

  // 多路复用：已知分支 0/1，未知分支 9（保留 raw bits）
  f.push({ arbId: 0x200, extended: false, channel: 'CAN1', hwTimeNs: 40 * MS, generation: 0, dataHex: muxFrame(0, 2400) });
  f.push({ arbId: 0x200, extended: false, channel: 'CAN1', hwTimeNs: 50 * MS, generation: 0, dataHex: muxFrame(1, 330) });
  f.push({ arbId: 0x200, extended: false, channel: 'CAN1', hwTimeNs: 60 * MS, generation: 0, dataHex: muxFrame(9, 0xbeef & 0xffff) });

  // 扩展帧 + 跨字节有符号（Motorola 负值 / Intel 负值）
  f.push({ arbId: 0x18fe4a00, extended: true, channel: 'CAN2', hwTimeNs: 70 * MS, generation: 0, dataHex: signedFrame(-23956, -200) });
  f.push({ arbId: 0x18fe4a00, extended: true, channel: 'CAN2', hwTimeNs: 90 * MS, generation: 0, dataHex: signedFrame(2500, 300) });

  // 生效区间端点：800ms 整由 v2 接管（v1 end 恰好 800ms，半开）
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 790 * MS, generation: 1, dataHex: motorFrame(2, 400, 1400) });
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 800 * MS, generation: 1, dataHex: motorFrame(3, 401, 1401) });
  f.push({ arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 900 * MS, generation: 1, dataHex: motorFrame(4, 402, 1402) });
  return f;
}

export function seedIfEmpty(force = false): { seeded: boolean } {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) c FROM dbc_versions').get() as { c: number }).c;
  const frameCount = (db.prepare('SELECT COUNT(*) c FROM frames').get() as { c: number }).c;
  if (count > 0 && !force) return { seeded: false };
  if (force && frameCount === 0) {
    // 全新路径：直接插入
  }
  addVersion({ label: 'DBC v1（初始定义）', startNs: 0, endNs: 800 * MS, doc: docV1() });
  addVersion({ label: 'DBC v2（2026 修订）', startNs: 800 * MS, endNs: null, doc: docV2() });
  if (frameCount === 0 || force) {
    if (frameCount === 0) importTrace('种子 trace（演示全场景）', seedFrames());
  }
  return { seeded: true };
}

export function seedFingerprint(): string {
  return contentHash({ v1: docV1(), v2: docV2(), frames: seedFrames() });
}
