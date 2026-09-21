import { describe, expect, it } from "vitest";
import { parseDbc, selectDbcVersion } from "../dbc.js";
import { decodeFrame, selectActiveSignals } from "../decode.js";
import { readRaw, spanFor } from "../bits.js";
import type { MessageDef, RawFrame } from "../types.js";

const DBC = `VERSION "demo"
// @busscale effective 2024-01-01T00:00:00Z .. 2024-07-01T00:00:00Z

BO_ 256 EngineData: 8 EMS
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" EMS
 SG_ EngineTemp : 16|16@1- (0.1,-40) [-40|215.5] "degC" EMS
 SG_ State : 32|2@1+ (1,0) [0|3] "" EMS
 SG_ Counter : 34|4@1+ (1,0) [0|15] "" EMS

BO_ 512 MuxMsg: 8 BCM
 SG_ Svc M : 0|4@1+ (1,0) [0|15] "" BCM
 SG_ A m0 : 8|8@1+ (1,0) [0|255] "" BCM
 SG_ B m1 : 8|8@1+ (1,0) [0|255] "" BCM

VAL_ 256 State 0 "Off" 1 "Run" ;
`;

function frame(data: number[], id = 0x100): RawFrame {
  return {
    id: 1, importId: 1, channel: null, arbitrationId: id, extended: false,
    hwTimeNs: "1", data: Buffer.from(data), seqInImport: 0
  };
}

function buildMessages(): MessageDef[] {
  const parsed = parseDbc(DBC);
  let msgId = 0;
  let sigId = 0;
  return parsed.messages.map((m) => {
    const id = ++msgId;
    return {
      id, dbcVersionId: 1, name: m.name, arbitrationId: m.arbitrationId, extended: false,
      channel: null, dlc: m.dlc, transmitter: m.transmitter,
      signals: m.signals.map((s) => ({
        id: ++sigId, messageId: id, name: s.name, startBit: s.startBit, length: s.length,
        byteOrder: s.byteOrder, signed: s.signed, scale: s.scale, offset: s.offset,
        minimum: s.minimum, maximum: s.maximum, unit: s.unit, muxKind: s.muxKind,
        muxValue: s.muxValue, muxSwitchName: s.muxSwitchName, muxRanges: s.muxRanges,
        enums: s.enums
      }))
    };
  });
}

describe("DBC 解析", () => {
  it("解析信号布局、缩放、偏置与枚举", () => {
    const msgs = buildMessages();
    const engine = msgs.find((m) => m.arbitrationId === 0x100)!;
    expect(engine.signals[0].scale).toBe(0.25);
    expect(engine.signals[1].signed).toBe(true);
    expect(engine.signals[1].offset).toBe(-40);
    const state = engine.signals.find((s) => s.name === "State")!;
    expect(state.enums).toEqual({ 0: "Off", 1: "Run" });
  });

  it("解析多路开关与分支", () => {
    const msgs = buildMessages();
    const mux = msgs.find((m) => m.arbitrationId === 0x200)!;
    expect(mux.signals.find((s) => s.name === "Svc")?.muxKind).toBe("switch");
    expect(mux.signals.find((s) => s.name === "A")?.muxValue).toBe(0);
  });

  it("解析生效区间 pragma（纳秒）", () => {
    const parsed = parseDbc(DBC);
    expect(parsed.effectiveFromNs).toBe(BigInt(Date.parse("2024-01-01T00:00:00Z")) * 1_000_000n);
    expect(parsed.effectiveToNs).toBe(BigInt(Date.parse("2024-07-01T00:00:00Z")) * 1_000_000n);
  });
});

describe("解码", () => {
  it("缩放/偏置/枚举与 bit 区间", () => {
    const msgs = buildMessages();
    const engine = msgs.find((m) => m.arbitrationId === 0x100)!;
    const data = Buffer.alloc(8);
    data.writeUInt16LE(8000, 0); // 8000*0.25 = 2000 rpm
    data.writeInt16LE(500, 2); // 500*0.1-40 = 10 degC
    data[4] = 1; // state=1 run
    const result = decodeFrame(frame([...data]), engine);
    const rpm = result.signals.find((s) => s.signalName === "EngineSpeed")!;
    expect(rpm.value).toBe(2000);
    expect(rpm.bitSpan.cells[0]).toEqual({ byte: 0, bit: 0 });
    const temp = result.signals.find((s) => s.signalName === "EngineTemp")!;
    expect(temp.value).toBeCloseTo(10, 5);
    const state = result.signals.find((s) => s.signalName === "State")!;
    expect(state.value).toBe("Run");
    expect(state.enumLabel).toBe("Run");
  });

  it("跨字节有符号负值：raw=-1 时温度 = -40.1", () => {
    const msgs = buildMessages();
    const engine = msgs.find((m) => m.arbitrationId === 0x100)!;
    const data = Buffer.alloc(8);
    data.writeInt16LE(-1, 2);
    const result = decodeFrame(frame([...data]), engine);
    const temp = result.signals.find((s) => s.signalName === "EngineTemp")!;
    expect(temp.rawValue).toBe(-1);
    expect(temp.value).toBeCloseTo(-40.1, 5);
  });

  it("mux 已知分支只激活该分支信号", () => {
    const msgs = buildMessages();
    const mux = msgs.find((m) => m.arbitrationId === 0x200)!;
    const f = frame([0x00, 0x42], 0x200);
    const { active, branches } = selectActiveSignals(mux, f);
    expect(branches.Svc).toBe(0);
    const names = active.map((a) => a.signal.name);
    expect(names).toContain("A");
    expect(names).not.toContain("B");
  });

  it("mux 未知分支保留 raw bits 且标 unknownMux", () => {
    const msgs = buildMessages();
    const mux = msgs.find((m) => m.arbitrationId === 0x200)!;
    const f = frame([0x09, 0xab], 0x200);
    const result = decodeFrame(f, mux);
    expect(result.muxBranches.Svc).toBe(9);
    for (const s of result.signals) {
      if (s.signalName === "A" || s.signalName === "B") {
        expect(s.unknownMux).toBe(true);
        expect(s.value).toBeNull();
      }
    }
    // 未激活分支字节应计入未解释
    expect(result.unclaimedBits).toContain(8);
  });
});

describe("DBC 生效端点", () => {
  const versions = [
    { id: 1, name: "v1", versionNumber: 1, effectiveFromNs: "0", effectiveToNs: "100", sourceText: "" },
    { id: 2, name: "v2", versionNumber: 2, effectiveFromNs: "100", effectiveToNs: null, sourceText: "" }
  ];
  it("半开区间：t=99 用 v1，t=100 用 v2", () => {
    expect(selectDbcVersion(versions, 99n)?.id).toBe(1);
    expect(selectDbcVersion(versions, 100n)?.id).toBe(2);
  });
  it("重叠时取版本号更大的", () => {
    const overlap = [
      { ...versions[0], effectiveToNs: null },
      { ...versions[1], effectiveToNs: null }
    ];
    expect(selectDbcVersion(overlap, 50n)?.id).toBe(2);
  });
  it("区间外无版本", () => {
    expect(selectDbcVersion([versions[0]], 100n)).toBeNull();
  });
});
