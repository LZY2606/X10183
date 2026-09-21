import { crc8 } from '../core/crc';
import { bytesToHex } from '../core/bits';
import type { CanFrame, DbcDef } from '../core/types';
import {
  createDbcVersion,
  createMigration,
  createSnapshot,
  decodeTrace,
  importTrace,
  type DB,
} from './store';

function setIntel(bytes: Uint8Array, start: number, len: number, value: number): void {
  for (let i = 0; i < len; i++) {
    const p = start + i;
    if ((value >> i) & 1) bytes[p >> 3] |= 1 << (p & 7);
  }
}

function setMotorola(bytes: Uint8Array, start: number, len: number, value: number): void {
  const seq = (start >> 3) * 8 + (7 - (start & 7));
  for (let i = 0; i < len; i++) {
    const p = seq + i;
    if ((value >> (len - 1 - i)) & 1) bytes[p >> 3] |= 1 << (7 - (p & 7));
  }
}

const CRC_RULE = { signal: 'Crc', coverage: { start_byte: 0, end_byte: 6 }, polynomial: 0x1d, init: 0xff, xor: 0xff };

export function engineDbcV1(): DbcDef {
  return {
    name: 'powertrain_v1',
    messages: [
      {
        id: 0x100,
        extended: false,
        name: 'EngineData',
        dlc: 8,
        senders: ['ECM'],
        signals: [
          { name: 'RPM', start_bit: 0, length: 16, byte_order: 'intel', signed: false, scale: 0.25, offset: 0, unit: 'rpm' },
          { name: 'Temp', start_bit: 23, length: 8, byte_order: 'motorola', signed: true, scale: 1, offset: -40, unit: 'degC' },
          { name: 'Mode', start_bit: 24, length: 4, byte_order: 'intel', signed: false, scale: 1, offset: 0, value_table: { '0': 'OFF', '1': 'ON', '2': 'LIMP' } },
          { name: 'Mux', start_bit: 28, length: 4, byte_order: 'intel', signed: false, scale: 1, offset: 0, multiplexer: true },
          { name: 'TorqueA', start_bit: 32, length: 8, byte_order: 'intel', signed: false, scale: 0.5, offset: 0, mux_value: 0, unit: 'Nm' },
          { name: 'TorqueB', start_bit: 32, length: 8, byte_order: 'intel', signed: false, scale: 1, offset: 0, mux_value: 1, unit: 'Nm' },
          { name: 'AliveCounter', start_bit: 40, length: 4, byte_order: 'intel', signed: false, scale: 1, offset: 0, role: 'counter' },
          { name: 'Crc', start_bit: 56, length: 8, byte_order: 'intel', signed: false, scale: 1, offset: 0, role: 'crc' },
        ],
        crc: CRC_RULE,
      },
      {
        id: 0x18ff00e1,
        extended: true,
        name: 'ExtStatus',
        dlc: 8,
        senders: ['BCM'],
        signals: [
          { name: 'Voltage', start_bit: 7, length: 12, byte_order: 'motorola', signed: false, scale: 0.1, offset: 0, unit: 'V' },
          { name: 'Flags', start_bit: 16, length: 8, byte_order: 'intel', signed: false, scale: 1, offset: 0, value_table: { '0': 'IDLE', '3': 'ACTIVE' } },
          { name: 'Alive', start_bit: 24, length: 4, byte_order: 'intel', signed: false, scale: 1, offset: 0, role: 'counter' },
          { name: 'Crc8', start_bit: 32, length: 8, byte_order: 'intel', signed: false, scale: 1, offset: 0, role: 'crc' },
        ],
        crc: { signal: 'Crc8', coverage: { start_byte: 0, end_byte: 3 }, polynomial: 0x1d, init: 0xff },
      },
    ],
  };
}

export function engineDbcV2(): DbcDef {
  const v1 = engineDbcV1();
  const engine = v1.messages[0];
  engine.signals = engine.signals.map((s) => {
    if (s.name === 'RPM') return { ...s, start_bit: 8, length: 12, scale: 0.5 };
    if (s.name === 'AliveCounter') return { ...s, start_bit: 44 };
    return s;
  });
  engine.signals.push({ name: 'Boost', start_bit: 48, length: 8, byte_order: 'intel', signed: false, scale: 0.01, offset: 0, unit: 'bar' });
  return { ...v1, name: 'powertrain_v2' };
}

function engineFrame(
  ts: number,
  generation: number,
  opts: { rpm: number; tempRaw: number; mode: number; mux: number; torque: number; alive: number; corruptCrc?: boolean },
): CanFrame {
  const bytes = new Uint8Array(8);
  setIntel(bytes, 0, 16, opts.rpm);
  setMotorola(bytes, 23, 8, opts.tempRaw & 0xff);
  setIntel(bytes, 24, 4, opts.mode);
  setIntel(bytes, 28, 4, opts.mux);
  setIntel(bytes, 32, 8, opts.torque);
  setIntel(bytes, 40, 4, opts.alive);
  let crc = crc8(bytes.subarray(0, 7), CRC_RULE.polynomial, CRC_RULE.init, CRC_RULE.xor);
  if (opts.corruptCrc) crc ^= 0xff;
  setIntel(bytes, 56, 8, crc);
  return {
    channel: 'can0',
    hw_timestamp: ts,
    arbitration_id: 0x100,
    extended: false,
    dlc: 8,
    data: bytesToHex(bytes),
    generation,
  };
}

function extFrame(ts: number, generation: number, voltageRaw: number, flags: number, alive: number): CanFrame {
  const bytes = new Uint8Array(8);
  setMotorola(bytes, 7, 12, voltageRaw);
  setIntel(bytes, 16, 8, flags);
  setIntel(bytes, 24, 4, alive);
  setIntel(bytes, 32, 8, 0x5a);
  return {
    channel: 'can1',
    hw_timestamp: ts,
    arbitration_id: 0x18ff00e1,
    extended: true,
    dlc: 8,
    data: bytesToHex(bytes),
    generation,
  };
}

export function demoFrames(): CanFrame[] {
  const frames: CanFrame[] = [];
  const aliveSeq = [0, 1, 2, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1];
  aliveSeq.forEach((alive, i) => {
    frames.push(
      engineFrame(100000 + i * 10000, 1, {
        rpm: 3200 + i * 40,
        tempRaw: 120 + i,
        mode: i % 3,
        mux: i % 2,
        torque: 80 + i,
        alive,
        corruptCrc: i === 7,
      }),
    );
  });
  frames.push(engineFrame(120000, 1, { rpm: 3000, tempRaw: 118, mode: 1, mux: 5, torque: 66, alive: 2 }));
  frames.push(extFrame(105000, 1, 138, 3, 0));
  frames.push(extFrame(125000, 1, 139, 3, 1));
  frames.push(extFrame(145000, 1, 137, 0, 2));
  frames.push(engineFrame(550000, 2, { rpm: 1500, tempRaw: 130, mode: 1, mux: 0, torque: 90, alive: 3 }));
  frames.push(engineFrame(560000, 2, { rpm: 1600, tempRaw: 131, mode: 2, mux: 1, torque: 40, alive: 4 }));
  frames.push(extFrame(555000, 2, 141, 3, 3));
  return frames;
}

export function seedDemo(db: DB): Record<string, unknown> {
  const v1 = createDbcVersion(db, { name: 'powertrain', effective_from: 0, effective_to: 499999, content: engineDbcV1() });
  const v2 = createDbcVersion(db, { name: 'powertrain', effective_from: 500000, effective_to: null, content: engineDbcV2() });
  const traceId = importTrace(db, '路试-0422', demoFrames());
  const decoded = decodeTrace(db, traceId);
  const migrationId = createMigration(db, {
    from_version_id: v1,
    to_version_id: v2,
    trace_id: traceId,
    mapping: {
      'EngineData.RPM': { from: { start_bit: 0, length: 16 }, to: { start_bit: 8, length: 12 } },
      'EngineData.AliveCounter': { from: { start_bit: 40 }, to: { start_bit: 44 } },
    },
  });
  const snapshotId = createSnapshot(db, traceId, '调查快照-初始');
  return { trace_id: traceId, dbc_versions: [v1, v2], decoded, migration_id: migrationId, snapshot_id: snapshotId };
}
