import { describe, expect, it } from 'vitest';
import { parseDbc } from '../src/core/dbc-parse';

const SAMPLE = `
VERSION ""
BU_: NODE_A DIAG
BO_ 256 MOTOR_STATUS: 8 NODE_A
 SG_ Temp : 0|16@1+ (0.1,-40) [-40|215] "degC"  NODE_A
 SG_ RollingCounter M : 8|4@1+ (1,0) [0|15] "" NODE_A
 SG_ Voltage : 23|16@0+ (0.01,0) [0|655.35] "V" NODE_A
BO_ 2566801920 EXT_MSG: 8 Vector__XXX
 SG_ Position : 7|16@0- (0.01,0) [-327.68|327.67] "m"
BO_ 512 DIAG_MUX: 8 DIAG
 SG_ Mode M : 0|4@1+ (1,0) [0|15] "" DIAG
 SG_ EngineRpm m0 : 8|16@1+ (0.25,0) [0|16383.75] "rpm" DIAG
VAL_ 256 Temp 0 "OFF" 1 "ON" ;
`;

describe('DBC 解析', () => {
  it('解析消息/信号/字节序/有符号/mux/枚举/扩展帧', () => {
    const doc = parseDbc(SAMPLE);
    expect(doc.nodes).toEqual(['NODE_A', 'DIAG']);
    const motor = doc.messages.find((m) => m.name === 'MOTOR_STATUS')!;
    expect(motor.extended).toBe(false);
    expect(motor.transmitter).toBe('NODE_A');
    const temp = motor.signals.find((s) => s.name === 'Temp')!;
    expect(temp.byteOrder).toBe('intel');
    expect(temp.factor).toBeCloseTo(0.1);
    expect(temp.offset).toBe(-40);
    expect(temp.enums).toEqual([
      { value: 0, label: 'OFF' },
      { value: 1, label: 'ON' },
    ]);
    const voltage = motor.signals.find((s) => s.name === 'Voltage')!;
    expect(voltage.byteOrder).toBe('motorola');
    expect(motor.signals.find((s) => s.name === 'RollingCounter')!.muxSwitch).toBe(true);

    const ext = doc.messages.find((m) => m.name === 'EXT_MSG')!;
    expect(ext.extended).toBe(true);
    expect(ext.arbId).toBe(0x18fe4a00);
    expect(ext.transmitter).toBeNull();
    expect(ext.signals[0].signed).toBe(true);

    const diag = doc.messages.find((m) => m.name === 'DIAG_MUX')!;
    expect(diag.signals.find((s) => s.name === 'EngineRpm')!.muxValue).toBe(0);
  });
});
