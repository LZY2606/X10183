import type { DatabaseSync } from "node:sqlite";
import { importDbcVersion, insertFrames } from "./repo";
import { upsertCounterRule, upsertCrcRule } from "./repo";
import type { RawFrame } from "../core/types";

const DBC_V1 = `VERSION "ENG-A v1"
BO_ 256 ENGINE_STATUS: 8 ECU
 SG_ EngineSpeed : 0|16@0- (0.25,-100) ["rpm"]
 SG_ EngineTemp : 16|8@0- (1,-40) ["degC"]
 SG_ Mode M : 24|4@0+ (1,0) [""]
 SG_ Torque m0 : 32|16@0+ (0.1,0) ["Nm"]
 SG_ Counter : 48|8@0+ (1,0) [""]
 SG_ Crc : 56|8@0+ (1,0) [""]

BO_ 2147487744 BATT_EXT: 8 BMS
 SG_ PackVoltage : 7|16@1+ (0.01,0) ["V"]
 SG_ PackCurrent : 23|16@1- (0.1,0) ["A"]

VAL_ 256 Mode 0 "Idle" 1 "Run" 2 "Fault";
`;

const DBC_V2 = `VERSION "ENG-A v2"
BO_ 256 ENGINE_STATUS: 8 ECU
 SG_ EngineSpeed : 7|16@1- (0.25,-100) ["rpm"]
 SG_ EngineTemp : 23|8@1- (1,-40) ["degC"]
 SG_ Mode M : 24|4@0+ (1,0) [""]
 SG_ Torque m0 : 32|16@0+ (0.1,0) ["Nm"]
 SG_ Counter : 48|8@0+ (1,0) [""]
 SG_ Crc : 56|8@0+ (1,0) [""]

BO_ 2147487744 BATT_EXT: 8 BMS
 SG_ PackVoltage : 7|16@1+ (0.01,0) ["V"]
 SG_ PackCurrent : 23|16@1- (0.1,0) ["A"]

VAL_ 256 Mode 0 "Idle" 1 "Run" 2 "Fault";
`;

function crc8Bytes(bytes: number[], poly: number, init: number, xorOut: number): number {
  let crc = init & 0xff;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? (((crc << 1) ^ poly) & 0xff) : ((crc << 1) & 0xff);
  }
  return (crc ^ xorOut) & 0xff;
}

/** v1 覆盖：EngineSpeed(16)+EngineTemp(8)+Mode(4)+Torque(16)=44 bit，按线性位序紧凑。 */
function engineCrcV1(d: number[]): number {
  const bits: number[] = [];
  // EngineSpeed bits 0..15
  for (let i = 0; i < 16; i++) bits.push(i);
  // EngineTemp bits 16..23
  for (let i = 16; i < 24; i++) bits.push(i);
  // Mode bits 24..27
  for (let i = 24; i < 28; i++) bits.push(i);
  // Torque bits 32..47
  for (let i = 32; i < 48; i++) bits.push(i);
  const bytes: number[] = [];
  let cur = 0;
  let n = 0;
  for (const linear of bits) {
    const byte = d[Math.floor(linear / 8)];
    cur = (cur << 1) | ((byte >> (linear % 8)) & 1);
    n++;
    if (n === 8) {
      bytes.push(cur);
      cur = 0;
      n = 0;
    }
  }
  if (n) bytes.push(cur << (8 - n));
  return crc8Bytes(bytes, 0x07, 0x00, 0x00);
}

function engineFrameV1(time: number, counter: number, speedRaw: number, tempRaw: number, mode: number, torqueRaw: number, badCrc = false): number[] {
  const d = [0, 0, 0, 0, 0, 0, counter, 0];
  d[0] = speedRaw & 0xff;
  d[1] = (speedRaw >> 8) & 0xff;
  d[2] = tempRaw & 0xff;
  d[3] = mode & 0x0f;
  d[4] = torqueRaw & 0xff;
  d[5] = (torqueRaw >> 8) & 0xff;
  let crc = engineCrcV1(d);
  if (badCrc) crc ^= 0xff;
  d[7] = crc;
  return d;
}

function battFrame(voltageRaw: number, currentRaw: number): number[] {
  // PackVoltage Motorola start 7 len16 -> linear bits 0..15, 大端
  // PackCurrent start23 len16 signed big-endian -> linear bits 16..31
  const d = [0, 0, 0, 0, 0, 0, 0, 0];
  d[0] = (voltageRaw >> 8) & 0xff;
  d[1] = voltageRaw & 0xff;
  d[2] = (currentRaw >> 8) & 0xff;
  d[3] = currentRaw & 0xff;
  return d;
}

export function seedDemo(db: DatabaseSync) {
  importDbcVersion(db, {
    name: "ENG-A-v1",
    sourceText: DBC_V1,
    effectiveFrom: 0,
    effectiveTo: 10,
  });
  importDbcVersion(db, {
    name: "ENG-A-v2",
    sourceText: DBC_V2,
    effectiveFrom: 10,
    effectiveTo: null,
  });

  const frames: RawFrame[] = [];
  let seq = 0;
  const push = (
    time: number,
    gen: string,
    arbId: number,
    kind: "std" | "ext",
    data: number[],
    channel = "can0",
  ) =>
    frames.push({
      id: 0,
      channel,
      arbId,
      kind,
      data,
      hwTime: time,
      gen,
      source: "demo",
      seq: ++seq,
    });

  // gen1：v1 区间（0..10），计数器 1,2,2(重复),4(缺3),255(跳),0(环绕由下一帧)
  push(0.1, "gen1", 0x100, "std", engineFrameV1(0.1, 1, 800, 65, 0, 500));
  push(0.2, "gen1", 0x100, "std", engineFrameV1(0.2, 2, 804, 66, 1, 510));
  push(0.3, "gen1", 0x100, "std", engineFrameV1(0.3, 2, 808, 67, 1, 520)); // duplicate counter
  push(0.4, "gen1", 0x100, "std", engineFrameV1(0.4, 4, 812, 68, 1, 530)); // missing 3
  push(0.5, "gen1", 0x100, "std", engineFrameV1(0.5, 5, 816, 69, 0, 0));
  push(0.6, "gen1", 0x100, "std", engineFrameV1(0.6, 6, 820, 70, 1, 540, true)); // crc fail
  // gen2：v2 区间（>=10），Motorola 布局；覆盖的线性 bit 集合与 v1 相同，CRC 可正确核验。
  push(10.1, "gen2", 0x100, "std", engineFrameV1(10.1, 1, 800, 65, 0, 500));
  push(10.2, "gen2", 0x100, "std", engineFrameV1(10.2, 2, 808, 66, 1, 510));
  // 扩展帧 + 跨字节有符号电流（-12.5A => raw -125 => 0xFF83）
  push(1.0, "gen1", 0x18f001, "ext", battFrame(4000, -125));
  push(11.0, "gen2", 0x18f001, "ext", battFrame(4020, 130));
  // 未知 mux 分支（Mode=9）
  push(2.0, "gen1", 0x100, "std", engineFrameV1(2.0, 7, 830, 71, 9, 560));

  const { inserted } = insertFrames(db, frames);

  upsertCounterRule(db, { messageName: "ENGINE_STATUS", signalName: "Counter", width: 8 });
  upsertCrcRule(db, {
    messageName: "ENGINE_STATUS",
    coverSignals: ["EngineSpeed", "EngineTemp", "Mode", "Torque"],
    crcSignal: "Crc",
    poly: 0x07,
    init: 0x00,
    xorOut: 0x00,
  });

  return {
    dbcVersions: 2,
    framesInserted: inserted,
    note: "演示数据：v1 [0,10) 为 Intel 布局，v2 [10,∞) 为 Motorola；含重复/缺帧/环绕、CRC 失败、未知 mux 与扩展帧。",
  };
}
