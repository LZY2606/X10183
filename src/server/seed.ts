import { computeCrc, type CrcConfig } from '../core/crc.js';
import { encodeRaw } from '../core/bits.js';
import { parseDbc } from '../core/dbc.js';
import { parseTrace } from '../core/trace.js';
import { storeDbc, storeTrace, type DbHandle } from './db.js';
import { upsertCounterConfig, upsertCrcConfig } from './repositories.js';
import { interpretAllFrames } from './analysis.js';

const dbcV1 = `VERSION "v1"
BO_ 256 EngineData: 8 ECU
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" ECU
 SG_ EngineTemp : 16|8@1- (1,-40) [-40|215] "degC" ECU
 SG_ Counter : 24|4@1+ (1,0) [0|15] "" ECU
 SG_ Crc8 : 56|8@1+ (1,0) [0|255] "" ECU
 SG_ Mode M : 32|4@1+ (1,0) [0|15] "" ECU
 SG_ Torque m0 : 40|8@1+ (1,0) [0|255] "Nm" ECU
 SG_ RequestGear m1 : 40|4@1+ (1,0) [0|15] "" ECU

BO_ 2147484033 ExtStatus: 8 TCU
 SG_ GearPosition : 7|8@0+ (1,0) [0|255] "" TCU
 SG_ MotorWord : 8|16@0+ (1,-100) [0|1000] "count" TCU
 VAL_ 2147484033 GearPosition 0 "P" 1 "R" 2 "N" 3 "D" ;
`;

const dbcV2 = `VERSION "v2"
BO_ 256 EngineData: 8 ECU
 SG_ EngineSpeed : 0|16@1+ (0.5,0) [0|32767.5] "rpm" ECU
 SG_ EngineTemp : 16|8@1- (1,-40) [-40|215] "degC" ECU
 SG_ Counter : 24|4@1+ (1,0) [0|15] "" ECU
 SG_ Crc8 : 56|8@1+ (1,0) [0|255] "" ECU
 SG_ Mode M : 32|4@1+ (1,0) [0|15] "" ECU
 SG_ Torque m0 : 40|8@1+ (1,0) [0|255] "Nm" ECU
 SG_ RequestGear m1 : 40|4@1+ (1,0) [0|15] "" ECU
 VAL_ 256 Mode 0 "Idle" 1 "Drive" 2 "Sport" 9 "Mystery" ;

BO_ 2147484033 ExtStatus: 8 TCU
 SG_ GearPosition : 7|8@0+ (1,0) [0|255] "" TCU
 SG_ MotorWord : 8|16@0+ (1,0) [0|1000] "count" TCU
 VAL_ 2147484033 GearPosition 0 "P" 1 "R" 2 "N" 3 "D" 4 "S" ;
`;

function buildEngineFrame(seq: {
  generation: number;
  time: number;
  speedRaw: number;
  tempRaw: number;
  counter: number;
  mode: number;
  branchRaw: number;
  badCrc?: boolean;
}): string {
  const doc = parseDbc(dbcV1, 'engine.dbc');
  const msg = doc.messages.find((m) => m.messageId === 256)!;
  const byName = new Map(msg.signals.map((s) => [s.name, s]));
  const data = new Array(8).fill(0);
  encodeRaw(data, byName.get('EngineSpeed')!, seq.speedRaw);
  encodeRaw(data, byName.get('EngineTemp')!, seq.tempRaw);
  encodeRaw(data, byName.get('Counter')!, seq.counter);
  encodeRaw(data, byName.get('Mode')!, seq.mode);
  encodeRaw(data, byName.get(seq.mode === 1 ? 'RequestGear' : 'Torque')!, seq.branchRaw);
  const cfg: CrcConfig = {
    width: 8,
    poly: 0x07,
    init: 0x00,
    xorOut: 0x00,
    reflectIn: false,
    reflectOut: false,
    coverage: { mode: 'exclude', positions: [] },
    crcBytePositions: [7],
  };
  let crc = computeCrc(data, cfg);
  if (seq.badCrc) crc ^= 0xff;
  encodeRaw(data, byName.get('Crc8')!, crc);
  const hex = data.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return `${seq.generation},1,100,S,rx,${seq.time},8,${hex}`;
}

function buildExtFrame(generation: number, time: number, gear: number, wordRaw: number): string {
  const doc = parseDbc(dbcV1, 'ext.dbc');
  const msg = doc.messages.find((m) => m.messageId === 257)!; // 2147484033 & 0x1fffffff
  const byName = new Map(msg.signals.map((s) => [s.name, s]));
  const data = new Array(8).fill(0);
  encodeRaw(data, byName.get('GearPosition')!, gear);
  encodeRaw(data, byName.get('MotorWord')!, wordRaw);
  const hex = data.map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return `${generation},1,257,X,rx,${time},8,${hex}`;
}

export function isSeeded(handle: DbHandle): boolean {
  const row = handle.db.prepare('SELECT COUNT(*) AS n FROM dbc_versions').get() as { n: number };
  return row.n > 0;
}

export function seed(handle: DbHandle): void {
  storeDbc(handle, dbcV1, {
    versionNumber: 1,
    label: '2025 初版 DBC',
    validFrom: 0,
    validTo: 1000,
    sourceName: 'engine_v1.dbc',
  });
  storeDbc(handle, dbcV2, {
    versionNumber: 2,
    label: '2026 修订 DBC',
    validFrom: 1000,
    validTo: null,
    sourceName: 'engine_v2.dbc',
  });

  const traceLines: string[] = [];
  // generation 1, counters 0..15 then wrap; one duplicate timestamp; one gap
  let t = 10;
  const counters = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2];
  counters.forEach((c, i) => {
    traceLines.push(
      buildEngineFrame({
        generation: 1,
        time: t,
        speedRaw: 1000 + i * 50,
        tempRaw: 60 + i,
        counter: c,
        mode: i % 3,
        branchRaw: 40 + i,
        badCrc: i === 5,
      })
    );
    if (i === 8) t += 0; // duplicate timestamp
    else t += 10;
  });
  // gap: next counter jumps (2 -> 6)
  traceLines.push(buildEngineFrame({ generation: 1, time: t, speedRaw: 2200, tempRaw: 90, counter: 6, mode: 9, branchRaw: 0 }));
  t += 10;

  // generation 2 (new acquisition batch after v2 effective time)
  [0, 1, 2, 3, 4, 5].forEach((c, i) => {
    traceLines.push(
      buildEngineFrame({
        generation: 2,
        time: 1000 + i * 10,
        speedRaw: 3000 + i * 40,
        tempRaw: 80 + i,
        counter: c,
        mode: i % 2,
        branchRaw: 70 + i,
      })
    );
  });

  // extended-id frames across the boundary
  traceLines.push(buildExtFrame(1, 50, 3, 200));
  traceLines.push(buildExtFrame(1, 950, 2, 240));
  traceLines.push(buildExtFrame(2, 1050, 4, 300));

  const { frames, errors } = parseTrace(traceLines.join('\n'));
  if (errors.length) throw new Error(`seed trace error: ${errors.join('; ')}`);
  storeTrace(handle, 'seed-trace.csv', frames);

  upsertCounterConfig(handle, {
    messageKey: '256:0',
    arbitrationId: 256,
    isExtended: false,
    node: 'ECU',
    signalName: 'Counter',
    modulus: 16,
    increment: 1,
  });
  upsertCrcConfig(handle, {
    messageKey: '256:0',
    arbitrationId: 256,
    isExtended: false,
    width: 8,
    poly: 0x07,
    init: 0x00,
    xorOut: 0x00,
    reflectIn: false,
    reflectOut: false,
    coverageMode: 'all',
    coverageFirst: null,
    coverageLast: null,
    coveragePositions: [],
    crcPositions: [7],
    signalName: 'Crc8',
  });
  // Intentionally incomplete CRC config for the extended message: must yield "unchecked".
  upsertCrcConfig(handle, {
    messageKey: '257:1',
    arbitrationId: 257,
    isExtended: true,
    width: null,
    poly: null,
    init: null,
    xorOut: null,
    reflectIn: false,
    reflectOut: false,
    coverageMode: null,
    coverageFirst: null,
    coverageLast: null,
    coveragePositions: [],
    crcPositions: [],
    signalName: null,
  });

  interpretAllFrames(handle);
}
