export interface CounterSample {
  frameId: number;
  timestamp: number;
  value: number;
}

export type CounterEventType = 'wrap' | 'duplicate' | 'missing';

export interface CounterEvent {
  type: CounterEventType;
  frameId: number;
  timestamp: number;
  previous: number;
  current: number;
  expected: number;
  missingCount: number;
}

export interface CounterReport {
  total: number;
  wraps: number;
  duplicates: number;
  missing: number;
  events: CounterEvent[];
}

export function analyzeCounter(samples: CounterSample[], maxValue: number): CounterReport {
  const modulus = maxValue + 1;
  const events: CounterEvent[] = [];
  let wraps = 0;
  let duplicates = 0;
  let missing = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const expected = (prev.value + 1) % modulus;
    if (cur.value === expected) {
      if (cur.value < prev.value) {
        wraps++;
        events.push({
          type: 'wrap',
          frameId: cur.frameId,
          timestamp: cur.timestamp,
          previous: prev.value,
          current: cur.value,
          expected,
          missingCount: 0,
        });
      }
      continue;
    }
    if (cur.value === prev.value) {
      duplicates++;
      events.push({
        type: 'duplicate',
        frameId: cur.frameId,
        timestamp: cur.timestamp,
        previous: prev.value,
        current: cur.value,
        expected,
        missingCount: 0,
      });
      continue;
    }
    const gap = (cur.value - expected + modulus) % modulus;
    missing += gap;
    events.push({
      type: 'missing',
      frameId: cur.frameId,
      timestamp: cur.timestamp,
      previous: prev.value,
      current: cur.value,
      expected,
      missingCount: gap,
    });
  }

  return { total: samples.length, wraps, duplicates, missing, events };
}
