import { describe, expect, it } from 'vitest';
import { diffMessages, effectiveAt, parseDbc } from '../src/core/dbc.js';

const DBC = `
VERSION ""
BO_ 256 MOTOR: 8 MCU
 SG_ Speed : 0|16@1+ (0.25,0) [0|16000] "rpm" MCU
 SG_ Temp : 23|8@0- (1,-40) [-40|215] "degC" MCU

BO_ 2147483904 EXT_DIAG: 8 DIAG
 SG_ Code : 0|16@1+ (1,0) [0|65535] "" DIAG

BO_ 512 MUX_MSG: 8 ECU
 SG_ Sel M : 0|4@1+ (1,0) [0|15] "" ECU
 SG_ V m1 : 8|16@1+ (0.01,0) [0|655] "V" ECU

VAL_ 256 Gear 0 "P" 1 "R";
`;

describe('DBC 解析', () => {
  it('解析 BO_/SG_/VAL_ 并识别扩展帧', () => {
    const { messages } = parseDbc(DBC);
    const motor = messages.find((m) => m.name === 'MOTOR')!;
    expect(motor.canId).toBe(0x100);
    expect(motor.isExtended).toBe(false);
    expect(motor.signals[0]).toMatchObject({ name: 'Speed', startBit: 0, bitLength: 16, byteOrder: 'intel', factor: 0.25 });
    expect(motor.signals[1]).toMatchObject({ name: 'Temp', byteOrder: 'motorola', sign: '-', offset: -40 });
    const ext = messages.find((m) => m.name === 'EXT_DIAG')!;
    expect(ext.isExtended).toBe(true);
    expect(ext.canId).toBe(0x100);
    const muxMsg = messages.find((m) => m.name === 'MUX_MSG')!;
    expect(muxMsg.signals[0].mux).toBe('switch');
    expect(muxMsg.signals[1].mux).toBe(1);
    expect(motor.enumMap.Gear).toEqual({ 0: 'P', 1: 'R' });
  });
});

describe('生效区间（半开）', () => {
  const vs = [
    { id: 1, effectiveFrom: null, effectiveTo: 100000, createdAt: 1 },
    { id: 2, effectiveFrom: 100000, effectiveTo: null, createdAt: 2 }
  ];
  it('端点处 v1 过期、v2 生效', () => {
    expect(effectiveAt(vs, 99999)).toBe(1);
    expect(effectiveAt(vs, 100000)).toBe(2);
  });
  it('无版本覆盖返回 null', () => {
    expect(effectiveAt([{ id: 9, effectiveFrom: 5, effectiveTo: 10, createdAt: 1 }], 11)).toBeNull();
  });
  it('diff 检测信号字段变化', () => {
    const mk = (startBit: number, factor: number) => ({
      id: 1, dbcId: 1, canId: 1, isExtended: false, name: 'M', dlc: 8, transmitter: null,
      signals: [{ id: 1, messageId: 1, name: 'A', startBit, bitLength: 16, byteOrder: 'intel' as const, sign: '+' as const, factor, offset: 0, minimum: null, maximum: null, unit: null, muxRole: 'normal' as const, enumMap: {} }]
    });
    const d = diffMessages(mk(0, 0.25), mk(7, 0.125), 1, false);
    expect(d.compatible).toBe(false);
    expect(d.changedSignals[0].fields).toEqual(expect.arrayContaining(['startBit', 'factor']));
  });
});
