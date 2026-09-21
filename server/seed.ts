import { computeCrc } from '../src/core/crc.js';
import { clearFrames, insertDbc, insertFrames, insertParsedDbc, listDbcs, upsertCounterRule, upsertCrcRule } from './repo.js';
import type { ParsedMessage } from '../src/core/dbc.js';

const T1 = 100000; // 100s 处 v2 生效（半开区间端点）

/** v1：电机状态 0x100，转速 Intel@0 16bit，温度 Motorola@23 8bit，计数 56，CRC 64 */
const dbcV1Messages: ParsedMessage[] = [
  {
    canId: 0x100,
    isExtended: false,
    name: 'MOTOR_STATUS',
    dlc: 8,
    transmitter: 'MCU',
    signals: [
      { name: 'MotorSpeed', mux: 'normal', startBit: 0, bitLength: 16, byteOrder: 'intel', sign: '+', factor: 0.25, offset: 0, minimum: 0, maximum: 16000, unit: 'rpm' },
      { name: 'MotorTemp', mux: 'normal', startBit: 23, bitLength: 8, byteOrder: 'motorola', sign: '-', factor: 1, offset: -40, minimum: -40, maximum: 215, unit: 'degC' },
      { name: 'RollingCounter', mux: 'normal', startBit: 48, bitLength: 4, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: 0, maximum: 15, unit: null },
      { name: 'Crc8', mux: 'normal', startBit: 56, bitLength: 8, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: 0, maximum: 255, unit: null }
    ],
    enumMap: {}
  },
  {
    canId: 0x200,
    isExtended: false,
    name: 'BODY_CONTROL',
    dlc: 8,
    transmitter: 'BCM',
    signals: [
      { name: 'PedalPos', mux: 'normal', startBit: 7, bitLength: 8, byteOrder: 'motorola', sign: '+', factor: 0.5, offset: 0, minimum: 0, maximum: 100, unit: '%' },
      { name: 'GearLever', mux: 'normal', startBit: 15, bitLength: 4, byteOrder: 'motorola', sign: '+', factor: 1, offset: 0, minimum: 0, maximum: 15, unit: null }
    ],
    enumMap: { GearLever: { 0: 'P', 1: 'R', 2: 'N', 3: 'D' } }
  },
  {
    canId: 0x300,
    isExtended: false,
    name: 'SENSOR_MUX',
    dlc: 8,
    transmitter: 'SENSOR',
    signals: [
      { name: 'Mux', mux: 'switch', startBit: 0, bitLength: 4, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: 0, maximum: 15, unit: null },
      { name: 'Voltage', mux: 1, startBit: 8, bitLength: 16, byteOrder: 'intel', sign: '+', factor: 0.01, offset: 0, minimum: 0, maximum: 655, unit: 'V' },
      { name: 'Current', mux: 2, startBit: 8, bitLength: 16, byteOrder: 'intel', sign: '-', factor: 0.1, offset: 0, minimum: -3276, maximum: 3276, unit: 'A' }
    ],
    enumMap: {}
  },
  {
    canId: 0x100,
    isExtended: true,
    name: 'DIAG_EXT',
    dlc: 8,
    transmitter: 'DIAG',
    signals: [
      { name: 'DiagCode', mux: 'normal', startBit: 0, bitLength: 16, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: 0, maximum: 65535, unit: null }
    ],
    enumMap: {}
  }
];

/** v2：转速改 Motorola@7 16bit 且系数 0.125，温度移到 @31 16bit，新增电压；同一 id 新布局 */
const dbcV2Messages: ParsedMessage[] = [
  {
    canId: 0x100,
    isExtended: false,
    name: 'MOTOR_STATUS',
    dlc: 8,
    transmitter: 'MCU',
    signals: [
      { name: 'MotorSpeed', mux: 'normal', startBit: 7, bitLength: 16, byteOrder: 'motorola', sign: '+', factor: 0.125, offset: 0, minimum: 0, maximum: 8000, unit: 'rpm' },
      { name: 'MotorTemp', mux: 'normal', startBit: 31, bitLength: 16, byteOrder: 'motorola', sign: '-', factor: 0.1, offset: -40, minimum: -40, maximum: 215, unit: 'degC' },
      { name: 'RollingCounter', mux: 'normal', startBit: 48, bitLength: 4, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: 0, maximum: 15, unit: null },
      { name: 'Crc8', mux: 'normal', startBit: 56, bitLength: 8, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: 0, maximum: 255, unit: null },
      { name: 'BattVoltage', mux: 'normal', startBit: 16, bitLength: 16, byteOrder: 'intel', sign: '+', factor: 0.01, offset: 0, minimum: 0, maximum: 655, unit: 'V' }
    ],
    enumMap: {}
  },
  ...dbcV1Messages.slice(1)
];

function motorPayload(speedRpm: number, tempRaw: number, counter: number, crc: number): string {
  const speedRaw = Math.round(speedRpm / 0.25);
  const b = [0, 0, 0, 0, 0, 0, 0, 0];
  b[0] = speedRaw & 0xff;
  b[1] = (speedRaw >> 8) & 0xff;
  // MotorTemp Motorola@23：线性位 23 = byte2 bit7，MSB 起始，8bit 覆盖 23..16 => 即字节 2
  b[2] = tempRaw & 0xff;
  // RollingCounter @48 4bit = 字节 6 的低 4 位；Crc8 @56 = 字节 7
  b[6] = counter & 0x0f;
  b[7] = crc & 0xff;
  return b.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function withCrc(payloadNoCrc: string): string {
  // 覆盖位 0..47（前 6 字节）；CRC 字节本身不参与
  const bytes = new Uint8Array(payloadNoCrc.match(/../g)!.map((h) => parseInt(h, 16)));
  const crc = computeCrc(bytes, [{ startBit: 0, bitLength: 48 }], 0xff) ^ 0x00;
  const head = payloadNoCrc.slice(0, 14);
  return head + crc.toString(16).padStart(2, '0').toUpperCase();
}

export function seed(): { v1: number; v2: number } {
  if (listDbcs().length > 0) {
    const all = listDbcs();
    return { v1: all[0].id, v2: all[1].id };
  }
  const v1 = insertDbc({ label: 'DBC-v1.0', effectiveFrom: null, effectiveTo: T1, createdAt: 1, notes: '初版布局：Intel 转速' }).id;
  const v2 = insertDbc({ label: 'DBC-v2.0', effectiveFrom: T1, effectiveTo: null, createdAt: 2, notes: '转速改 Motorola，温度扩为 16bit，新增电压' }).id;
  insertParsedDbc(v1, dbcV1Messages);
  insertParsedDbc(v2, dbcV2Messages);

  const speeds = [1000, 1500, 2000, 2600, 3000, 3500, 4000, 4200];
  const times = [0, 10000, 25000, 40000, 60000, 120000, 140000, 160000];
  const frames: Parameters<typeof insertFrames>[0] = [];
  speeds.forEach((rpm, i) => {
    const tempRaw = 60 + i * 3; // 物理 20,23,...
    const noCrc = motorPayload(rpm, tempRaw, i % 16, 0);
    frames.push({ canId: 0x100, isExtended: false, channel: 1, hwTime: times[i], dataHex: withCrc(noCrc), acquisitionGen: 1 });
  });
  // 计数器重复（同时间戳重复）与缺帧
  frames.push({ canId: 0x100, isExtended: false, channel: 1, hwTime: 40000, dataHex: withCrc(motorPayload(2550, 66, 3, 0)), acquisitionGen: 1 });
  frames.push({ canId: 0x100, isExtended: false, channel: 1, hwTime: 80000, dataHex: withCrc(motorPayload(2900, 72, 7, 0)), acquisitionGen: 1 });
  // CRC 错误帧
  frames.push({ canId: 0x100, isExtended: false, channel: 1, hwTime: 90000, dataHex: withCrc(motorPayload(2950, 75, 8, 0)).slice(0, 14) + '00', acquisitionGen: 1 });
  // 计数器环绕（15 -> 0），新采集代次
  frames.push({ canId: 0x100, isExtended: false, channel: 2, hwTime: 180000, dataHex: withCrc(motorPayload(4300, 90, 15, 0)), acquisitionGen: 2 });
  frames.push({ canId: 0x100, isExtended: false, channel: 2, hwTime: 200000, dataHex: withCrc(motorPayload(4400, 92, 0, 0)), acquisitionGen: 2 });

  // BODY_CONTROL：踏板 Motorola、档位枚举
  frames.push({ canId: 0x200, isExtended: false, channel: 1, hwTime: 5000, dataHex: '8020000000000000', acquisitionGen: 1 });
  frames.push({ canId: 0x200, isExtended: false, channel: 1, hwTime: 30000, dataHex: 'FFF0000000000000', acquisitionGen: 1 });

  // SENSOR_MUX：已知分支 1、2 与未知分支 9
  frames.push({ canId: 0x300, isExtended: false, channel: 1, hwTime: 12000, dataHex: '0110270000000000', acquisitionGen: 1 });
  frames.push({ canId: 0x300, isExtended: false, channel: 1, hwTime: 13000, dataHex: '02F8FF0000000000', acquisitionGen: 1 });
  frames.push({ canId: 0x300, isExtended: false, channel: 1, hwTime: 14000, dataHex: '09ABCD0000000000', acquisitionGen: 1 });

  // 扩展帧 0x100 不与标准帧混淆
  frames.push({ canId: 0x100, isExtended: true, channel: 1, hwTime: 15000, dataHex: '3905000000000000', acquisitionGen: 1 });

  clearFrames();
  insertFrames(frames);

  upsertCounterRule({ node: 'MCU', signalName: 'RollingCounter', maxValue: 15, dbcId: null });
  upsertCrcRule({
    messageName: 'MOTOR_STATUS',
    signalName: 'Crc8',
    coverage: [{ startBit: 0, bitLength: 48 }],
    init: 0xff,
    xorOut: 0x00,
    dbcId: v1
  });

  return { v1, v2 };
}
