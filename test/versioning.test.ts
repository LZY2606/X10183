import { describe, expect, it } from 'vitest';
import { updateEffectiveInterval } from '../server/dbcService.js';
import { decodeFrame, recomputeAll, staleCount } from '../server/decode.js';
import { compareVersions, createMigration, createSnapshot, decideMigration, getSnapshot } from '../server/compare.js';
import { frame, importGen, memDb, setupVersions } from './helpers.js';
import { listFramesOrdered } from '../server/repo.js';

describe('DBC 生效区间修订 → 过期解码', () => {
  it('仅受影响时间窗内的解码变过期，其余保持新鲜', () => {
    const db = memDb();
    const { v1 } = setupVersions(db);
    importGen(db, 'g1', [
      frame(1, 256, [0x20, 0x03, 0x64, 0, 0, 0, 0, 0]),
      frame(5, 256, [0x20, 0x03, 0x64, 0, 0, 0, 0, 0]),
      frame(12, 256, [0x20, 0x03, 0x64, 0, 0, 0, 0, 0])
    ]);
    const [f1, f5, f12] = listFramesOrdered(db);
    decodeFrame(db, f1.id);
    decodeFrame(db, f5.id);
    decodeFrame(db, f12.id);
    expect(staleCount(db)).toBe(0);

    // v1 收缩为 [null,4)：t=5 的帧不再属于 v1 → 过期；t=1 与 t=12 不受影响
    updateEffectiveInterval(db, v1, { effectiveFrom: null, effectiveTo: 4, expectedVersion: 1 });
    expect(staleCount(db)).toBe(1);
    const refreshed = decodeFrame(db, f5.id);
    expect(refreshed.dbcId).toBeNull();
    expect(refreshed.undecodedReason).toBe('no-effective-dbc');
    expect(staleCount(db)).toBe(0);

    // 错误版本号必须冲突
    expect(() =>
      updateEffectiveInterval(db, v1, { effectiveFrom: null, effectiveTo: 3, expectedVersion: 1 })
    ).toThrow(/版本冲突/);
  });
});

describe('快照冻结旧定义', () => {
  it('修订 DBC 后快照内容保持旧标签与旧解码', () => {
    const db = memDb();
    const { v1 } = setupVersions(db);
    importGen(db, 'g1', [frame(1, 256, [0x20, 0x03, 0x64, 0, 0, 0, 0, 0])]);
    const snap = createSnapshot(db, { title: '冻结点' });
    const before = getSnapshot(db, snap.id)!.payload as { dbcLabel: string | null; signals: { name: string }[] }[];
    expect(before[0].dbcLabel).toBe('v1');
    expect(before[0].signals.some((s) => s.name === 'EngineSpeed')).toBe(true);

    updateEffectiveInterval(db, v1, { effectiveFrom: null, effectiveTo: 0.5, expectedVersion: 1 });
    recomputeAll(db);
    const after = getSnapshot(db, snap.id)!.payload as { dbcLabel: string | null; signals: { name: string }[] }[];
    expect(after[0].dbcLabel).toBe('v1');
    expect(after[0].signals.some((s) => s.name === 'EngineSpeed')).toBe(true);
  });
});

describe('版本比较与迁移审批并发', () => {
  it('报告同 ID 换布局；审批基于版本号冲突', () => {
    const db = memDb();
    const { v1, v2 } = setupVersions(db);
    importGen(db, 'g1', [frame(1, 256, [0x20, 0x03, 0x64, 0, 0, 0, 0, 0])]);

    const cmp = compareVersions(db, v1, v2);
    const msg = cmp.messages.find((m) => m.arbId === 256)!;
    expect(msg.status).toBe('changed');
    const sigNames = msg.signals.map((s) => s.name);
    expect(sigNames).toContain('EngineSpeed');
    expect(sigNames).toContain('VehicleSpeed');
    expect(msg.signals.find((s) => s.name === 'EngineSpeed')!.status).toBe('removed');

    const mig = createMigration(db, v1, v2);
    const approved = decideMigration(db, mig.id, { status: 'approved', expectedVersion: 1 });
    expect(approved.version).toBe(2);
    expect(approved.status).toBe('approved');
    // 第二个审批者仍基于版本 1 → 冲突
    expect(() => decideMigration(db, mig.id, { status: 'approved', expectedVersion: 1 })).toThrow(/版本冲突/);
    // 已终结不可重复决定（即便带新版本号）
    expect(() => decideMigration(db, mig.id, { status: 'incompatible', expectedVersion: 2 })).toThrow(/已结束/);

    const mig2 = createMigration(db, v2, v1);
    const incompatible = decideMigration(db, mig2.id, { status: 'incompatible', expectedVersion: 1 });
    expect(incompatible.status).toBe('incompatible');
  });
});
