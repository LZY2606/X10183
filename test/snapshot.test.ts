import { describe, expect, it } from "vitest";
import { deleteDbcVersion, insertFrames, listVersions } from "../src/server/repo";
import { replay } from "../src/core/replay";
import { createSnapshot, listSnapshots, snapshotStaleness } from "../src/core/snapshot";
import { frame, setupDb } from "./helpers";

describe("冻结调查快照", () => {
  it("快照固化创建时的确切 DBC 版本", () => {
    const db = setupDb();
    insertFrames(db, [
      frame(5, 0x100, "std", [0, 0, 0, 0, 0, 0, 1, 0]),
      frame(15, 0x100, "std", [0, 0, 0, 0, 0, 0, 2, 0], "gen2"),
    ]);
    const before = replay(db);
    const snap = createSnapshot(db, "investigate-1");
    expect(snap.entries.map((e) => e.dbcVersionId)).toEqual(before.map((f) => f.dbcVersionId));
  });

  it("DBC 修订撤回后，受生效区间影响的解码变为过期；快照仍指向旧定义", () => {
    const db = setupDb();
    insertFrames(db, [frame(5, 0x100, "std", [0, 0, 0, 0, 0, 0, 1, 0])]);
    const snap = createSnapshot(db, "freeze-before-revision");
    const frozenVersion = snap.entries[0].dbcVersionId;

    // 当前全部有效
    expect(snapshotStaleness(db, snap)[0].expired).toBe(false);

    // 撤回覆盖该时间的 v1（模拟修订替换：旧解码过期）。
    deleteDbcVersion(db, frozenVersion);
    expect(listVersions(db).some((v) => v.id === frozenVersion)).toBe(false);

    const stale = snapshotStaleness(db, snap);
    expect(stale[0].expired).toBe(true);
    expect(stale[0].currentVersionId).toBeNull();
    // 快照内容本身不变：继续指向旧版本
    const stored = listSnapshots(db)[0];
    expect(stored.entries[0].dbcVersionId).toBe(frozenVersion);
  });
});
