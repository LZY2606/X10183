import type { DB } from './db.js';
import { createDbcVersion } from './dbcService.js';
import { importTrace } from './trace.js';
import type { RawFrame } from '../src/types.js';

function crc8Table(poly = 0x07): number[] {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ poly) & 0xff : (c << 1) & 0xff;
    t.push(c);
  }
  return t;
}
const T = crc8Table();
function crc8(bytes: number[], init = 0xff): number {
  let c = init;
  for (const b of bytes) c = T[(c ^ b) & 0xff];
  return c & 0xff;
}

// DBC v1：0..10s
const DBC_V1 = `VERSION "动力-v1"

BO_ 256 EngineData: 8 ECU
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" ECU
 SG_ EngineTemp : 16|16@1- (1,-40) [-40|215] "degC" ECU
 SG_ EngineState : 32|4@1+ (1,0) [0|15] "" ECU
 VAL_ 256 EngineState 0 "Init" 1 "Run" 2 "Stop" 3 "Fault" ;
 SG_ EngineCounter : 40|4@1+ (1,0) [0|15] "" ECU
 SG_ EngineCRC : 48|8@1+ (1,0) [0|255] "" ECU

BO_ 512 BodyData: 8 BCM
 SG_ Mode M : 0|4@1+ (1,0) [0|7] "" BCM
 SG_ WindowPos 0m : 8|8@1+ (1,0) [0|100] "%" BCM
 SG_ LightLevel 1m : 16|8@1+ (1,0) [0|3] "" BCM

BO_ 2566848513 GatewayDiag: 8 GW
 SG_ ExtWord : 0|16@1+ (1,0) [0|65535] "" GW
`;

// DBC v2：10s 起 —— 同 ID 换布局（Motorola 速度、信号重命名）
const DBC_V2 = `VERSION "动力-v2"

BO_ 256 EngineData: 8 ECU
 SG_ VehicleSpeed : 7|16@0+ (0.1,0) [0|6553.5] "km/h" ECU
 SG_ EngineTemp : 23|16@0- (0.5,-40) [-40|87.5] "degC" ECU
 SG_ EngineState : 32|4@1+ (1,0) [0|15] "" ECU
 VAL_ 256 EngineState 0 "Init" 1 "Run" 2 "Stop" 3 "Fault" ;
 SG_ EngineCounter : 40|4@1+ (1,0) [0|15] "" ECU
 SG_ EngineCRC : 48|8@1+ (1,0) [0|255] "" ECU

BO_ 512 BodyData: 8 BCM
 SG_ Mode M : 0|4@1+ (1,0) [0|7] "" BCM
 SG_ WindowPos 0m : 8|8@1+ (1,0) [0|100] "%" BCM
 SG_ LightLevel 1m : 16|8@1+ (1,0) [0|3] "" BCM

BO_ 2566848513 GatewayDiag: 8 GW
 SG_ ExtWord : 0|16@1+ (1,0) [0|65535] "" GW
`;

function engineFrame(time: number, counter: number, speed: number, temp: number, state: number, crc?: number): RawFrame {
  const data = [0, 0, 0, 0, 0, 0, 0, 0];
  const speedRaw = Math.round(speed / 0.25) & 0xffff;
  data[0] = speedRaw & 0xff;
  data[1] = (speedRaw >> 8) & 0xff;
  const tempRaw = (temp + 40) & 0xffff;
  data[2] = tempRaw & 0xff;
  data[3] = (tempRaw >> 8) & 0xff;
  data[4] = state & 0x0f;
  data[5] = counter & 0x0f;
  data[6] = crc8(data.slice(0, 6));
  if (crc !== undefined) data[6] = crc;
  return { channel: 1, arbId: 256, extended: false, hwTime: time, data };
}

export function seedDemo(db: DB): void {
  const dbc1 = createDbcVersion(db, {
    label: '动力-v1',
    source: DBC_V1,
    effectiveFrom: null,
    effectiveTo: 10,
    counters: [{ signalName: 'EngineCounter', width: 4, node: 'ECU' }],
    checksums: [
      { signalName: 'EngineCRC', algorithm: 'crc8', startByte: 0, endByte: 5, init: 0xff, xorIn: 0, xorOut: 0 }
    ]
  });
  const dbc2 = createDbcVersion(db, {
    label: '动力-v2',
    source: DBC_V2,
    effectiveFrom: 10,
    effectiveTo: null,
    counters: [{ signalName: 'EngineCounter', width: 4, node: 'ECU' }],
    checksums: [
      { signalName: 'EngineCRC', algorithm: 'crc8', startByte: 0, endByte: 5, init: 0xff, xorIn: 0, xorOut: 0 }
    ]
  });
  void dbc1;
  void dbc2;

  const gen1: RawFrame[] = [
    engineFrame(0.0, 0, 800, 60, 1),
    engineFrame(0.5, 1, 810, 61, 1),
    engineFrame(1.0, 2, 820, 61, 1),
    engineFrame(1.0, 3, 820, 61, 1), // 重复时间戳
    engineFrame(1.5, 4, 830, 62, 1),
    engineFrame(2.0, 6, 840, 62, 1), // 缺帧（跳过 5）
    engineFrame(2.5, 7, 850, 62, 1),
    engineFrame(3.0, 15, 860, 63, 1), // 环绕到 15
    engineFrame(3.5, 0, 870, 63, 1), // 环绕回 0
    engineFrame(4.0, 1, 880, 64, 3),
    engineFrame(4.5, 2, 890, -30, 1), // 跨字节有符号值
    engineFrame(5.0, 3, 900, 90, 1, 0x00), // CRC 故意错误
    { channel: 1, arbId: 512, extended: false, hwTime: 6.0, data: [0x00, 75, 0, 0, 0, 0, 0, 0] }, // mux 分支 0
    { channel: 1, arbId: 512, extended: false, hwTime: 6.5, data: [0x01, 0, 2, 0, 0, 0, 0, 0] },  // mux 分支 1
    { channel: 1, arbId: 512, extended: false, hwTime: 7.0, data: [0x05, 90, 3, 0, 0, 0, 0, 0] },  // mux 分支未知
    { channel: 2, arbId: 0x18ff0001, extended: true, hwTime: 8.0, data: [0xaa, 0xbb, 0, 0, 0, 0, 0, 0] } // 扩展帧
  ];
  importTrace(db, '台架-采集代次1', gen1);

  const gen2: RawFrame[] = [
    engineFrame(10.5, 0, 1200, 70, 1),
    engineFrame(11.0, 1, 1210, 71, 1),
    engineFrame(11.5, 2, 1220, 71, 1)
  ];
  importTrace(db, '路试-采集代次2', gen2);
}
