import { newTestDb } from "../src/server/db";
import type { DatabaseSync } from "node:sqlite";
import {
  importDbcVersion,
  insertFrames,
  upsertCounterRule,
  upsertCrcRule,
} from "../src/server/repo";
import type { IdKind, RawFrame } from "../src/core/types";

export const DBC_V1 = `VERSION "v1"
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

export const DBC_V2 = `VERSION "v2"
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

export function setupDb(): DatabaseSync {
  const db = newTestDb();
  importDbcVersion(db, { name: "v1", sourceText: DBC_V1, effectiveFrom: 0, effectiveTo: 10 });
  importDbcVersion(db, { name: "v2", sourceText: DBC_V2, effectiveFrom: 10, effectiveTo: null });
  return db;
}

export function seedRules(db: DatabaseSync) {
  upsertCounterRule(db, { messageName: "ENGINE_STATUS", signalName: "Counter", width: 8 });
  upsertCrcRule(db, {
    messageName: "ENGINE_STATUS",
    coverSignals: ["EngineSpeed", "EngineTemp", "Mode", "Torque"],
    crcSignal: "Crc",
    poly: 0x07,
    init: 0x00,
    xorOut: 0x00,
  });
}

let counter = 0;
export function frame(
  time: number,
  arbId: number,
  kind: IdKind,
  data: number[],
  gen = "gen1",
  channel = "can0",
): RawFrame {
  return {
    id: 0,
    channel,
    arbId,
    kind,
    data,
    hwTime: time,
    gen,
    source: "test",
    seq: ++counter,
  };
}

export function insert(...frames: RawFrame[]) {
  // 使用最近创建的 db 不便；调用方自己 insertFrames。保留便捷函数在具体测试里。
  return frames;
}

export { insertFrames };
