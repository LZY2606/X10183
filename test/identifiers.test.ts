import { describe, expect, it } from "vitest";
import { replay } from "../src/core/replay";
import { getMessages, importDbcVersion, insertFrames } from "../src/server/repo";
import { newTestDb } from "../src/server/db";
import { frame, setupDb } from "./helpers";

describe("标准帧与扩展帧不混类", () => {
  it("同一数字 id 的 std 与 ext 分别匹配各自定义", () => {
    const db = newTestDb();
    importDbcVersion(db, {
      name: "both",
      sourceText: `BO_ 100 STD_MSG: 2 ECU
 SG_ StdVal : 0|8@0+ (1,0) [""]
BO_ 2147483748 EXT_MSG: 2 BMS
 SG_ ExtVal : 0|8@0+ (1,0) [""]
`,
      effectiveFrom: 0,
      effectiveTo: null,
    });
    insertFrames(db, [
      frame(0.1, 100, "std", [7, 0]),
      frame(0.2, 100, "ext", [9, 0]),
    ]);
    const decoded = replay(db);
    expect(decoded[0].messageName).toBe("STD_MSG");
    expect(decoded[1].messageName).toBe("EXT_MSG");
  });

  it("标准帧不会误命中扩展定义，反之亦然", () => {
    const db = newTestDb();
    importDbcVersion(db, {
      name: "only-ext",
      sourceText: `BO_ 2147483748 EXT_MSG: 2 BMS
 SG_ ExtVal : 0|8@0+ (1,0) [""]
`,
      effectiveFrom: 0,
      effectiveTo: null,
    });
    insertFrames(db, [frame(0.1, 100, "std", [9, 0])]);
    const decoded = replay(db);
    expect(decoded[0].messageName).toBeNull();
    expect(decoded[0].error).toContain("标准");
  });

  it("同 arbitration id 不同版本换布局：按时间选中不同定义", () => {
    const db = setupDb();
    insertFrames(db, [
      frame(5, 0x100, "std", [0x20, 0x03, 0x41, 0, 0, 0, 1, 0]), // v1 Intel
      frame(15, 0x100, "std", [0x03, 0x20, 0x41, 0, 0, 0, 1, 0]), // v2 Motorola
    ]);
    const decoded = replay(db);
    expect(decoded[0].dbcVersionName).toBe("v1");
    expect(decoded[1].dbcVersionName).toBe("v2");
    // v1 Intel 读 raw 800
    expect(decoded[0].signals.find((s) => s.name === "EngineSpeed")!.raw).toBe(800);
    // v2 Motorola start7 len16 大端 0x0320 = 800
    expect(decoded[1].signals.find((s) => s.name === "EngineSpeed")!.raw).toBe(800);
  });

  it("导入重叠生效区间（同 arb id）被拒绝", () => {
    const db = newTestDb();
    importDbcVersion(db, {
      name: "a",
      sourceText: `BO_ 100 M: 1 N
 SG_ X : 0|8@0+ (1,0) [""]
`,
      effectiveFrom: 0,
      effectiveTo: null,
    });
    expect(() =>
      importDbcVersion(db, {
        name: "b",
        sourceText: `BO_ 100 M: 1 N
 SG_ X : 0|8@0+ (1,0) [""]
`,
        effectiveFrom: 5,
        effectiveTo: 20,
      }),
    ).toThrow(/重叠/);
  });

  it("不同 arb id 的重叠区间允许共存", () => {
    const db = newTestDb();
    importDbcVersion(db, {
      name: "a",
      sourceText: `BO_ 100 M: 1 N
 SG_ X : 0|8@0+ (1,0) [""]
`,
      effectiveFrom: 0,
      effectiveTo: null,
    });
    expect(() =>
      importDbcVersion(db, {
        name: "b",
        sourceText: `BO_ 200 M: 1 N
 SG_ X : 0|8@0+ (1,0) [""]
`,
        effectiveFrom: 0,
        effectiveTo: null,
      }),
    ).not.toThrow();
    expect(getMessages(db, 2)).toHaveLength(1);
  });
});
