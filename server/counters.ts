/** Counter (rolling counter) analysis per node and capture generation. */

export interface CounterSample {
  hwTime: number;
  frameId: number;
  value: number;
}

export type CounterEventKind = 'ok' | 'wrap' | 'duplicate' | 'missing';

export interface CounterEvent {
  kind: CounterEventKind;
  fromTime: number;
  toTime: number;
  fromValue: number;
  toValue: number;
  /** number of missing counter steps (only for kind === 'missing') */
  missing?: number;
}

export interface CounterReport {
  node: string;
  generation: number;
  messageId: number;
  isExtended: boolean;
  signal: string;
  modulus: number;
  samples: number;
  events: CounterEvent[];
  duplicates: number;
  missingTotal: number;
  wraps: number;
}

/**
 * Analyse a time-ordered sequence of counter values.
 * - step of +1 (mod 2^bits): ok (a step from max to 0 is a legitimate wrap)
 * - same value twice: duplicate
 * - larger forward jump: missing frames (gap = delta - 1)
 * Backwards jumps that are not a wrap are reported as missing with the
 * modular distance, keeping the check total and deterministic.
 */
export function analyzeCounter(
  samples: CounterSample[],
  bits: number,
  ctx: { node: string; generation: number; messageId: number; isExtended: boolean; signal: string },
): CounterReport {
  const modulus = 2 ** bits;
  const events: CounterEvent[] = [];
  let duplicates = 0;
  let missingTotal = 0;
  let wraps = 0;

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    const delta = (((cur.value - prev.value) % modulus) + modulus) % modulus;
    if (delta === 1) {
      const kind: CounterEventKind = cur.value === 0 && prev.value === modulus - 1 ? 'wrap' : 'ok';
      if (kind === 'wrap') wraps++;
      events.push({ kind, fromTime: prev.hwTime, toTime: cur.hwTime, fromValue: prev.value, toValue: cur.value });
    } else if (delta === 0) {
      duplicates++;
      events.push({ kind: 'duplicate', fromTime: prev.hwTime, toTime: cur.hwTime, fromValue: prev.value, toValue: cur.value });
    } else {
      const missing = delta - 1;
      missingTotal += missing;
      events.push({ kind: 'missing', fromTime: prev.hwTime, toTime: cur.hwTime, fromValue: prev.value, toValue: cur.value, missing });
    }
  }

  return { ...ctx, modulus, samples: samples.length, events, duplicates, missingTotal, wraps };
}
