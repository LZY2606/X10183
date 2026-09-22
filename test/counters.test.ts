import { describe, expect, it } from 'vitest';
import { analyzeCounters } from '../server/counters.js';
import { frame, importGen, memDb, setupVersions } from './helpers.js';

function eng(time: number, counter: number, extra: Partial<Parameters<typeof frame>[3]> = {}): ReturnType<typeof frame> {
  return frame(time, 256, [0, 0, 0, 0, 0, counter, 0, 0], extra);
}

describe('计数器：环绕/重复/缺帧，按节点+采集代次', () => {
  it('识别全部事件并在代次边界重置', () => {
    const db = memDb();
    setupVersions(db);
    importGen(db, 'g1', [
      eng(0.0, 0),
      eng(0.5, 1),
      eng(1.0, 1),               // 重复计数
      eng(1.0, 2, { }),          // 重复时间戳
      eng(1.5, 5),               // 缺帧 2→5（delta=3）
      eng(2.0, 15),              // 缺帧 5→15
      eng(2.5, 0)                // 环绕 15→0
    ]);
    importGen(db, 'g2', [eng(3.0, 0, { channel: 1 })]);

    const events = analyzeCounters(db);
    const gen1 = events.filter((e) => e.importGen === 1);
    const kinds = gen1.map((e) => e.event);
    expect(kinds).toEqual(['ok', 'ok', 'duplicate', 'duplicate', 'gap', 'gap', 'wrap']);
    const gap = gen1.find((e) => e.event === 'gap')!;
    expect(gap.detail).toContain('跳过 2');
    expect(gap.node).toBe('ECU');

    // 第二代次重新作为序列起点，不把代次间跳变误判为缺口
    const gen2 = events.filter((e) => e.importGen === 2);
    expect(gen2).toHaveLength(1);
    expect(gen2[0].detail).toContain('起点');
  });
});
