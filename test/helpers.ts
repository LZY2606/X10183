import { openDb, type DB } from '../server/db.js';
import { createDbcVersion } from '../server/dbcService.js';
import { importTrace } from '../server/trace.js';
import { parseDbc } from '../server/dbc.js';
import type { RawFrame } from '../src/types.js';

export function memDb(): DB {
  return openDb(':memory:');
}

export const DBC_V1 = `VERSION "v1"
BO_ 256 EngineData: 8 ECU
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|0] "rpm" ECU
 SG_ EngineTemp : 16|16@1- (1,-40) [0|0] "degC" ECU
 SG_ EngineState : 32|4@1+ (1,0) [0|0] "" ECU
VAL_ 256 EngineState 0 "Init" 1 "Run" 3 "Fault" ;
 SG_ EngineCounter : 40|4@1+ (1,0) [0|0] "" ECU
 SG_ EngineCRC : 56|8@1+ (1,0) [0|0] "" ECU

`;

// Motorola 版本：速度 7|16@0+，温度 23|16@0-
export const DBC_V2 = `VERSION "v2"
BO_ 256 EngineData: 8 ECU
 SG_ VehicleSpeed : 7|16@0+ (0.1,0) [0|0] "km/h" ECU
 SG_ EngineTemp : 23|16@0- (0.5,-40) [0|0] "degC" ECU
 SG_ EngineState : 32|4@1+ (1,0) [0|0] "" ECU
 SG_ EngineCounter : 40|4@1+ (1,0) [0|0] "" ECU
 SG_ EngineCRC : 56|8@1+ (1,0) [0|0] "" ECU
`;

export const DBC_MUX = `VERSION "mux"
BO_ 512 Body: 8 BCM
 SG_ Mode M : 0|4@1+ (1,0) [0|0] "" BCM
 SG_ WindowPos 0m : 8|8@1+ (1,0) [0|0] "%" BCM
 SG_ LightLevel 1m : 16|8@1+ (1,0) [0|0] "" BCM
`;

export const DBC_EXT = `VERSION "ext"
BO_ 2566848513 ExtMsg: 8 GW
 SG_ ExtSig : 0|16@1+ (1,0) [0|0] "" GW
`;

export function setupVersions(db: DB): { v1: number; v2: number } {
  const v1 = createDbcVersion(db, {
    label: 'v1',
    source: DBC_V1,
    effectiveFrom: null,
    effectiveTo: 10,
    counters: [{ signalName: 'EngineCounter', width: 4, node: 'ECU' }],
    checksums: [
      { signalName: 'EngineCRC', algorithm: 'crc8', startByte: 0, endByte: 5, init: 0xff, xorIn: 0, xorOut: 0 }
    ]
  });
  const v2 = createDbcVersion(db, {
    label: 'v2',
    source: DBC_V2,
    effectiveFrom: 10,
    effectiveTo: null,
    counters: [{ signalName: 'EngineCounter', width: 4, node: 'ECU' }],
    checksums: [
      { signalName: 'EngineCRC', algorithm: 'crc8', startByte: 0, endByte: 5, init: 0xff, xorIn: 0, xorOut: 0 }
    ]
  });
  return { v1, v2 };
}

export function frame(time: number, arbId: number, data: number[], extra: Partial<RawFrame> = {}): RawFrame {
  return { channel: 1, arbId, extended: false, hwTime: time, data, ...extra };
}

export function importGen(db: DB, name: string, frames: RawFrame[]): number {
  return importTrace(db, name, frames).importGen;
}

export { parseDbc };
