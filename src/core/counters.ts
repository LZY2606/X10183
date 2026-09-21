export interface CounterSample {
  node: string;
  generation: number;
  frameId: number;
  hwTimestamp: number;
  arbitrationId: number;
  dataHex: string;
  channel: string;
  counterValue: number;
  counterBits: number;
}

export type CounterEventType = 'wrap' | 'duplicate' | 'gap' | 'duplicate_timestamp';

export interface CounterEvent {
  type: CounterEventType;
  node: string;
  generation: number;
  hwTimestamp: number;
  prevFrameId: number | null;
  frameId: number;
  prevValue: number | null;
  value: number;
  missingCount?: number;
}

export interface CounterGroupReport {
  node: string;
  generation: number;
  samples: number;
  events: CounterEvent[];
}

/**
 * Deterministic content-based ordering: identical frame sets produce identical
 * analysis regardless of the order they were imported in.
 */
export function orderSamples<T extends { hwTimestamp: number; arbitrationId: number; dataHex: string; channel: string }>(
  samples: T[],
): T[] {
  return [...samples].sort(
    (a, b) =>
      a.hwTimestamp - b.hwTimestamp ||
      a.arbitrationId - b.arbitrationId ||
      (a.dataHex < b.dataHex ? -1 : a.dataHex > b.dataHex ? 1 : 0) ||
      (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0),
  );
}

export function analyzeCounters(samples: CounterSample[]): CounterGroupReport[] {
  const groups = new Map<string, CounterSample[]>();
  for (const s of samples) {
    const key = `${s.node}${s.generation}`;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  const reports: CounterGroupReport[] = [];
  for (const [key, group] of [...groups.entries()].sort()) {
    const [node, generationStr] = key.split('');
    const generation = Number(generationStr);
    const ordered = orderSamples(group);
    const events: CounterEvent[] = [];
    // duplicate hardware timestamps within one generation
    const seenTs = new Map<number, CounterSample>();
    for (const s of ordered) {
      const prev = seenTs.get(s.hwTimestamp);
      if (prev) {
        events.push({
          type: 'duplicate_timestamp',
          node,
          generation,
          hwTimestamp: s.hwTimestamp,
          prevFrameId: prev.frameId,
          frameId: s.frameId,
          prevValue: prev.counterValue,
          value: s.counterValue,
        });
      } else {
        seenTs.set(s.hwTimestamp, s);
      }
    }
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      const mod = 2 ** cur.counterBits;
      const expected = (prev.counterValue + 1) % mod;
      if (cur.counterValue === prev.counterValue) {
        events.push({
          type: 'duplicate',
          node,
          generation,
          hwTimestamp: cur.hwTimestamp,
          prevFrameId: prev.frameId,
          frameId: cur.frameId,
          prevValue: prev.counterValue,
          value: cur.counterValue,
        });
      } else if (cur.counterValue === expected) {
        if (cur.counterValue < prev.counterValue) {
          events.push({
            type: 'wrap',
            node,
            generation,
            hwTimestamp: cur.hwTimestamp,
            prevFrameId: prev.frameId,
            frameId: cur.frameId,
            prevValue: prev.counterValue,
            value: cur.counterValue,
          });
        }
      } else {
        events.push({
          type: 'gap',
          node,
          generation,
          hwTimestamp: cur.hwTimestamp,
          prevFrameId: prev.frameId,
          frameId: cur.frameId,
          prevValue: prev.counterValue,
          value: cur.counterValue,
          missingCount: (cur.counterValue - expected + mod) % mod,
        });
      }
    }
    reports.push({ node, generation, samples: ordered.length, events });
  }
  return reports;
}
