import { describe, expect, it } from 'vitest';
import { decodeMessage } from '../src/core/decode';
import { hexToBytes } from '../src/core/bits';
import { docV1 } from './fixtures';

describe('解码证据与多路复用', () => {
  it('消息解码带出消息名/字节序/缩放/偏置/枚举与精确 bit 区间', () => {
    const msg = docV1().messages[0];
    // Temp Intel startBit 23（byte2..3）；byte2=0xFA=250 -> 250*0.1-40 = -15
    const data = hexToBytes('0000fa0000000000');
    const r = decodeMessage(msg, data);
    const temp = r.signals.find((s) => s.name === 'Temp')!;
    expect(temp.bitRange).toEqual({ first: 16, last: 31 });
    expect(temp.bitLength).toBe(16);
    expect(temp.byteOrder).toBe('intel');
    expect(temp.raw).toBe(250);
    expect(temp.value).toBeCloseTo(-15);
  });

  it('mux 已知分支：仅被选中分支信号给物理值，其余保留 raw', () => {
    const msg = docV1().messages.find((m: any) => m.name === 'DIAG_MUX')!;
    // mode=0（低 nibble），payload Intel startBit 15：byte1=0x60 byte2=0x09 -> 2400
    const data = hexToBytes('0060090000000000');
    const r = decodeMessage(msg, data);
    expect(r.unknownMux).toBe(false);
    const rpm = r.signals.find((s) => s.name === 'EngineRpm')!;
    expect(rpm.unknownBranch).toBe(false);
    expect(rpm.raw).toBe(2400);
    expect(rpm.value).toBeCloseTo(600);
    const pressure = r.signals.find((s) => s.name === 'Pressure')!;
    expect(pressure.unknownBranch).toBe(true);
    expect(pressure.value).toBeNull();
  });

  it('mux 未知分支：开关正常解码，分支信号只保留 raw bits', () => {
    const msg = docV1().messages.find((m: any) => m.name === 'DIAG_MUX')!;
    // mode=9 -> 低 nibble=9；payload=0xBEEF 在 byte1..2
    const data = hexToBytes('09efbe0000000000');
    const r = decodeMessage(msg, data);
    expect(r.unknownMux).toBe(true);
    expect(r.muxPayload).not.toBeNull();
    expect(r.muxPayload!.switchRaw).toBe(9);
    expect(r.muxPayload!.bitCells.length).toBeGreaterThan(0);
    const rpm = r.signals.find((s) => s.name === 'EngineRpm')!;
    expect(rpm.unknownBranch).toBe(true);
    expect(rpm.value).toBeNull();
    expect(rpm.raw).not.toBeNull();
  });

  it('混用字节序被标记', () => {
    const r = decodeMessage(docV1().messages[0], hexToBytes('0000000000000000'));
    expect(r.byteOrderMixed).toBe(true);
  });

  it('Motorola 跨字节有符号值给出物理值', () => {
    const msg = docV1().messages.find((m: any) => m.name === 'EXT_SIGNED')!;
    const r = decodeMessage(msg, hexToBytes('fa2464ff00000000'));
    const pos = r.signals.find((s) => s.name === 'PositionMoto')!;
    expect(pos.raw).toBe(-1500);
    expect(pos.value).toBeCloseTo(-15);
    const torque = r.signals.find((s) => s.name === 'TorqueIntel')!;
    expect(torque.raw).toBe(-156);
  });
});
