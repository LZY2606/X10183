export interface CounterSample {
  raw: number;
  hw_timestamp: number;
}

export interface CounterIssue {
  kind: 'duplicate' | 'gap';
  index: number;
  prev: number;
  current: number;
  missing: number;
  hw_timestamp: number;
}

export interface CounterResult {
  checked: number;
  wraps: number;
  duplicates: CounterIssue[];
  gaps: CounterIssue[];
}

export function checkCounter(samples: CounterSample[], bitLength: number): CounterResult {
  const modulus = 2 ** bitLength;
  const result: CounterResult = { checked: samples.length, wraps: 0, duplicates: [], gaps: [] };
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].raw;
    const cur = samples[i].raw;
    const diff = (((cur - prev) % modulus) + modulus) % modulus;
    if (cur < prev) result.wraps++;
    if (diff === 0) {
      result.duplicates.push({
        kind: 'duplicate',
        index: i,
        prev,
        current: cur,
        missing: 0,
        hw_timestamp: samples[i].hw_timestamp,
      });
    } else if (diff > 1) {
      result.gaps.push({
        kind: 'gap',
        index: i,
        prev,
        current: cur,
        missing: diff - 1,
        hw_timestamp: samples[i].hw_timestamp,
      });
    }
  }
  return result;
}
