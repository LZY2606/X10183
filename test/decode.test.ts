import { describe, expect, it } from "vitest";
import { bitRanges, decodeWithMessage, extractRaw, toSigned } from "../src/core/decode";
import { parseDbc } from "../src/core/dbc/parse";
import { DBC_V1, frame } from "./helpers";
import type { MessageDef, RawFrame } from "../src/core/types";

const parsed = parseDbc(DBC_V1);
const engine = parsed.messages.find((m) => m.name === "ENGINE_STATUS")!;
const batt = parsed.messages.find((m) => m.name === "BATT_EXT")!;

function decode(msg: MessageDef, f: RawFrame) {
  return decodeWithMessage(f, msg, 1, "v1");
}

describe("bitSpan / 字节序", () => {
  it("Intel: start bit 即 LSB，区间线性递增", () => {
    expect(bitRanges(0, 16, "intel")).toEqual([{ first: 0, last: 15 }]);
    expect(bitRanges(16, 8, "intel")).toEqual([{ first: 16, last: 23 }]);
  });

  it("Motorola: 对齐信号单段，跨字节 sawtooth 信号两段", () => {
    expect(bitRanges(7, 16, "motorola")).toEqual([{ first: 0, last: 15 }]);
    // DBC sawtooth（跨字节环绕）：start22 len12 经过 linear22..16，跳到31，再30..26
    expect(bitRanges(22, 12, "motorola")).toEqual([
      { first: 16, last: 22 },
      { first: 27, last: 31 },
    ]);
    // start23 len16 恰好连续覆盖 linear16..31
    expect(bitRanges(23, 16, "motorola")).toEqual([{ first: 16, last: 31 }]);
    expect(bitRanges(15, 8, "motorola")).toEqual([{ first: 8, last: 15 }]);
  });
});

describe("Intel 排列解码", () => {
  it("16 位 Intel 无符号拼值 + 缩放偏置", () => {
    // d0=0x20 d1=0x03 -> raw 800, phys 800*0.25-100 = 100
    const f = frame(0.1, 0x100, "std", [0x20, 0x03, 0, 0, 0, 0, 0, 0]);
    const d = decode(engine, f);
    const speed = d.signals.find((s) => s.name === "EngineSpeed")!;
    expect(speed.raw).toBe(800);
    expect(speed.physical).toBeCloseTo(100, 6);
    expect(speed.bits).toEqual([{ first: 0, last: 15 }]);
    expect(speed.order).toBe("intel");
  });

  it("跨字节有符号 Intel：raw 0xFFFFFF 风格的负温度", () => {
    // EngineTemp len8 signed：raw 255 -> -1，phys -41
    const f = frame(0.1, 0x100, "std", [0, 0, 0xff, 0, 0, 0, 0, 0]);
    const d = decode(engine, f);
    const temp = d.signals.find((s) => s.name === "EngineTemp")!;
    expect(temp.signed).toBe(true);
    expect(temp.raw).toBe(-1);
    expect(temp.physical).toBe(-41);
  });

  it("16 位 Intel 负值（跨字节补码）", () => {
    // raw 0xF000 = -4096 signed16
    const f = frame(0.1, 0x100, "std", [0x00, 0xf0, 0, 0, 0, 0, 0, 0]);
    const d = decode(engine, f);
    const speed = d.signals.find((s) => s.name === "EngineSpeed")!;
    expect(speed.raw).toBe(-4096);
    expect(speed.physical).toBeCloseTo(-1124, 6);
  });
});

describe("Motorola 排列解码", () => {
  it("跨字节大端电压：字节序与 Intel 相同覆盖位但读取方向相反", () => {
    // d0=0x0F d1=0xA0 -> 4000
    const f = frame(1, 0x18f001, "ext", [0x0f, 0xa0, 0, 0, 0, 0, 0, 0]);
    const d = decode(batt, f);
    const v = d.signals.find((s) => s.name === "PackVoltage")!;
    expect(v.order).toBe("motorola");
    expect(v.bits).toEqual([{ first: 0, last: 15 }]);
    expect(v.raw).toBe(4000);
    expect(v.physical).toBeCloseTo(40.0, 6);
  });

  it("跨字节有符号 Motorola 负电流 -12.5A（DBC sawtooth 位序）", () => {
    // start23 len16 的 MSB..LSB 位于线性 23..16,31..24；高字节 0xFF 在这些位、低字节 0x83
    const f = frame(1, 0x18f001, "ext", [0, 0, 0xff, 0x83, 0, 0, 0, 0]);
    const d = decode(batt, f);
    const c = d.signals.find((s) => s.name === "PackCurrent")!;
    expect(c.raw).toBe(-125);
    expect(c.physical).toBeCloseTo(-12.5, 6);
    expect(c.bits).toEqual([
      { first: 16, last: 31 },
    ])
  });

  it("Motorola 与 Intel 在相同字节上得到不同 raw 值", () => {
    const data = [0x12, 0x34];
    const intel = extractRaw(data, 0, 16, "intel");
    const moto = extractRaw(data, 7, 16, "motorola");
    expect(intel).toBe(0x3412);
    expect(moto).toBe(0x1234);
  });
});

describe("有符号扩展边界", () => {
  it("toSigned 各宽度", () => {
    expect(toSigned(0xff, 8)).toBe(-1);
    expect(toSigned(0x7f, 8)).toBe(127);
    expect(toSigned(0x80, 8)).toBe(-128);
    expect(toSigned(0, 32)).toBe(0);
  });
});

describe("枚举与多路复用", () => {
  it("枚举文本解码", () => {
    const f = frame(0.1, 0x100, "std", [0, 0, 0, 0x01, 0, 0, 0, 0]);
    const d = decode(engine, f);
    const mode = d.signals.find((s) => s.name === "Mode")!;
    expect(mode.raw).toBe(1);
    expect(mode.enumText).toBe("Run");
  });

  it("已知 mux 分支：case 信号 active，其余 inactive", () => {
    // Mode = 0 -> Torque(m0) active
    const f = frame(0.1, 0x100, "std", [0, 0, 0, 0x00, 0xf4, 0x01, 0, 0]);
    const d = decode(engine, f);
    const torque = d.signals.find((s) => s.name === "Torque")!;
    expect(torque.status).toBe("active");
    expect(torque.raw).toBe(500);
    expect(d.muxBranches).toEqual([{ switch: "Mode", value: 0, known: true }]);
  });

  it("未知 mux 分支：保留 raw bits 并标记 unknown", () => {
    const f = frame(0.1, 0x100, "std", [0, 0, 0, 0x09, 0xf4, 0x01, 0, 0]);
    const d = decode(engine, f);
    expect(d.muxBranches[0]).toEqual({ switch: "Mode", value: 9, known: false });
    const torque = d.signals.find((s) => s.name === "Torque")!;
    expect(torque.status).toBe("unknown");
    expect(torque.raw).toBe(500);
    expect(torque.reason).toContain("未知");
  });
});
