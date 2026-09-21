import type { CounterEvent, CounterReport, CounterRule, DecodedFrame } from './types.js';

/**
 * 计数器按节点与采集代次分别检查。
 * 同代次内硬件时间排序；重复时间戳用帧 id 稳定打破平局（与导入顺序无关）。
 */
export function checkCounter(decoded: DecodedFrame[], rule: CounterRule): CounterReport {
  const events: CounterEvent[] = [];
  const groups = new Map<number, DecodedFrame[]>();

  for (const d of decoded) {
    const sig = d.signals.find((s) => s.signalName === rule.signalName && !s.muxUnknown);
    if (!sig || sig.raw === null) continue;
    const gen = d.frame.acquisitionGen;
    if (!groups.has(gen)) groups.set(gen, []);
    groups.get(gen)!.push(d);
  }

  const groupSummary: { acquisitionGen: number; count: number }[] = [];
  let hasError = false;

  for (const [gen, frames] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    frames.sort((a, b) => a.frame.hwTime - b.frame.hwTime || a.frame.channel - b.frame.channel || a.frame.id - b.frame.id);
    groupSummary.push({ acquisitionGen: gen, count: frames.length });

    let prev: { value: number; frame: DecodedFrame } | null = null;
    for (const d of frames) {
      const sig = d.signals.find((s) => s.signalName === rule.signalName && !s.muxUnknown)!;
      const value = sig.raw as number;
      if (prev) {
        const max = rule.maxValue ?? inferMax(sig.bitLength);
        const cap = max + 1;
        const expected: number = (prev.value + 1) % cap;
        if (value === prev.value) {
          events.push(mkEvent('duplicate', d, expected, value));
          hasError = true;
        } else if (value === expected) {
          if (expected === 0) events.push(mkEvent('wrap', d, expected, value)); // 合法环绕，仅标记
        } else {
          const lost = (value - prev.value - 1 + cap) % cap;
          events.push({ ...mkEvent('missing', d, expected, value), lost });
          hasError = true;
        }
      }
      prev = { value, frame: d };
    }
  }

  return {
    node: rule.node,
    signalName: rule.signalName,
    groups: groupSummary,
    events,
    ordered: !hasError
  };
}

function inferMax(bitLength: number): number {
  return bitLength >= 32 ? 0xffffffff : (1 << bitLength) - 1;
}

function mkEvent(
  kind: CounterEvent['kind'],
  d: DecodedFrame,
  expected: number,
  actual: number
): CounterEvent {
  return {
    kind,
    frameId: d.frame.id,
    hwTime: d.frame.hwTime,
    acquisitionGen: d.frame.acquisitionGen,
    expected,
    actual
  };
}
