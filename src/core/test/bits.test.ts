import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { intelSpan, motorolaSpan, readRaw, spanFor } from "../bits.js";
import { parseDbc } from "../dbc.js";
import type { ByteOrder } from "../types.js";

// Intel 小端：起始位为 LSB。
describe("Intel 位序", () => {
  it("0|16 覆盖字节0、1，LSB 在前", () => {
    const span = intelSpan(0, 16);
    expect(span.cells[0]).toEqual({ byte: 0, bit: 0 });
    expect(span.cells[15]).toEqual({ byte: 1, bit: 7 });
  });

  it("跨字节有符号负数读取", () => {
    const data = Buffer.from([0x00, 0xf0, 0, 0, 0, 0, 0, 0]); // bit12..15=1111, len16 signed
    const raw = readRaw(data, intelSpan(0, 16), "intel", true);
    expect(raw).toBe(-4096);
  });

  it("任意长度 Intel 值", () => {
    const data = Buffer.from([0xad, 0xde, 0, 0, 0, 0, 0, 0]);
    expect(readRaw(data, intelSpan(0, 16), "intel", false)).toBe(0xdead);
  });
});

// Motorola 大端：与 cantools 的 set bit 顺序逐一对照（含“锯齿”跨字节）。
describe("Motorola 位序（对照 cantools）", () => {
  const cases: Array<[number, number, number[]]> = [
    [7, 16, [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8]],
    [11, 12, [11, 10, 9, 8, 23, 22, 21, 20, 19, 18, 17, 16]],
    [35, 8, [35, 34, 33, 32, 47, 46, 45, 44]],
    [39, 16, [39, 38, 37, 36, 35, 34, 33, 32, 47, 46, 45, 44, 43, 42, 41, 40]],
    [51, 10, [51, 50, 49, 48, 63, 62, 61, 60, 59, 58]],
    [19, 13, [19, 18, 17, 16, 31, 30, 29, 28, 27, 26, 25, 24, 39]],
    [3, 5, [3, 2, 1, 0, 15]]
  ];
  for (const [start, len, expectedIntelIndices] of cases) {
    it(`start=${start} len=${len}`, () => {
      const span = motorolaSpan(start, len);
      const indices = span.cells.map((c) => c.byte * 8 + c.bit);
      expect(indices).toEqual(expectedIntelIndices);
    });
  }

  it("Motorola 有符号跨字节负值", () => {
    // start 11 len12: 高 4 位在字节2 高半字节，低 8 位在字节1
    const data = Buffer.from([0x00, 0xff, 0xf0, 0, 0, 0, 0, 0]);
    const raw = readRaw(data, motorolaSpan(11, 12), "motorola", true);
    expect(raw).toBe(-1);
  });

  it("Motorola 取值与 cantools 一致（外部参照）", () => {
    const dbc = `VERSION "x"
BO_ 100 M: 8 E
 SG_ S : 11|12@0+ (1,0) [0|4095] "" E
`;
    const data = Buffer.from([0x00, 0x34, 0x12, 0, 0, 0, 0, 0]); // 高 nibble=1, 低字节=0x34 → 0x134
    const parsed = parseDbc(dbc);
    const sig = parsed.messages[0].signals[0];
    const raw = readRaw(data, spanFor(sig.byteOrder as ByteOrder, sig.startBit, sig.length), "motorola", false);
    // cantools encode 0x134 → data 00 34 12
    expect(raw).toBe(0x134);
  });
});
