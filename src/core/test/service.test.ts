import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshInMemoryDb, resetDbInstance } from "../../server/db.js";
import {
  allFrameViews,
  approveMapping,
  compareVersions,
  counterAnalysis,
  crcAnalysis,
  createSnapshot,
  decodeWithVersion,
  importDbc,
  importTrace,
  listSnapshots,
  proposeMappings
} from "../../server/service.js";
import { DBC_V1, DBC_V2, seedDatabase } from "../../server/seed.js";
import { OptimisticLockError } from "../../server/service.js";
import type { DatabaseSync } from "node:sqlite";

let db: DatabaseSync;

beforeEach(() => {
  resetDbInstance();
  db = freshInMemoryDb();
});

afterEach(() => {
  db.close();
});

describe("标准/扩展帧分类", () => {
  it("同一 arb id 的标准帧与扩展帧不共用定义", () => {
    seedDatabase(db);
    // 0x18FEF100 扩展帧命中 ExtDiag；标准帧无法用该 id（>0x7ff），
    // 这里直接验证 findMessage 逻辑通过时间轴解码结果。
    const decoded = decodeWithVersion(db, null);
    const ext = decoded.find((d) => d.view.frame.extended);
    expect(ext?.message?.name).toBe("ExtDiag");
    // 标准 0x7FF 无定义
    const std7ff = decoded.find((d) => !d.view.frame.extended && d.view.frame.arbitrationId === 0x7ff);
    expect(std7ff?.message).toBeNull();
  });

  it("0x100 在两个采集代次都命中 EngineData（各自时间点的生效版本）", () => {
    seedDatabase(db);
    const decoded = decodeWithVersion(db, null);
    const engines = decoded.filter((d) => d.view.frame.arbitrationId === 0x100);
    expect(engines.length).toBeGreaterThan(10);
    const versions = new Set(engines.map((e) => e.version?.versionNumber));
    expect(versions).toEqual(new Set([1, 2]));
  });
});

describe("过期解码", () => {
  it("强制用旧版本看新帧 → stale；自动选择不 stale", () => {
    seedDatabase(db);
    const auto = decodeWithVersion(db, null);
    expect(auto.every((d) => !d.stale)).toBe(true);
    const forcedV1 = decodeWithVersion(db, 1);
    const newGenFrame = forcedV1.find((d) => d.view.generation === "gen-b");
    expect(newGenFrame?.stale).toBe(true);
    expect(newGenFrame?.staleReason).toContain("生效区间");
    const oldGenFrame = forcedV1.find((d) => d.view.generation === "gen-a");
    expect(oldGenFrame?.stale).toBe(false);
  });
});

describe("快照冻结", () => {
  it("快照创建后再修订 DBC，快照仍指向旧定义", () => {
    seedDatabase(db);
    const snap = createSnapshot(db, "复盘", 1);
    const before = JSON.parse(snap.payloadJson) as Array<{ versionId: number; messageName: string | null }>;
    expect(before.length).toBeGreaterThan(0);
    // 修订：新增 v3，把 v1 生效区间提前结束（通过再导入相同 versionNumber 会冲突，改用更新 SQL）
    db.prepare("UPDATE dbc_version SET effective_to_ns = ? WHERE id = 1").run(
      BigInt(Date.parse("2024-02-01T00:00:00Z")) * 1_000_000n
    );
    const after = listSnapshots(db).find((s) => s.id === snap.id)!;
    const frozen = JSON.parse(after.payloadJson) as Array<{ versionId: number }>;
    expect(frozen.every((p) => p.versionId === 1)).toBe(true);
  });
});

describe("迁移映射与乐观锁", () => {
  it("对比 v1/v2 检测 EngineSpeed 起始位变化（破坏性），并可标记不兼容", () => {
    seedDatabase(db);
    const cmps = compareVersions(db, 1, 2);
    const engine = cmps.find((c) => c.fromMessageName === "EngineData")!;
    const speed = engine.changes.find((c) => c.fromSignal === "EngineSpeed")!;
    expect(speed.kind).toBe("modified");
    expect(speed.fields).toContain("起始位");
    expect(engine.compatible).toBe(false);
    const mappings = proposeMappings(db, 1, 2);
    const engineMap = mappings.find((m) => m.fromMessageName === "EngineData")!;
    expect(engineMap.status).toBe("proposed");
    // 批准含 removed 的映射应失败，只能标 incompatible
    await expect(Promise.resolve(approveMapping(db, engineMap.id, 1, "approved", null))).rejects.toThrow();
    const marked = approveMapping(db, engineMap.id, 1, "incompatible", "布局重排");
    expect(marked.status).toBe("incompatible");
    expect(marked.lockVersion).toBe(2);
  });

  it("并发审批：版本号不一致抛冲突；一致时成功且版本号递增", () => {
    seedDatabase(db);
    const mappings = proposeMappings(db, 1, 2);
    const target = mappings.find((m) => m.fromMessageName === "BodyMux")!;
    expect(() => approveMapping(db, target.id, 999, "approved", null)).toThrow(OptimisticLockError);
    const ok = approveMapping(db, target.id, 1, "approved", null);
    expect(ok.lockVersion).toBe(2);
    // 再次用旧锁号冲突
    expect(() => approveMapping(db, target.id, 1, "incompatible", null)).toThrow(OptimisticLockError);
  });
});

describe("端到端分析", () => {
  it("种子数据：计数器能检出 gen-a 的缺帧/环绕/重复时间戳；gen-b 的重复计数", () => {
    seedDatabase(db);
    const reports = counterAnalysis(db);
    const genA = reports.find((r) => r.generation === "gen-a");
    const genB = reports.find((r) => r.generation === "gen-b");
    expect(genA?.events.some((e) => e.type === "gap")).toBe(true);
    expect(genA?.events.some((e) => e.type === "wrap")).toBe(true);
    expect(genA?.events.some((e) => e.type === "duplicate-timestamp")).toBe(true);
    expect(genB?.events.some((e) => e.type === "duplicate")).toBe(true);
  });

  it("CRC：完整规则对种子帧通过；扩展帧规则不完整 → 全部未核验", () => {
    seedDatabase(db);
    const evidence = crcAnalysis(db);
    const std = evidence.filter((e) => !e.rule.extended);
    expect(std.length).toBeGreaterThan(0);
    expect(std.every((e) => e.verdict === "pass")).toBe(true);
    const ext = evidence.filter((e) => e.rule.extended);
    expect(ext.length).toBeGreaterThan(0);
    expect(ext.every((e) => e.verdict === "unchecked")).toBe(true);
  });

  it("导入顺序不变性：同一批帧拆成两个导入、交换顺序，解码/计数结论一致", () => {
    const traceA = `(1709251200.000000000) can0  100#0000A01F00000000
(1709251201.000000000) can0  100#1000A01F00000000
(1709251202.000000000) can0  100#2000A01F00000000`;
    const traceB = `(1709251203.000000000) can0  100#3000A01F00000000
(1709251204.000000000) can0  100#5000A01F00000000`;

    function run(first: string, second: string): string {
      importDbc(db, DBC_V1, {});
      db.prepare(
        `INSERT INTO counter_rule(channel, arbitration_id, extended, signal_name, bits, factor, increment, node_name)
         VALUES (NULL, 256, 0, 'Counter', 4, 1, 1, 'EMS')`
      ).run();
      importTrace(db, first, { label: "first", generation: "g" });
      importTrace(db, second, { label: "second", generation: "g" });
      const decoded = decodeWithVersion(db, null).map((d) => ({
        id: d.view.frame.arbitrationId,
        t: d.view.frame.hwTimeNs,
        data: d.view.frame.data.toString("hex"),
        msg: d.message?.name,
        rpm: d.decode.signals.find((s) => s.signalName === "EngineSpeed")?.value,
        counter: d.decode.signals.find((s) => s.signalName === "Counter")?.rawValue
      }));
      const reports = counterAnalysis(db);
      return JSON.stringify({ decoded, events: reports.flatMap((r) => r.events.map((e) => e.type)) });
    }

    const r1 = run(traceA, traceB);
    db.close();
    db = freshInMemoryDb();
    const r2 = run(traceB, traceA);
    expect(r1).toBe(r2);
  });

  it("allFrameViews 确定性排序", () => {
    seedDatabase(db);
    const views1 = allFrameViews(db).map((v) => v.frame.id);
    const views2 = allFrameViews(db).map((v) => v.frame.id);
    expect(views1).toEqual(views2);
  });
});
