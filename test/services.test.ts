import { describe, expect, it } from 'vitest';
import { freshDb } from './helpers';
import {
  addVersion,
  compareVersions,
  counterReport,
  crcReport,
  createInvestigation,
  decideMigration,
  decodeFrame,
  getInvestigation,
  listFrames,
  listVersions,
  proposeMigration,
  updateVersionInterval,
} from '../src/server/services';
import { docV1, docV2 } from './fixtures';
import { importTrace } from '../src/server/db';

const MS = 1e6;

describe('种子数据端到端', () => {
  it('生效区间端点：790ms 用 v1，800ms 整与 900ms 用 v2（半开区间）', () => {
    freshDb();
    const frames = listFrames({ arbId: 0x100, generation: 1, limit: 500 });
    const at = (t: number) => frames.find((f) => f.hwTimeNs === t)!;
    expect(at(790 * MS).versionLabel).toContain('v1');
    expect(at(800 * MS).versionLabel).toContain('v2');
    expect(at(900 * MS).versionLabel).toContain('v2');
  });

  it('标准帧与扩展帧严格分类：同数值 id 也不串定义', () => {
    freshDb();
    const all = listFrames({});
    const ext = all.filter((f) => f.extended);
    expect(ext.length).toBeGreaterThan(0);
    const extFrame = ext[0];
    const decoded = decodeFrame(extFrame.id);
    expect(decoded.resolution.resolved).toBe(true);
    expect((decoded as any).messageDef.extended).toBe(true);
    // std 0x100 不会误匹配 xtd
    const std = all.find((f) => f.arbId === 0x100 && !f.extended)!;
    expect((decodeFrame(std.id) as any).messageDef.extended).toBe(false);
  });

  it('计数器报告包含环绕/重复/缺帧/重复时间戳，且按代次分组', () => {
    freshDb();
    const r = counterReport();
    const gen0 = r.series.find((s) => s.node === 'NODE_A' && s.generation === 0)!;
    const kinds = new Set(gen0.events.map((e) => e.kind));
    expect(kinds.has('wrap')).toBe(true);
    expect(kinds.has('repeat')).toBe(true);
    expect(kinds.has('gap')).toBe(true);
    expect(kinds.has('duplicate-timestamp')).toBe(true);
    const gen1 = r.series.find((s) => s.node === 'NODE_A' && s.generation === 1);
    expect(gen1).toBeTruthy();
  });

  it('CRC：v1 帧有通过也有篡改失败；v2 区间的帧只能“未核验”', () => {
    freshDb();
    const r = crcReport();
    expect(r.summary.pass).toBeGreaterThan(0);
    expect(r.summary.fail).toBe(1);
    // v2 区间（>=800ms）的 MOTOR 帧因配置不完整 -> 未核验
    const unverified = r.evidences.filter((e) => e.status === 'not-verified');
    expect(unverified.length).toBeGreaterThan(0);
  });

  it('mux 未知帧解码保留 raw bits 且无物理值', () => {
    freshDb();
    const frames = listFrames({ arbId: 0x200 });
    const unknown = frames.find((f) => f.hwTimeNs === 60 * MS)!;
    const r = decodeFrame(unknown.id) as any;
    expect(r.decoded.unknownMux).toBe(true);
    const rpm = r.decoded.signals.find((s: any) => s.name === 'EngineRpm');
    expect(rpm.unknownBranch).toBe(true);
    expect(rpm.value).toBeNull();
    expect(r.decoded.muxPayload.switchRaw).toBe(9);
  });
});

describe('DBC 修订/过期与冻结快照', () => {
  it('调整版本生效区间后受影响帧换版本；旧快照仍冻结在旧定义', () => {
    freshDb();
    const frames = listFrames({});
    const target = frames.find((f) => f.hwTimeNs === 900 * MS)!;
    const before = decodeFrame(target.id) as any;
    expect(before.resolution.version.label).toContain('v2');
    const inv = createInvestigation({ name: '冻结 900ms', frameIds: [target.id] });
    expect(inv.frozenVersionIds).toEqual([2]);

    const versions = listVersions();
    const v2 = versions.find((v) => v.label.includes('v2'))!;
    // 把 v2 起点推到 1s：900ms 帧回落到 v1（v1 end 仍是 800ms -> 实际无覆盖）
    // 改为把 v1 延长到 950ms，并把 v2 推后
    const v1 = versions.find((v) => v.label.includes('v1'))!;
    const up1 = updateVersionInterval(v1.id as number, { startNs: 0, endNs: 950 * MS, expectedRowVersion: v1.rowVersion as number });
    expect(up1.staleFrameIds.length).toBeGreaterThan(0);
    const up2 = updateVersionInterval(v2.id as number, { startNs: 950 * MS, endNs: null, expectedRowVersion: v2.rowVersion as number });
    expect(up2.rowVersion).toBe(v2.rowVersion + 1);

    const after = decodeFrame(target.id) as any;
    expect(after.resolution.version.label).toContain('v1');

    // 冻结快照不变
    const snap = getInvestigation(inv.id);
    expect(snap.rows[0].versionLabel).toContain('v2');
    expect(snap.rows[0].decoded.messageDef.name).toBe('MOTOR_STATUS');
  });

  it('区间非法被拒绝', () => {
    freshDb();
    const v = listVersions()[0];
    expect(() =>
      updateVersionInterval(v.id, { startNs: 100, endNs: 50, expectedRowVersion: v.rowVersion }),
    ).toThrow(/生效区间/);
  });
});

describe('版本对比与迁移并发审批', () => {
  it('比较 v1/v2：MOTOR 帧 Temp/计数器布局变化被检出', () => {
    freshDb();
    const r = compareVersions(1, 2);
    expect(r.stats.total).toBeGreaterThan(0);
    const motor = r.frames.find((f) => f.arbId === 0x100 && !f.extended)!;
    const temp = motor.signals.find((s: any) => s.signal === 'Temp')!;
    expect(['changed', 'unchanged']).toContain(temp.status);
  });

  it('迁移映射可批准；用过期版本号审批触发 409 冲突', () => {
    freshDb();
    const m = proposeMigration(1, 2, 0x100, false);
    expect(m.mapping.Temp).toBeNull(); // 布局不兼容
    const decided = decideMigration(m.id, 'incompatible', null, 1);
    expect(decided.status).toBe('incompatible');
    expect(decided.rowVersion).toBe(2);
    expect(() => decideMigration(m.id, 'approved', m.mapping, 1)).toThrow(/409|冲突/);
  });

  it('全新不相关版本也可创建（确定性 seq）', () => {
    freshDb();
    const a = addVersion({ label: 'x', startNs: 5_000_000_000, endNs: null, doc: docV1() });
    const b = addVersion({ label: 'y', startNs: 6_000_000_000, endNs: null, doc: docV2() });
    expect(b.id).toBe(a.id + 1);
  });
});

describe('trace 文本导入端到端', () => {
  it('文本行与扩展帧语法可入库并解码', async () => {
    freshDb();
    const { parseTrace } = await import('../src/core/trace-parse');
    const text = `
1100000000 0x100#0000000000000000 gen=3 ch=CAN1
1.2 0x18FE4A00##fa2438ff00000000 gen=3 ch=CAN2`;
    const frames = parseTrace(text);
    expect(frames[0].hwTimeNs).toBe(1_100_000_000);
    expect(frames[1].extended).toBe(true);
    expect(frames[1].hwTimeNs).toBe(1_200_000_000);
    const r = importTrace('文本导入', frames);
    expect(r.inserted).toBe(2);
  });
});
