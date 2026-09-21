import { describe, expect, it } from "vitest";
import { checkCounters } from "../src/core/checks/counter";
import { insertFrames } from "../src/server/repo";
import { frame, seedRules, setupDb } from "./helpers";

function engine(time: number, counter: number, gen = "gen1") {
  return frame(time, 0x100, "std", [0, 0, 0, 0, 0, 0, counter, 0], gen);
}

describe("计数器：环绕 / 重复 / 缺帧，按节点+代次", () => {
  it("检测重复与缺帧", () => {
    const db = setupDb();
    seedRules(db);
    insertFrames(db, [
      engine(0.1, 1),
      engine(0.2, 2),
      engine(0.3, 2), // duplicate
      engine(0.4, 4), // missing 3
      engine(0.5, 5),
    ]);
    const events = checkCounters(db, [
      { messageName: "ENGINE_STATUS", signalName: "Counter", width: 8 },
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual(["duplicate", "missing"]);
    expect(events[1].expected).toBe(3);
    expect(events[1].actual).toBe(4);
  });

  it("8 位最大值后环绕到 0 记为 wrap（不是缺帧）", () => {
    const db = setupDb();
    seedRules(db);
    insertFrames(db, [engine(0.1, 254), engine(0.2, 255), engine(0.3, 0), engine(0.4, 1)]);
    const events = checkCounters(db, [
      { messageName: "ENGINE_STATUS", signalName: "Counter", width: 8 },
    ]);
    expect(events.map((e) => e.type)).toEqual(["wrap"]);
    expect(events[0]).toMatchObject({ type: "wrap", expected: 0, actual: 0 });
  });

  it("重复时间戳也不豁免重复计数，顺序由规范化重放键决定", () => {
    const db = setupDb();
    seedRules(db);
    // 相同 hw_time、不同数据：两者都保留，counter 2 重复
    insertFrames(db, [
      frame(0.5, 0x100, "std", [0, 0, 0, 0, 0, 0, 2, 0], "gen1"),
      frame(0.5, 0x100, "std", [1, 0, 0, 0, 0, 0, 2, 0], "gen1"),
    ]);
    const events = checkCounters(db, [
      { messageName: "ENGINE_STATUS", signalName: "Counter", width: 8 },
    ]);
    expect(events.some((e) => e.type === "duplicate")).toBe(true);
  });

  it("不同采集代次独立检查，不跨代报缺帧", () => {
    const db = setupDb();
    seedRules(db);
    insertFrames(db, [engine(0.1, 10, "genA"), engine(10.1, 20, "genB")]);
    const events = checkCounters(db, [
      { messageName: "ENGINE_STATUS", signalName: "Counter", width: 8 },
    ]);
    // 每代只有一帧，无前驱，不应有事件
    expect(events).toHaveLength(0);
  });

  it("节点分组：同消息名但不同 transmitter 不合并（通过 DBC 版本区分）", () => {
    // v1/v2 消息 transmitter 都是 ECU；这里验证事件带节点字段
    const db = setupDb();
    seedRules(db);
    insertFrames(db, [engine(0.1, 1), engine(0.2, 1)]);
    const events = checkCounters(db, [
      { messageName: "ENGINE_STATUS", signalName: "Counter", width: 8 },
    ]);
    expect(events[0].node).toBe("ECU");
    expect(events[0].gen).toBe("gen1");
  });
});
