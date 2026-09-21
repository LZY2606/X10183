import type { StoredFrame } from './types.js';

export interface CounterConfig {
  id: number;
  messageId: number;
  isExtended: boolean;
  node: string;
  signalName: string;
  modulus: number; // 2^bitLength, e.g. 16 for a 4-bit counter
  increment: number;
}

export type CounterKind = 'wrap' | 'repeat' | 'missing' | 'ok';

export interface CounterEvent {
  frameId: number;
  contentHash?: string;
  hwTime: number;
  generation: number;
  kind: CounterKind;
  duplicateTimestamp: boolean;
  expected?: number;
  actual: number;
  missingCount?: number;
}

export interface CounterReport {
  key: string;
  node: string;
  generation: number;
  events: CounterEvent[];
  wraps: number;
  repeats: number;
  missing: number;
  duplicateTimestamps: number;
  checkedFrames: number;
}

export interface CounterFrame extends StoredFrame {
  counterRaw: number | null;
  contentHash?: string;
}

/**
 * Counters are checked per node + acquisition generation. Frames are
 * canonicalized to (hwTime, frameId, counter value) before checking, so the
 * result is identical no matter what order batches were imported in.
 */
export function analyzeCounter(frames: CounterFrame[], config: CounterConfig): CounterReport[] {
  const groups = new Map<string, CounterFrame[]>();
  for (const frame of frames) {
    if (frame.counterRaw === null) continue;
    const gk = `${config.node}#${frame.generation}`;
    const arr = groups.get(gk);
    if (arr) arr.push(frame);
    else groups.set(gk, [frame]);
  }

  const reports: CounterReport[] = [];
  for (const [gk, arr] of groups) {
    const [node, generationStr] = gk.split('#');
    const generation = Number(generationStr);
    arr.sort((a, b) => a.hwTime - b.hwTime || (a.contentHash ?? '').localeCompare(b.contentHash ?? '') || (a.counterRaw as number) - (b.counterRaw as number));

    const report: CounterReport = {
      key: `${config.messageId}:${config.isExtended ? 1 : 0}:${node}:gen${generation}`,
      node,
      generation,
      events: [],
      wraps: 0,
      repeats: 0,
      missing: 0,
      duplicateTimestamps: 0,
      checkedFrames: 0,
    };

    let prev: CounterFrame | null = null;
    for (const frame of arr) {
      report.checkedFrames++;
      const actual = frame.counterRaw as number;
      let kind: CounterKind = 'ok';
      let expected: number | undefined;
      let missingCount: number | undefined;
      const duplicateTimestamp = prev !== null && frame.hwTime === prev.hwTime;
      if (duplicateTimestamp) report.duplicateTimestamps++;

      if (prev) {
        expected = (prev.counterRaw as number) + config.increment;
        if (actual === prev.counterRaw) {
          kind = 'repeat';
          report.repeats++;
        } else if (actual % config.modulus === expected % config.modulus && actual < (prev.counterRaw as number)) {
          // boundary step, e.g. 15 -> 0
          kind = 'wrap';
          report.wraps++;
        } else if (actual === expected) {
          kind = 'ok';
        } else {
          const prevRaw = prev.counterRaw as number;
          if (actual < prevRaw) {
            kind = 'wrap';
            report.wraps++;
            const steps = actual + config.modulus - prevRaw;
            missingCount = steps - config.increment;
          } else {
            kind = 'missing';
            missingCount = actual - prevRaw - config.increment;
          }
          report.missing += missingCount;
        }
      }

      report.events.push({
        frameId: frame.frameId,
        contentHash: frame.contentHash,
        hwTime: frame.hwTime,
        generation,
        kind,
        duplicateTimestamp,
        expected,
        actual,
        missingCount,
      });
      prev = frame;
    }
    reports.push(report);
  }

  reports.sort((a, b) => a.key.localeCompare(b.key));
  for (const report of reports) {
    report.events.sort((a, b) => a.hwTime - b.hwTime || (a.contentHash ?? '').localeCompare(b.contentHash ?? ''));
  }
  return reports;
}

export function summarizeReports(reports: CounterReport[]) {
  return {
    groups: reports.length,
    wraps: reports.reduce((n, r) => n + r.wraps, 0),
    repeats: reports.reduce((n, r) => n + r.repeats, 0),
    missing: reports.reduce((n, r) => n + r.missing, 0),
    duplicateTimestamps: reports.reduce((n, r) => n + r.duplicateTimestamps, 0),
    checkedFrames: reports.reduce((n, r) => n + r.checkedFrames, 0),
  };
}
