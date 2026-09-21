export interface CounterFrame {
  timestamp: number;
  arbitrationId: number;
  dataHex: string;
  counterValue: number;
}

export interface CounterFinding {
  node: string;
  message: string;
  signal: string;
  generation: number;
  type: 'wrap' | 'duplicate' | 'gap';
  timestamp: number;
  previous: number;
  current: number;
  missingCount: number;
}

/**
 * Check a counter signal for wraparound, duplicates and gaps.
 * Frames are sorted by (timestamp, arbitrationId, dataHex) so results are
 * independent of import order.
 */
export function checkCounter(
  node: string,
  message: string,
  signal: string,
  generation: number,
  bitLength: number,
  frames: CounterFrame[]
): CounterFinding[] {
  const sorted = [...frames].sort(
    (a, b) =>
      a.timestamp - b.timestamp ||
      a.arbitrationId - b.arbitrationId ||
      (a.dataHex < b.dataHex ? -1 : a.dataHex > b.dataHex ? 1 : 0)
  );
  const mod = 2 ** bitLength;
  const findings: CounterFinding[] = [];
  const push = (
    type: CounterFinding['type'],
    timestamp: number,
    previous: number,
    current: number,
    missingCount: number
  ) => findings.push({ node, message, signal, generation, type, timestamp, previous, current, missingCount });

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].counterValue;
    const cur = sorted[i].counterValue;
    const expected = (prev + 1) % mod;
    if (cur === prev) {
      push('duplicate', sorted[i].timestamp, prev, cur, 0);
    } else if (cur === expected) {
      if (cur === 0 && prev === mod - 1) push('wrap', sorted[i].timestamp, prev, cur, 0);
    } else {
      push('gap', sorted[i].timestamp, prev, cur, (cur - expected + mod) % mod);
    }
  }
  return findings;
}
