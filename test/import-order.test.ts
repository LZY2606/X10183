import { afterEach, describe, expect, it } from 'vitest';
import { reopenDb } from '../src/server/db';
import { importTrace } from '../src/server/db';
import { listFrames } from '../src/server/services';
import type { FrameInput } from '../src/core/types';

const base: FrameInput[] = [
  { arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 3000, generation: 0, dataHex: 'aabb' },
  { arbId: 0x200, extended: false, channel: 'CAN1', hwTimeNs: 1000, generation: 0, dataHex: 'ccdd' },
  { arbId: 0x18fe4a00, extended: true, channel: 'CAN2', hwTimeNs: 2000, generation: 1, dataHex: 'eeff' },
  { arbId: 0x100, extended: false, channel: 'CAN1', hwTimeNs: 3000, generation: 0, dataHex: 'aabb' },
];

afterEach(() => {
  reopenDb(':memory:');
});

describe('导入顺序无关', () => {
  it('正序与乱序导入产生相同的确定性帧 id 与时间轴顺序', () => {
    reopenDb(':memory:');
    importTrace('a', base);
    const a = listFrames({}).map((f) => [f.id, f.hwTimeNs, f.arbId, f.extended, f.generation]);

    reopenDb(':memory:');
    importTrace('b', [...base].reverse());
    const b = listFrames({}).map((f) => [f.id, f.hwTimeNs, f.arbId, f.extended, f.generation]);

    expect(b).toEqual(a);
    expect(a.length).toBe(4);
    // 时间轴按 hwTimeNs 排序
    expect(a.map((r) => r[1])).toEqual([1000, 2000, 3000, 3000]);
  });

  it('重复内容在第二批被计为 duplicates 且复用同一 id', () => {
    reopenDb(':memory:');
    const first = importTrace('a', base);
    const second = importTrace('a2', [base[1], base[2]]);
    expect(first.inserted).toBe(3);
    expect(first.duplicates).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(second.frameIds).toContain(first.frameIds[0]);
  });
});
