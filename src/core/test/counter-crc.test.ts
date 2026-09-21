import { describe, expect, it } from "vitest";
import { checkCounters, type CounterInput } from "../counter.js";
import { computeCrc8, missingFields, verifyCrc } from "../crc.js";
import { parseTrace, deterministicOrder } from "../trace.js";
import type { CounterRule, CrcRule, MessageDef, RawFrame } from "../types.js";
import { decodeFrame } from "../decode.js";

function makeFrame(id: number, ts: bigint, data: number[], seq: number, gen = "g1"): RawFrame & { gen: string } {
  return {
    id, importId: 1, channel: null, arbitrationId: 0x100, extended: false,
    hwTimeNs: ts.toString(), data: Buffer.from(data), seqInImport: seq, gen
  } as RawFrame & { gen: string };
}

const rule: CounterRule = {
  id: 1, channel: null, arbitrationId: 0x100, extended: false,
  signalName: "Counter", bits: 4, factor: 1, increment: 1, nodeName: "EMS"
};

function counterMessage(): MessageDef {
  return {
    id: 1, dbcVersionId: 1, name: "M", arbitrationId: 0x100, extended: false,
    channel: null, dlc: 8, transmitter: null,
    signals: [
      {
        id: 1, messageId: 1, name: "Counter", startBit: 34, length: 4, byteOrder: "intel",
        signed: false, scale: 1, offset: 0, minimum: 0, maximum: 15, unit: null,
        muxKind: "plain", muxValue: null, muxSwitchName: null, muxRanges: null, enums: null
      }
    ]
  };
}

function inputs(frames: Array<RawFrame & { gen?: string }>): CounterInput[] {
  const msg = counterMessage();
  return frames.map((f) => ({
    frame: f, message: msg, decode: decodeFrame(f, msg), generation: (f as { gen?: string }).gen ?? "g1"
  }));
}

describe("计数器", () => {
  it("正常递增通过", () => {
    const frames = [0, 1, 2, 3].map((c, i) => makeFrame(i + 1, BigInt(i * 10), [(c << 2) & 0xff, 0], i));
    const reports = checkCounters(inputs(frames), [rule]);
    expect(reports[0].verdict).toBe("pass");
    expect(reports[0].events).toHaveLength(0);
  });

  it("15->0 环绕（wrap 事件但不算失败）", () => {
    const frames: Array<RawFrame & { gen?: string }> = [
      makeFrame(1, 0n, [(15 << 2) & 0xff, 0], 0),
      makeFrame(2, 10n, [(0 << 2) & 0xff, 0], 1)
    ];
    const reports = checkCounters(inputs(frames), [rule]);
    expect(reports[0].events.map((e) => e.type)).toEqual(["wrap"]);
    expect(reports[0].verdict).toBe("pass");
  });

  it("重复计数判失败", () => {
    const frames = [
      makeFrame(1, 0n, [(5 << 2) & 0xff, 0], 0),
      makeFrame(2, 10n, [(5 << 2) & 0xff, 0], 1)
    ];
    const reports = checkCounters(inputs(frames), [rule]);
    expect(reports[0].events[0].type).toBe("duplicate");
    expect(reports[0].verdict).toBe("fail");
  });

  it("缺帧（跳 2）报 gap", () => {
    const frames = [
      makeFrame(1, 0n, [(3 << 2) & 0xff, 0], 0),
      makeFrame(2, 10n, [(5 << 2) & 0xff, 0], 1)
    ];
    const reports = checkCounters(inputs(frames), [rule]);
    expect(reports[0].events[0].type).toBe("gap");
  });

  it("重复时间戳单独标注", () => {
    const frames = [
      makeFrame(1, 100n, [(3 << 2) & 0xff, 0], 0),
      makeFrame(2, 100n, [(4 << 2) & 0xff, 0], 1)
    ];
    const reports = checkCounters(inputs(frames), [rule]);
    expect(reports[0].events.some((e) => e.type === "duplicate-timestamp")).toBe(true);
  });

  it("按节点+代次分组", () => {
    const a = [makeFrame(1, 0n, [(0 << 2) & 0xff, 0], 0, "gen-a")];
    const b = [makeFrame(2, 0n, [(0 << 2) & 0xff, 0], 0, "gen-b")];
    const reports = checkCounters(inputs([...a, ...b]), [rule]);
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.generation).sort()).toEqual(["gen-a", "gen-b"]);
  });
});

describe("CRC", () => {
  it("CRC-8/SAE? 基本自洽（poly 0x07 init 0 xor 0）", () => {
    const crc = computeCrc8(Buffer.from([0x31, 0x32, 0x33]), {
      polynomial: 0x07, init: 0, xorOut: 0, reflectInput: false, reflectOutput: false
    });
    expect(crc).toBe(0xc0);
  });

  it("配置不完整只能未核验，不能报通过", () => {
    const incomplete: CrcRule = {
      id: 1, channel: null, arbitrationId: 0x100, extended: false, signalName: "Crc",
      widthBits: 8, startByte: 0, lengthBytes: 7, polynomial: 7, init: null, xorOut: null,
      reflectInput: false, reflectOutput: false
    };
    expect(missingFields(incomplete)).toContain("初值");
    const msg = counterMessage();
    msg.signals[0].name = "Crc";
    msg.signals[0].startBit = 56;
    const f = makeFrame(1, 0n, [0, 0, 0, 0, 0, 0, 0, 0], 0) as unknown as RawFrame;
    const evidence = verifyCrc(f, incomplete, msg);
    expect(evidence.verdict).toBe("unchecked");
  });

  it("正确 CRC 报通过；篡改后报失败并给出覆盖字节", () => {
    const msg = counterMessage();
    msg.signals[0] = {
      ...msg.signals[0], name: "Crc", startBit: 56, length: 8
    };
    const payload = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
    const crc = computeCrc8(payload, { polynomial: 0x07, init: 0, xorOut: 0, reflectInput: false, reflectOutput: false });
    const full: CrcRule = {
      id: 1, channel: null, arbitrationId: 0x100, extended: false, signalName: "Crc",
      widthBits: 8, startByte: 0, lengthBytes: 7, polynomial: 0x07, init: 0, xorOut: 0,
      reflectInput: false, reflectOutput: false
    };
    const good = Buffer.concat([payload, Buffer.from([crc])]);
    const f1 = makeFrame(1, 0n, [...good], 0) as unknown as RawFrame;
    expect(verifyCrc(f1, full, msg).verdict).toBe("pass");
    const bad = Buffer.from(good);
    bad[0] ^= 0xff;
    const f2 = makeFrame(2, 10n, [...bad], 1) as unknown as RawFrame;
    const ev = verifyCrc(f2, full, msg);
    expect(ev.verdict).toBe("fail");
    expect(ev.coveredBytes).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("trace 导入与确定性", () => {
  it("解析标准帧、扩展帧与 candump 时间戳", () => {
    const text = `(1620000000.000000000) can0  100#AABB
(1620000001.500000000) can0  18FEF100##011223344`;
    const frames = parseTrace(text);
    expect(frames).toHaveLength(2);
    expect(frames[0].extended).toBe(false);
    expect(frames[0].arbitrationId).toBe(0x100);
    expect(frames[1].extended).toBe(true);
    expect(frames[1].arbitrationId).toBe(0x18fef100);
    expect(frames[1].data.toString("hex")).toBe("11223344");
  });

  it("CSV 格式 + ide 列", () => {
    const text = `time,channel,id,ide,data
2024-01-01T00:00:00Z,can0,100,0,AABB
2024-01-01T00:00:01Z,can0,18FEF100,1,1122`;
    const frames = parseTrace(text);
    expect(frames[0].extended).toBe(false);
    expect(frames[1].extended).toBe(true);
  });

  it("不同导入顺序合并后顺序一致", () => {
    const a = [
      makeFrame(1, 30n, [1], 0),
      makeFrame(2, 10n, [2], 1),
      makeFrame(3, 20n, [3], 2)
    ];
    const b = [...a].reverse();
    expect(deterministicOrder(a).map((f) => f.id)).toEqual([2, 3, 1]);
    expect(deterministicOrder(b).map((f) => f.id)).toEqual([2, 3, 1]);
  });
});
