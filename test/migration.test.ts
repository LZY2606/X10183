import { describe, expect, it } from "vitest";
import { newTestDb } from "../src/server/db";
import { importDbcVersion } from "../src/server/repo";
import {
  VersionConflictError,
  decideMigration,
  diffVersions,
  ensureMigrations,
} from "../src/core/migration";
import { setupDb } from "./helpers";

describe("DBC 版本对比与迁移映射", () => {
  it("EngineSpeed 位布局变化 -> incompatible；Torque/Counter/Crc -> identical", () => {
    const db = setupDb();
    const { diffs } = diffVersions(db, 1, 2);
    const eng = diffs.find((d) => d.messageName === "ENGINE_STATUS")!;
    expect(eng.status).toBe("incompatible");
    const speed = eng.mappings.find((m) => m.signalName === "EngineSpeed")!;
    expect(speed.classification).toBe("incompatible");
    const torque = eng.mappings.find((m) => m.signalName === "Torque")!;
    expect(torque.classification).toBe("identical");
  });

  it("仅缩放变化的信号分类为 adapted（位布局不变）", () => {
    const db = newTestDb();
    importDbcVersion(db, {
      name: "a",
      sourceText: `BO_ 1 S: 1 N
 SG_ V : 0|8@0+ (1,0) [""]
`,
      effectiveFrom: 0,
      effectiveTo: 10,
    });
    importDbcVersion(db, {
      name: "b",
      sourceText: `BO_ 1 S: 1 N
 SG_ V : 0|8@0+ (0.1,0) [""]
`,
      effectiveFrom: 10,
      effectiveTo: null,
    });
    const { diffs } = diffVersions(db, 1, 2);
    expect(diffs[0].mappings[0].classification).toBe("adapted");
  });

  it("并发审批基于版本号：第二个过期 lock 提交冲突", () => {
    const db = setupDb();
    const created = ensureMigrations(db, 1, 2);
    const eng = created.find((m) => m.messageName === "ENGINE_STATUS")!;
    const approved = decideMigration(db, eng.id, "approved", eng.lockVersion);
    expect(approved.status).toBe("approved");
    expect(approved.lockVersion).toBe(eng.lockVersion + 1);

    expect(() => decideMigration(db, eng.id, "rejected", eng.lockVersion)).toThrow(VersionConflictError);
    try {
      decideMigration(db, eng.id, "rejected", eng.lockVersion);
    } catch (e) {
      expect((e as VersionConflictError).current).toBe(approved.lockVersion);
    }
  });

  it("已审批记录不能被旧锁改写", () => {
    const db = setupDb();
    const created = ensureMigrations(db, 1, 2);
    const mig = created.find((m) => m.messageName === "ENGINE_STATUS")!;
    decideMigration(db, mig.id, "approved", 1);
    expect(() => decideMigration(db, mig.id, "approved", 1)).toThrow(VersionConflictError);
  });
});
