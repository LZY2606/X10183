import { describe, expect, it } from "vitest";
import { checkCrcs } from "../src/core/checks/crc";
import { insertFrames } from "../src/server/repo";
import { frame, seedRules, setupDb } from "./helpers";
import type { CrcRule } from "../src/core/types";

// v1 覆盖集（线性位）：EngineSpeed 0..15, EngineTemp 16..23, Mode 24..27, Torque 32..47
function crc8(bytes: number[], poly = 0x07, init = 0x00, xorOut = 0x00) {
  let crc = init;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? (((crc << 1) ^ poly) & 0xff) : ((crc << 1) & 0xff);
  }
  return (crc ^ xorOut) & 0xff;
}

function coverBytes(d: number[]) {
  const bits: number[] = [];
  for (const r of [
    [0, 15],
    [16, 23],
    [24, 27],
    [32, 47],
  ])
    for (let i = r[0]; i <= r[1]; i++) bits.push(i);
  const bytes: number[] = [];
  let cur = 0;
  let n = 0;
  for (const linear of bits) {
    cur = (cur << 1) | ((d[Math.floor(linear / 8)] >> (linear % 8)) & 1);
    n++;
    if (n === 8) {
      bytes.push(cur);
      cur = 0;
      n = 0;
    }
  }
  if (n) bytes.push(cur << (8 - n));
  return bytes;
}

function eng(speed: number, temp: number, mode: number, torque: number, crc: number) {
  const d = [0, 0, 0, 0, 0, 0, 0, crc];
  d[0] = speed & 0xff;
  d[1] = (speed >> 8) & 0xff;
  d[2] = temp;
  d[3] = mode & 0x0f;
  d[4] = torque & 0xff;
  d[5] = (torque >> 8) & 0xff;
  return d;
}

const rule: CrcRule = {
  messageName: "ENGINE_STATUS",
  coverSignals: ["EngineSpeed", "EngineTemp", "Mode", "Torque"],
  crcSignal: "Crc",
  poly: 0x07,
  init: 0x00,
  xorOut: 0x00,
};

describe("CRC 覆盖边界 / 初值 / 异或 / 不完整配置", () => {
  it("正确覆盖范围与默认参数：pass", () => {
    const db = setupDb();
    let d = eng(800, 65, 0, 500, 0);
    d = eng(800, 65, 0, 500, crc8(coverBytes(d)));
    insertFrames(db, [frame(0.1, 0x100, "std", d)]);
    const ev = checkCrcs(db, [rule]);
    expect(ev[0].verdict).toBe("pass");
    expect(ev[0].coveredBits).toEqual([
      { first: 0, last: 15 },
      { first: 16, last: 23 },
      { first: 24, last: 27 },
      { first: 32, last: 47 },
    ]);
  });

  it("覆盖边界错误（少一个信号）：fail，而不是 pass", () => {
    const db = setupDb();
    let d = eng(800, 65, 0, 500, 0);
    // 故意按“少 Torque”的覆盖计算 CRC
    const bits: number[] = [];
    for (const r of [[0, 15], [16, 23], [24, 27]]) for (let i = r[0]; i <= r[1]; i++) bits.push(i);
    const bytes: number[] = [];
    let cur = 0;
    let n = 0;
    for (const linear of bits) {
      cur = (cur << 1) | ((d[Math.floor(linear / 8)] >> (linear % 8)) & 1);
      if (++n === 8) {
        bytes.push(cur);
        cur = 0;
        n = 0;
      }
    }
    if (n) bytes.push(cur << (8 - n));
    d[7] = crc8(bytes);
    insertFrames(db, [frame(0.1, 0x100, "std", d)]);
    const ev = checkCrcs(db, [rule]);
    expect(ev[0].verdict).toBe("fail");
    expect(ev[0].expected).not.toBe(ev[0].actual);
  });

  it("自定义 init 与 xorOut 生效", () => {
    const db = setupDb();
    const custom: CrcRule = { ...rule, init: 0xff, xorOut: 0x55 };
    let d = eng(800, 65, 0, 500, 0);
    d[7] = crc8(coverBytes(d), 0x07, 0xff, 0x55);
    insertFrames(db, [frame(0.1, 0x100, "std", d)]);
    const ev = checkCrcs(db, [custom]);
    expect(ev[0].verdict).toBe("pass");
    expect(ev[0].init).toBe(0xff);
    expect(ev[0].xorOut).toBe(0x55);
  });

  it("配置不完整（找不到 CRC 信号）只能“未核验”", () => {
    const db = setupDb();
    const d = eng(800, 65, 1, 500, 0);
    insertFrames(db, [frame(0.1, 0x100, "std", d)]);
    const ev = checkCrcs(db, [{ ...rule, crcSignal: "GhostCrc" }]);
    expect(ev[0].verdict).toBe("unverified");
    expect(ev[0].expected).toBeNull();
    expect(ev[0].detail).toContain("未核验");
  });

  it("覆盖信号包含非活跃（未知 mux 分支）信号时只能“未核验”", () => {
    const db = setupDb();
    // Mode=9 -> Torque unknown
    const d = eng(800, 65, 9, 500, 0);
    insertFrames(db, [frame(2, 0x100, "std", d)]);
    const ev = checkCrcs(db, [rule]);
    expect(ev[0].verdict).toBe("unverified");
    expect(ev[0].detail).toContain("无法解析");
  });

  it("没有规则的消息不产生证据（既非通过也非失败）", () => {
    const db = setupDb();
    insertFrames(db, [frame(1, 0x18f001, "ext", [0, 0, 0, 0, 0, 0, 0, 0])]);
    expect(checkCrcs(db, [rule])).toHaveLength(0);
  });
});
