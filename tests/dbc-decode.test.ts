import { describe, expect, it } from 'vitest';
import { parseDbc } from '../src/core/dbc.js';
import { decodeFrame } from '../src/core/decode.js';
import type { RawFrame } from '../src/core/types.js';

// Classic Vector-style small-saw-tooth Intel layout:
//  Speed  0|16@1 -> byte0 LSB, byte1 MSB
//  Temp  16|8@1  -> byte2
//  Mode  32|4@1  -> low nibble of byte4
//  Load  40|8@1  -> byte5 (branch m0)
//  Gear  40|4@1  -> low nibble of byte5 (branch m1)
const dbcText = `VERSION ""
BO_ 100 Msg: 8 ECU
 SG_ Speed : 0|16@1+ (0.5,-10) [0|1000] "kmh" ECU
 SG_ Temp : 16|8@1- (1,-40) [-40|215] "degC" ECU
 SG_ Mode M : 32|4@1+ (1,0) [0|15] "" ECU
 SG_ Load m0 : 40|8@1+ (1,0) [0|255] "%" ECU
 SG_ Gear m1 : 40|4@1+ (1,0) [0|15] "" ECU
 VAL_ 100 Mode 0 "Idle" 1 "Drive" 3 "Sport" ;

BO_ 2147484029 Ext: 8 TCU
 SG_ Word : 8|16@0+ (1,0) [0|65535] "" TCU
`;

function frame(over: Partial<RawFrame>): RawFrame {
  return { generation: 1, channel: 1, id: 100, isExtended: false, direction: 'rx', hwTime: 0, dlc: 8, data: new Array(8).fill(0), ...over };
}

describe('DBC parsing', () => {
  it('parses signals, scaling, signedness, mux markers and enums', () => {
    const doc = parseDbc(dbcText);
    const msg = doc.messages.find((m) => m.messageId === 100)!;
    expect(msg.signals.find((s) => s.name === 'Speed')!).toMatchObject({ byteOrder: 'intel', factor: 0.5, offset: -10 });
    expect(msg.signals.find((s) => s.name === 'Temp')!.valueType).toBe('signed');
    const mode = msg.signals.find((s) => s.name === 'Mode')!;
    expect(mode.muxKind).toBe('switch');
    expect(mode.enums.map((e) => e.name)).toEqual(['Idle', 'Drive', 'Sport']);
    expect(msg.signals.find((s) => s.name === 'Load')!.muxValue).toBe(0);
    expect(msg.signals.find((s) => s.name === 'Load')!.muxSwitchName).toBe('Mode');
  });

  it('keeps extended flag out of the arbitration id', () => {
    const doc = parseDbc(dbcText);
    const ext = doc.messages.find((m) => m.isExtended)!;
    expect(ext.messageId).toBe(293);
    expect(doc.messages.find((m) => m.messageId === 100)!.isExtended).toBe(false);
  });
});

describe('frame decoding', () => {
  const doc = parseDbc(dbcText);

  it('applies factor and offset and names enums', () => {
    const data = new Array(8).fill(0);
    data[0] = 100; // Speed raw 100 -> 40 kmh
    data[4] = 1; // Mode = 1 (Drive)
    const r = decodeFrame(frame({ data }), doc, { id: 1, versionNumber: 1, frameRowId: 7 });
    expect(r.decoded!.frameId).toBe(7);
    const speed = r.decoded!.signals.find((s) => s.name === 'Speed')!;
    expect(speed.value).toBe(40);
    const mode = r.decoded!.signals.find((s) => s.name === 'Mode')!;
    expect(mode.enumName).toBe('Drive');
  });

  it('decodes signed negative temperatures', () => {
    const data = new Array(8).fill(0);
    data[2] = 30; // raw 30, signed 30 - 40 = -10
    const r = decodeFrame(frame({ data }), doc);
    expect(r.decoded!.signals.find((s) => s.name === 'Temp')!.value).toBe(-10);
  });

  it('activates only the selected mux branch and keeps raw bits for others', () => {
    const data = new Array(8).fill(0);
    data[4] = 0; // Mode = 0 -> Load active
    data[5] = 77;
    const r = decodeFrame(frame({ data }), doc);
    expect(r.decoded!.muxSwitch).toEqual({ name: 'Mode', raw: 0 });
    const load = r.decoded!.signals.find((s) => s.name === 'Load')!;
    expect(load.active).toBe(true);
    expect(load.value).toBe(77);
    const gear = r.decoded!.signals.find((s) => s.name === 'Gear')!;
    expect(gear.active).toBe(false);
    expect(gear.value).toBeNull();
    expect(gear.bitPositions.length).toBe(4);
  });

  it('marks unknown mux branch while retaining raw bits', () => {
    const data = new Array(8).fill(0);
    data[4] = 9;
    const r = decodeFrame(frame({ data }), doc);
    expect(r.decoded!.unknownBranch).toBe(true);
    for (const name of ['Load', 'Gear']) {
      const s = r.decoded!.signals.find((x) => x.name === name)!;
      expect(s.active).toBe(false);
      expect(s.bitPositions.length).toBeGreaterThan(0);
    }
  });

  it('refuses to mix standard and extended ids', () => {
    expect(decodeFrame(frame({ id: 293, isExtended: false }), doc).decoded).toBeNull();
    const rExt = decodeFrame(frame({ id: 293, isExtended: true }), doc);
    expect(rExt.decoded!.messageName).toBe('Ext');
  });
});
