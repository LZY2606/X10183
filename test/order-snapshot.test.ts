import { describe, it, expect } from 'vitest';
import { importFrames } from '../src/server/frames.js';
import { queryDecodes, redecodeAll } from '../src/server/decode.js';
import { counterReports } from '../src/server/analysis.js';
import { createVersion, updateVersion } from '../src/server/versions.js';
import { createSnapshot, getSnapshot } from '../src/server/snapshots.js';
import { msg, s, tempDb, versionInput } from './helpers.js';
import { parseDbc } from '../src/shared/dbc.js';

const messages = [
  msg({
    arbId: 0x100, name: 'Engine', sender: 'ECM',
    signals: [
      s({ name: 'Spd', startBit: 0, length: 16, byteOrder: 1, factor: 0.25 }),
      s({ name: 'Cnt', startBit: 32, length: 4, byteOrder: 1, role: 'counter' })
    ]
  })
];

const batch = [
  { arbId: 0x100, idKind: 'std' as const, data: [0x10, 0x27, 0, 0, 0x40, 0, 0, 0], dlc: 8, hwTimeNs: 100 },
  { arbId: 0x100, idKind: 'std' as const, data: [0x20, 0x4e, 0, 0, 0x50, 0, 0, 0], dlc: 8, hwTimeNs: 50 },
  { arbId: 0x100, idKind: 'std' as const, data: [0x30, 0x75, 0, 0, 0x60, 0, 0, 0], dlc: 8, hwTimeNs: 50 },
  { arbId: 0x100, idKind: 'std' as const, data: [0x40, 0x9c, 0, 0, 0x70, 0, 0, 0], dlc: 8, hwTimeNs: 75 }
];

describe('导入顺序无关性', () => {
  function run(order: number[]) {
    const db = tempDb();
    createVersion(db, versionInput('v1', messages));
    importFrames(db, order.map((i) => batch[i]));
    redecodeAll();
    const decodes = queryDecodes(db);
    const counters = counterReports(db)[0];
    return {
      seq: decodes.map((d) => `${d.hwTimeNs}:${d.signals[0].rawValue}:${d.signals[1].rawValue}`),
      events: counters.events.map((e) => `${e.kind}:${e.actual}`)
    };
  }

  it('乱序导入与顺序导入得到相同的确定性结果', () => {
    const a = run([0, 1, 2, 3]);
    const b = run([3, 2, 1, 0]);
    const c = run([2, 0, 3, 1]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // 重复时间戳 50ns 按 payload 决胜，cnt 5(f0x50) 在 cnt 6(0x60) 前
    expect(a.seq[0]).toContain('50:20000:5');
    expect(a.seq[1]).toContain('50:30000:6');
  });
});

describe('冻结调查快照', () => {
  it('DBC 修订并重放后，快照仍指向旧定义与旧解码', () => {
    const db = tempDb();
    const v1 = createVersion(db, versionInput('v1', messages, { from: 0, to: 1000 }));
    importFrames(db, [
      { arbId: 0x100, idKind: 'std', data: [0x10, 0x27, 0, 0, 0x40, 0, 0, 0], dlc: 8, hwTimeNs: 100 }
    ]);
    redecodeAll();
    const before = queryDecodes(db)[0];
    expect(before.signals[0].physValue).toBe(2500); // 10000 * 0.25

    const snap = createSnapshot(db, '冻结点');

    const revised = JSON.parse(JSON.stringify(messages));
    revised[0].signals[0].factor = 1;
    createVersion(db, versionInput('v2', revised, { from: 1000, to: null }));
    updateV1(db, v1.id, v1.revision);
    redecodeAll();

    const frozen = getSnapshot(db, snap.id);
    const frozenDecode = frozen.payload.decodes.find((d) => d.frameId === 1)!;
    expect(frozen.versionIds).toContain(v1.id);
    expect(frozenDecode.versionId).toBe(v1.id);
    expect(frozenDecode.signals[0].factor).toBe(0.25);
    expect(frozenDecode.signals[0].physValue).toBe(2500);
    expect(frozenDecode.staleReason).not.toBe('changed');

    const live = queryDecodes(db)[0];
    expect(live.staleReason).toBe('changed');
  });
});

function updateV1(db: ReturnType<tempDb>, id: number, revision: number) {
  // 改动 v1 定义（缩放），触发旧解码过期
  const revised = JSON.parse(JSON.stringify(messages));
  revised[0].signals[0].offset = 0;
  revised[0].signals[0].factor = 0.5;
  updateVersion(db, id, revision, { messages: revised });
}

describe('DBC 文本解析', () => {
  it('解析 BO_/SG_/VAL_、Motorola 与扩展帧 id', () => {
    const text = `
VERSION ""
BO_ 100 EngineData: 8 ECM
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16000] "rpm" Vector__XXX
 SG_ CoolantTemp : 15|16@0- (1,-40) [-40|210] "degC" Vector__XXX
 SG_ S1 M0 : 24|8@1+ (1,0) [0|255] "" Vector__XXX
BO_ 2907760640 ExtMsg: 8 ECM
 SG_ RoadSpeed : 7|16@0+ (0.00390625,0) [0|255] "km/h" Vector__XXX
VAL_ 100 S1 0 "Off" 1 "On" ;
`;
    const { messages, warnings } = parseDbc(text, 1);
    expect(warnings).toEqual([]);
    const std = messages.find((m) => m.idKind === 'std')!;
    expect(std.arbId).toBe(100);
    expect(std.sender).toBe('ECM');
    expect(std.signals[0].factor).toBe(0.25);
    expect(std.signals[1].signed).toBe(true);
    expect(std.signals[1].offset).toBe(-40);
    expect(std.signals[2].muxType).toBe('0');
    expect(std.signals[2].muxValue).toBe(0);
    expect(std.signals[2].valTable).toEqual([{ raw: 0, label: 'Off' }, { raw: 1, label: 'On' }]);
    const ext = messages.find((m) => m.idKind === 'ext')!;
    expect(ext.arbId).toBe(0x18fef100);
    expect(ext.signals[0].byteOrder).toBe(0);
  });
});
