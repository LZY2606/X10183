import { describe, expect, it } from 'vitest';
import { decodeFrame, decodeWithVersion } from '../server/decode.js';
import { createDbcVersion } from '../server/dbcService.js';
import { DBC_EXT, DBC_MUX, DBC_V1, DBC_V2, frame, importGen, memDb, setupVersions } from './helpers.js';
import { listFramesOrdered } from '../server/repo.js';

describe('解码：缩放/偏置/枚举/bit 区间/生效端点', () => {
  it('Intel 有符号跨字节 + 缩放 + 枚举', () => {
    const db = memDb();
    setupVersions(db);
    // speed 0x0320=800 → 200rpm? 0x0320*0.25=200；temp 0x0064=100 → 100-40=60
    importGen(db, 'g1', [frame(1, 256, [0x20, 0x03, 0x64, 0x00, 0x01, 0, 0, 0])]);
    const id = listFramesOrdered(db)[0].id;
    const d = decodeFrame(db, id);
    const speed = d.signals.find((s) => s.name === 'EngineSpeed')!;
    expect(speed.raw).toBe(0x0320);
    expect(speed.physical).toBe(200);
    expect(speed.bitCells[0]).toBe(8);
    expect(speed.bitCells.length).toBe(16);
    const temp = d.signals.find((s) => s.name === 'EngineTemp')!;
    expect(temp.raw).toBe(100);
    expect(temp.physical).toBe(60);
    const state = d.signals.find((s) => s.name === 'EngineState')!;
    expect(state.enumLabel).toBe('Run');
  });

  it('有符号负值跨字节：raw=0xFFEC (-20) → 物理 -60', () => {
    const db = memDb();
    setupVersions(db);
    importGen(db, 'g1', [frame(2, 256, [0, 0, 0xec, 0xff, 0, 0, 0, 0])]);
    const d = decodeFrame(db, listFramesOrdered(db)[0].id);
    const temp = d.signals.find((s) => s.name === 'EngineTemp')!;
    expect(temp.raw).toBe(0xffec);
    expect(temp.physical).toBe(-60);
  });

  it('Motorola v2 布局：7|16@0+ ×0.1', () => {
    const db = memDb();
    setupVersions(db);
    importGen(db, 'g1', [frame(11, 256, [0x12, 0x34, 0, 0, 0, 0, 0, 0])]);
    const d = decodeFrame(db, listFramesOrdered(db)[0].id);
    expect(d.dbcLabel).toBe('v2');
    const speed = d.signals.find((s) => s.name === 'VehicleSpeed')!;
    expect(speed.raw).toBe(0x1234);
    expect(speed.physical).toBeCloseTo(466, 5);
  });

  it('生效区间为半开 [from,to)：边界帧精确归属', () => {
    const db = memDb();
    setupVersions(db);
    importGen(db, 'g1', [
      frame(9.999999, 256, [0, 0, 0, 0, 0, 0, 0, 0]),
      frame(10, 256, [0, 0, 0, 0, 0, 0, 0, 0])
    ]);
    const [a, b] = listFramesOrdered(db);
    expect(decodeFrame(db, a.id).dbcLabel).toBe('v1');
    expect(decodeFrame(db, b.id).dbcLabel).toBe('v2');
  });

  it('无生效 DBC / 无消息定义时标记未解码', () => {
    const db = memDb();
    setupVersions(db);
    importGen(db, 'g1', [frame(1, 999, [1, 2, 3, 0, 0, 0, 0, 0])]);
    const d = decodeFrame(db, listFramesOrdered(db)[0].id);
    expect(d.undecoded).toBe(true);
    expect(d.undecodedReason).toBe('no-message-in-dbc');
  });

  it('同一 arbitration id 标准/扩展帧分别解析', () => {
    const db = memDb();
    createDbcVersion(db, { label: 'std', source: 'BO_ 100 S: 4 N\n SG_ A : 0|8@1+ (1,0) [0|0] "" N\n', effectiveFrom: null, effectiveTo: null });
    createDbcVersion(db, { label: 'ext', source: DBC_EXT, effectiveFrom: null, effectiveTo: null });
    importGen(db, 'g1', [
      frame(1, 100, [7, 0, 0, 0]),
      frame(2, 0x18ff0001, [9, 0, 0, 0, 0, 0, 0, 0], { extended: true })
    ]);
    const [std, ext] = listFramesOrdered(db);
    expect(decodeFrame(db, std.id).messageName).toBe('S');
    expect(decodeFrame(db, ext.id).messageName).toBe('ExtMsg');
    expect(decodeFrame(db, ext.id).signals[0].raw).toBe(9);
  });
});

describe('多路复用：未知分支保留 raw bits', () => {
  it('已知分支解码，未知分支只保留 raw bits', () => {
    const db = memDb();
    createDbcVersion(db, { label: 'mux', source: DBC_MUX, effectiveFrom: null, effectiveTo: null });
    importGen(db, 'g1', [
      frame(1, 512, [0x00, 75, 0, 0, 0, 0, 0, 0]),
      frame(2, 512, [0x01, 0, 2, 0, 0, 0, 0, 0]),
      frame(3, 512, [0x05, 90, 3, 0, 0, 0, 0, 0])
    ]);
    const [f0, f1, fUnknown] = listFramesOrdered(db);
    const d0 = decodeFrame(db, f0.id);
    expect(d0.signals.find((s) => s.name === 'WindowPos')!.active).toBe(true);
    expect(d0.signals.find((s) => s.name === 'WindowPos')!.raw).toBe(75);
    expect(d0.signals.find((s) => s.name === 'LightLevel')!.active).toBe(false);

    const d1 = decodeFrame(db, f1.id);
    expect(d1.signals.find((s) => s.name === 'LightLevel')!.raw).toBe(2);

    const du = decodeFrame(db, fUnknown.id);
    for (const name of ['WindowPos', 'LightLevel']) {
      const s = du.signals.find((q) => q.name === name)!;
      expect(s.active).toBe(false);
      expect(s.reason).toBe('unknown-mux');
      expect(s.raw).toBeNull();
      expect(s.physical).toBeNull();
      expect(s.rawBits).toMatch(/^[01]{8}$/);
    }
  });
});

describe('按指定版本解码（版本比较基础）', () => {
  it('v1 与 v2 对同一帧给出不同信号集', () => {
    const db = memDb();
    const { v1, v2 } = setupVersions(db);
    importGen(db, 'g1', [frame(1, 256, [0x20, 0x03, 0x64, 0, 0, 0, 0, 0])]);
    const id = listFramesOrdered(db)[0].id;
    const a = decodeWithVersion(db, v1, [id])[0];
    const b = decodeWithVersion(db, v2, [id])[0];
    expect(a.signals.some((s) => s.name === 'EngineSpeed')).toBe(true);
    expect(b.signals.some((s) => s.name === 'VehicleSpeed')).toBe(true);
  });
});
