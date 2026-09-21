import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, storeDbc, storeTrace, type DbHandle } from '../src/server/db.js';
import { parseTrace } from '../src/core/trace.js';
import { freezeSnapshot, interpretAllFrames, interpretFrame, readSnapshot, runCounterChecks, runCrcChecks, compareVersions } from '../src/server/analysis.js';
import { putMigrationMap, approveMigrationMap, listMigrationMaps, upsertCounterConfig } from '../src/server/repositories.js';

const dbPath = join(process.cwd(), 'data', 'test-integration.sqlite');

let handle: DbHandle;

const v1 = `VERSION ""
BO_ 100 M: 8 ECU
 SG_ Speed : 0|16@1+ (1,0) [0|65535] "u" ECU
 SG_ Counter : 23|8@1+ (1,0) [0|255] "" ECU
`;

const v2 = `VERSION ""
BO_ 100 M: 8 ECU
 SG_ Speed : 0|16@1+ (2,0) [0|65535] "u" ECU
 SG_ Counter : 23|8@1+ (1,0) [0|255] "" ECU
`;

const v2Moved = `VERSION ""
BO_ 100 M: 8 ECU
 SG_ Speed : 16|16@1+ (1,0) [0|65535] "u" ECU
 SG_ Counter : 23|8@1+ (1,0) [0|255] "" ECU
`;

function trace(): string {
  const lines: string[] = [];
  const counters = [0, 1, 2, 3, 4, 5];
  for (let i = 0; i < 6; i++) {
    const speed = 100 + i;
    const b0 = speed & 0xff;
    const b1 = (speed >> 8) & 0xff;
    const ctr = counters[i];
    lines.push(`1,1,100,S,rx,${100 + i},8,${[b0, b1, ctr, 0, 0, 0, 0, 0].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
  }
  return lines.join('\n');
}

beforeEach(() => {
  rmSync(dbPath, { force: true });
  handle = openDatabase(dbPath);
});
afterEach(() => {
  handle.close();
  rmSync(dbPath, { force: true });
});

describe('effective interval endpoints', () => {
  it('resolves [validFrom, validTo): frame at validTo uses the later version', () => {
    storeDbc(handle, v1, { versionNumber: 1, label: 'a', validFrom: 0, validTo: 103, sourceName: 'a.dbc' });
    storeDbc(handle, v2, { versionNumber: 2, label: 'b', validFrom: 103, validTo: null, sourceName: 'b.dbc' });
    storeTrace(handle, 't.csv', parseTrace(trace()).frames);
    interpretAllFrames(handle);

    // frame at t=102 -> v1, frame at t=103 -> v2
    const f102 = handle.db.prepare('SELECT id FROM frames WHERE hw_time = 102').get() as { id: number };
    const f103 = handle.db.prepare('SELECT id FROM frames WHERE hw_time = 103').get() as { id: number };
    expect(interpretFrame(handle, f102.id)!.decoded!.dbcVersionNumber).toBe(1);
    expect(interpretFrame(handle, f103.id)!.decoded!.dbcVersionNumber).toBe(2);
    // v2 doubles the scaling: raw 102 (speed=102) => value 204
    expect(interpretFrame(handle, f103.id)!.decoded!.signals[0].value).toBe(206);
  });
});

describe('staleness after DBC revision', () => {
  it('only frames whose effective decode changed go stale; snapshots keep old definition', () => {
    storeDbc(handle, v1, { versionNumber: 1, label: 'a', validFrom: 0, validTo: null, sourceName: 'a.dbc' });
    storeTrace(handle, 't.csv', parseTrace(trace()).frames);
    interpretAllFrames(handle);
    const first = handle.db.prepare('SELECT id FROM frames ORDER BY hw_time LIMIT 1').get() as { id: number };
    expect(interpretFrame(handle, first.id)!.stale).toBe(false);

    // freeze a snapshot against v1
    const snapId = freezeSnapshot(handle, first.id, '冻结调查', 'before revision');

    // revise: v1 interval ends at 500, v2 starts at 500. Existing frames (t=100..105)
    // remain under v1 -> interval change far away must NOT make them stale.
    handle.db.prepare('UPDATE dbc_versions SET valid_to = 500 WHERE version_number = 1').run();
    storeDbc(handle, v2, { versionNumber: 2, label: 'b', validFrom: 500, validTo: null, sourceName: 'b.dbc' });
    interpretAllFrames(handle);
    expect(interpretFrame(handle, first.id)!.stale).toBe(false);

    // now move v2's boundary over the existing frames: decodes become stale
    handle.db.prepare('UPDATE dbc_versions SET valid_from = 102, valid_to = NULL WHERE version_number = 2').run();
    handle.db.prepare('UPDATE dbc_versions SET valid_to = 102 WHERE version_number = 1').run();
    const f102 = handle.db.prepare('SELECT id FROM frames WHERE hw_time = 102').get() as { id: number };
    expect(interpretFrame(handle, f102.id)!.decoded!.dbcVersionNumber).toBe(2);
    // frame at 100/101 still v1; checking the forced v1 view of f102 marks stale
    expect(interpretFrame(handle, f102.id, versionIdOf(1))!.stale).toBe(true);

    // snapshot still points at v1 definition and old values
    const snap = readSnapshot(handle, snapId)!;
    expect(snap.dbcVersionId).toBe(versionIdOf(1));
    expect((snap.definition as { name: string }).name).toBe('M');
    expect((snap.decode as { signals: { value: number }[] }).signals[0].value).toBe(100);
  });

  function versionIdOf(versionNumber: number): number {
    return Number((handle.db.prepare('SELECT id FROM dbc_versions WHERE version_number = ?').get(versionNumber) as { id: number }).id);
  }
});

describe('import order independence', () => {
  it('produces identical counter results for reversed import order', () => {
    storeDbc(handle, v1, { versionNumber: 1, label: 'a', validFrom: 0, validTo: null, sourceName: 'a.dbc' });
    upsertCounterConfig(handle, {
      messageKey: '100:0', arbitrationId: 100, isExtended: false, node: 'ECU',
      signalName: 'Counter', modulus: 256, increment: 1,
    });
    const frames = parseTrace(trace()).frames;
    storeTrace(handle, 'a.csv', frames.slice(0, 3));
    storeTrace(handle, 'b.csv', frames.slice(3));
    interpretAllFrames(handle);
    const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'frameId' ? undefined : v)));
    const a = JSON.stringify(strip(runCounterChecks(handle)));

    handle.close();
    rmSync(dbPath, { force: true });
    handle = openDatabase(dbPath);
    storeDbc(handle, v1, { versionNumber: 1, label: 'a', validFrom: 0, validTo: null, sourceName: 'a.dbc' });
    upsertCounterConfig(handle, {
      messageKey: '100:0', arbitrationId: 100, isExtended: false, node: 'ECU',
      signalName: 'Counter', modulus: 256, increment: 1,
    });
    storeTrace(handle, 'b.csv', frames.slice(3).reverse());
    storeTrace(handle, 'a.csv', frames.slice(0, 3).reverse());
    interpretAllFrames(handle);
    const b = JSON.stringify(strip(runCounterChecks(handle)));
    expect(a).toBe(b);
  });
});

describe('migration approval concurrency', () => {
  it('compares layouts and rejects stale version approvals', () => {
    storeDbc(handle, v1, { versionNumber: 1, label: 'a', validFrom: 0, validTo: null, sourceName: 'a.dbc' });
    storeDbc(handle, v2Moved, { versionNumber: 2, label: 'b', validFrom: 0, validTo: null, sourceName: 'b.dbc' });
    const comparison = compareVersions(handle, 1, 2);
    const speed = comparison[0].signals.find((s) => s.signal === 'Speed')!;
    expect(speed.status).toBe('compatible');

    putMigrationMap(handle, {
      fromVersion: 1, toVersion: 2, messageKey: '100:0',
      payload: { hint: 'relocate 0->16' }, status: 'compatible',
    });
    // approve at current version 1 -> success (becomes version 2)
    const ok = approveMigrationMap(handle, 1, 2, '100:0', 'alice', 1);
    expect(ok).toMatchObject({ ok: true, version: 2 });
    // concurrent approver still holds version 1 -> conflict
    const stale2 = approveMigrationMap(handle, 1, 2, '100:0', 'bob', 1);
    expect(stale2).toMatchObject({ ok: false, conflict: true });
    expect(listMigrationMaps(handle, 1, 2)[0].approvedBy).toBe('alice');
  });

  it('refuses approval of an incompatible map', () => {
    storeDbc(handle, v1, { versionNumber: 1, label: 'a', validFrom: 0, validTo: null, sourceName: 'a.dbc' });
    storeDbc(handle, v2, { versionNumber: 2, label: 'b', validFrom: 0, validTo: null, sourceName: 'b.dbc' });
    putMigrationMap(handle, { fromVersion: 1, toVersion: 2, messageKey: '100:0', payload: null, status: 'incompatible' });
    const r = approveMigrationMap(handle, 1, 2, '100:0', 'alice', 1);
    expect(r.ok).toBe(false);
  });
});

describe('crc incomplete config is unchecked', () => {
  it('never reports pass without init/xor/coverage', () => {
    storeDbc(handle, v1, { versionNumber: 1, label: 'a', validFrom: 0, validTo: null, sourceName: 'a.dbc' });
    storeTrace(handle, 't.csv', parseTrace(trace()).frames);
    interpretAllFrames(handle);
    handle.db
      .prepare(`INSERT INTO crc_configs (message_key, arbitration_id, is_extended, crc_positions) VALUES ('100:0', 100, 0, '[7]')`)
      .run();
    const reports = runCrcChecks(handle) as { complete: boolean; results: { verdict: string }[] }[];
    expect(reports[0].complete).toBe(false);
    expect(reports[0].results.every((r) => r.verdict === 'unchecked')).toBe(true);
  });
});
