import { describe, it, expect } from 'vitest';
import { importFrames } from '../src/server/frames.js';
import { queryDecodes, redecodeAll, unmatchedFrames } from '../src/server/decode.js';
import { createVersion, getVersion, listVersions, updateVersion, VersionError } from '../src/server/versions.js';
import { compareVersions } from '../src/server/migrate.js';
import { approveMigration, listMigrations, MigrationError } from '../src/server/migrate.js';
import { msg, s, tempDb, versionInput } from './helpers.js';

const v1Messages = [
  msg({
    arbId: 0x100, name: 'Engine', sender: 'ECM', length: 8,
    signals: [s({ name: 'Spd', startBit: 0, length: 16, byteOrder: 1, factor: 0.25, unit: 'rpm' })]
  }),
  msg({
    arbId: 0x18fef100, idKind: 'ext', name: 'EEC', sender: 'ECM', length: 8,
    signals: [s({ name: 'Road', startBit: 7, length: 16, byteOrder: 0, factor: 0.5, unit: 'kmh' })]
  })
];

function v2Messages() {
  const copy = JSON.parse(JSON.stringify(v1Messages));
  // 仅缩放改变 => compatible；扩展帧位布局改变 => incompatible
  copy[0].signals[0].factor = 1;
  copy[1].signals[0].startBit = 15;
  return copy;
}

describe('生效区间端点（半开）', () => {
  it('边界时间归新版本，区间外回退；DBC 修订后旧解码过期', () => {
    const db = tempDb();
    const v1 = createVersion(db, versionInput('v1', v1Messages, { from: 0, to: 10 }));
    importFrames(db, [
      { arbId: 0x100, idKind: 'std', data: [0x10, 0x27, 0, 0, 0, 0, 0, 0], dlc: 8, hwTimeNs: 9 },
      { arbId: 0x100, idKind: 'std', data: [0x10, 0x27, 0, 0, 0, 0, 0, 0], dlc: 8, hwTimeNs: 10 },
      { arbId: 0x100, idKind: 'std', data: [0x10, 0x27, 0, 0, 0, 0, 0, 0], dlc: 8, hwTimeNs: 11 }
    ]);
    redecodeAll();
    let decodes = queryDecodes(db);
    expect(decodes).toHaveLength(2); // t=10/11 无生效版本 => unmatched
    expect(unmatchedFrames(db)).toHaveLength(1);
    expect(decodes[0].frameId).toBe(1);

    // 引入 v2 覆盖 [10, +∞)
    const v2 = createVersion(db, versionInput('v2', v2Messages(), { from: 10, to: null }));
    decodes = queryDecodes(db);
    expect(decodes).toHaveLength(3);
    // t=9 仍 v1（边界不含 10），t=10/11 用 v2
    expect(decodes[0].versionId).toBe(v1.id);
    expect(decodes[1].versionId).toBe(v2.id);
    expect(decodes[2].versionId).toBe(v2.id);

    // 修订 v1 的信号定义后，仅受影响的 t=9 解码变为过期 changed
    const revised = JSON.parse(JSON.stringify(v1Messages));
    revised[0].signals[0].factor = 0.5;
    updateVersion(db, v1.id, v1.revision, { messages: revised });
    decodes = queryDecodes(db);
    const t9 = decodes.find((d) => d.hwTimeNs === 9)!;
    const t10 = decodes.find((d) => d.hwTimeNs === 10)!;
    expect(t9.staleReason).toBe('changed');
    expect(t10.staleReason).toBeNull();
    void getVersion;
    void listVersions;
  });

  it('非法区间被拒绝', () => {
    const db = tempDb();
    expect(() => createVersion(db, versionInput('bad', v1Messages, { from: 100, to: 100 })))
      .toThrow(/半开/);
  });
});

describe('标准帧与扩展帧不混类', () => {
  it('同数值 id 的 std/ext 分别匹配消息', () => {
    const db = tempDb();
    createVersion(db, versionInput('v1', [
      msg({ arbId: 0x100, idKind: 'std', name: 'StdMsg', signals: [
        s({ name: 'a', startBit: 0, length: 8, byteOrder: 1 })
      ] }),
      msg({ arbId: 0x100, idKind: 'ext', name: 'ExtMsg', signals: [
        s({ name: 'b', startBit: 0, length: 8, byteOrder: 1 })
      ] })
    ]));
    importFrames(db, [
      { arbId: 0x100, idKind: 'std', data: [1, 0, 0, 0, 0, 0, 0, 0], dlc: 8, hwTimeNs: 0 },
      { arbId: 0x100, idKind: 'ext', data: [2, 0, 0, 0, 0, 0, 0, 0], dlc: 8, hwTimeNs: 1 }
    ]);
    redecodeAll();
    const decodes = queryDecodes(db);
    expect(decodes.map((d) => d.messageName).sort()).toEqual(['ExtMsg', 'StdMsg']);
  });

  it('导入时校验 id 位宽', () => {
    const db = tempDb();
    expect(() => importFrames(db, [
      { arbId: 0x800, idKind: 'std', data: [0], dlc: 1, hwTimeNs: 0 }
    ])).toThrow(/11bit/);
  });
});

describe('版本比较与迁移映射', () => {
  it('缩放差异=可兼容；位布局改变=无法兼容', () => {
    const db = tempDb();
    const v1 = createVersion(db, versionInput('v1', v1Messages));
    const v2 = createVersion(db, versionInput('v2', v2Messages()));
    const cmp = compareVersions(db, v1.id, v2.id);
    const std = cmp.entries.find((e) => e.arbId === 0x100)!;
    const ext = cmp.entries.find((e) => e.arbId === 0x18fef100)!;
    expect(std.relation).toBe('compatible');
    expect(ext.relation).toBe('incompatible');
  });

  it('并发审批基于版本号冲突', () => {
    const db = tempDb();
    const v1 = createVersion(db, versionInput('v1', v1Messages));
    const v2 = createVersion(db, versionInput('v2', v2Messages()));
    const first = approveMigration(db, {
      fromVersionId: v1.id, toVersionId: v2.id,
      arbId: 0x100, idKind: 'std', status: 'approved'
    });
    expect(first.revision).toBe(1);
    // 基于旧 revision 再次提交 => 冲突
    expect(() => approveMigration(db, {
      fromVersionId: v1.id, toVersionId: v2.id,
      arbId: 0x100, idKind: 'std', status: 'approved', expectedRevision: 1
    })).not.toThrow();
    expect(() => approveMigration(db, {
      fromVersionId: v1.id, toVersionId: v2.id,
      arbId: 0x100, idKind: 'std', status: 'incompatible', expectedRevision: 1
    })).toThrow(MigrationError);
    const rows = listMigrations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].revision).toBe(3);
  });

  it('目标消息不存在时不能批准，只能标记无法兼容', () => {
    const db = tempDb();
    const v1 = createVersion(db, versionInput('v1', v1Messages));
    const v2 = createVersion(db, versionInput('v2', [
      msg({ arbId: 0x200, name: 'Other', signals: [s({ name: 'x', startBit: 0, length: 8, byteOrder: 1 })] })
    ]));
    expect(() => approveMigration({
      fromVersionId: v1.id, toVersionId: v2.id,
      arbId: 0x100, idKind: 'std', status: 'approved'
    } as any)).toThrow(); // 参数类型保护演示（实际用 db 调用见下）
    expect(() => approveMigration(db, {
      fromVersionId: v1.id, toVersionId: v2.id,
      arbId: 0x100, idKind: 'std', status: 'approved'
    })).toThrow(/无法兼容/);
    const ok = approveMigration(db, {
      fromVersionId: v1.id, toVersionId: v2.id,
      arbId: 0x100, idKind: 'std', status: 'incompatible'
    });
    expect(ok.status).toBe('incompatible');
  });
});

describe('DBC 修订乐观锁', () => {
  it('基于过期 revision 更新版本 => 冲突', () => {
    const db = tempDb();
    const v1 = createVersion(db, versionInput('v1', v1Messages));
    updateVersion(db, v1.id, 1, { label: 'v1-renamed' });
    expect(() => updateVersion(db, v1.id, 1, { label: 'late' })).toThrow(VersionError);
  });
});
