import { describe, expect, it } from 'vitest';
import { parseDbc } from '../server/dbc.js';

describe('DBC 解析', () => {
  it('解析消息、信号、枚举、mux、扩展帧与字节序', () => {
    const text = `
VERSION "x"
BO_ 256 EngineData: 8 ECU
 SG_ Speed : 0|16@1+ (0.25,0) [0|100] "rpm" ECU
 SG_ Torque : 7|16@0- (0.1,-10) [0|0] "Nm" ECU
 SG_ Mode M : 24|4@1+ (1,0) [0|0] "" ECU
 SG_ Win 0m : 32|8@1+ (1,0) [0|0] "%" ECU
VAL_ 256 Win 0 "Up" 1 "Down" ;

BO_ 2566848513 ExtMsg: 8 GW
 SG_ X : 0|8@1+ (1,0) [0|0] "" GW
`;
    const parsed = parseDbc(text);
    expect(parsed.messages).toHaveLength(2);
    const eng = parsed.messages[0];
    expect(eng.name).toBe('EngineData');
    expect(eng.dlc).toBe(8);
    expect(eng.transmitter).toBe('ECU');
    const speed = eng.signals[0];
    expect(speed.byteOrder).toBe('intel');
    expect(speed.signed).toBe(false);
    expect(speed.scale).toBe(0.25);
    const torque = eng.signals[1];
    expect(torque.byteOrder).toBe('motorola');
    expect(torque.signed).toBe(true);
    expect(torque.offset).toBe(-10);
    expect(eng.signals[2].muxType).toBe('multiplexor');
    expect(eng.signals[3].muxType).toBe('multiplexed');
    expect(eng.signals[3].muxSwitch).toBe(0);
    expect(eng.signals[3].enums).toEqual([{ raw: 0, label: 'Up' }, { raw: 1, label: 'Down' }]);
    const ext = parsed.messages[1];
    expect(ext.extended).toBe(true);
    expect(ext.arbId).toBe(0x18ff0001);
  });
});
