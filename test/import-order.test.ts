import { describe, expect, it } from "vitest";
import { insertFrames } from "../src/server/repo";
import { replay } from "../src/core/replay";
import { frame, setupDb } from "./helpers";

describe("导入顺序无关性", () => {
  it("正序/乱序导入得到完全相同的重放解码", () => {
    const mk = () => {
      const db = setupDb();
      const frames = [
        frame(0.3, 0x100, "std", [0, 0, 0, 0, 0, 0, 4, 0]),
        frame(0.1, 0x100, "std", [0, 0, 0, 0, 0, 0, 1, 0]),
        frame(10.2, 0x100, "std", [0, 0, 0, 0, 0, 0, 2, 0], "gen2"),
        frame(0.2, 0x100, "std", [0, 0, 0, 0, 0, 0, 2, 0]),
        frame(1.0, 0x18f001, "ext", [0x0f, 0xa0, 0, 0, 0, 0, 0, 0]),
        frame(10.1, 0x100, "std", [0, 0, 0, 0, 0, 0, 1, 0], "gen2"),
      ];
      return { db, frames };
    };

    const a = mk();
    insertFrames(a.db, a.frames);
    const ra = replay(a.db).map((f) => ({
      t: f.hwTime,
      gen: f.gen,
      id: f.arbId,
      kind: f.kind,
      v: f.dbcVersionName,
      msg: f.messageName,
    }));

    const b = mk();
    insertFrames(b.db, [...b.frames].reverse());
    const rb = replay(b.db).map((f) => ({
      t: f.hwTime,
      gen: f.gen,
      id: f.arbId,
      kind: f.kind,
      v: f.dbcVersionName,
      msg: f.messageName,
    }));

    expect(rb).toEqual(ra);
    // 时间排序：gen1 全部先于 gen2（gen 是主键之一），同 gen 内按 hw_time
    expect(ra.map((x) => x.t)).toEqual([0.1, 0.2, 0.3, 1, 10.1, 10.2]);
  });

  it("重复导入幂等：相同帧不产生第二份", () => {
    const db = setupDb();
    const f = frame(0.1, 0x100, "std", [1, 2, 3, 0, 0, 0, 1, 0], "g1", "can0");
    const r1 = insertFrames(db, [f]);
    const r2 = insertFrames(db, [{ ...f, id: 0 }]);
    expect(r1.inserted).toBe(1);
    expect(r2.inserted).toBe(0);
    expect(replay(db)).toHaveLength(1);
  });
});
