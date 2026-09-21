export interface CounterFrame {
  id: number;
  node: string;
  generation: number;
  hwTimeNs: number;
  counterRaw: number;
  width: number;
}

export type CounterIssueKind =
  | 'wrap'
  | 'repeat'
  | 'gap'
  | 'duplicate-timestamp';

export interface CounterEvent {
  kind: CounterIssueKind;
  node: string;
  generation: number;
  prevId: number | null;
  frameId: number;
  prevTimeNs: number | null;
  timeNs: number;
  prevValue: number | null;
  value: number | null;
  expected: number | null;
  detail: string;
}

export interface CounterSeries {
  key: string;
  node: string;
  generation: number;
  frameIds: number[];
  events: CounterEvent[];
}

/**
 * 按 (节点, 采集代次) 分组，检查计数器环绕、重复、缺帧与重复时间戳。
 * 同时间戳按帧 id 排序（确定性，与导入顺序无关）。
 */
export function analyzeCounters(
  frames: CounterFrame[],
): CounterSeries[] {
  const groups = new Map<string, CounterFrame[]>();
  for (const f of frames) {
    const key = `${f.node}#${f.generation}`;
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }

  const series: CounterSeries[] = [];
  for (const [key, arr] of groups) {
    const sorted = [...arr].sort(
      (a, b) => a.hwTimeNs - b.hwTimeNs || a.id - b.id,
    );
    const events: CounterEvent[] = [];
    let prev: CounterFrame | null = null;
    for (const f of sorted) {
      if (prev) {
        if (f.hwTimeNs === prev.hwTimeNs) {
          events.push({
            kind: 'duplicate-timestamp',
            node: f.node,
            generation: f.generation,
            prevId: prev.id,
            frameId: f.id,
            prevTimeNs: prev.hwTimeNs,
            timeNs: f.hwTimeNs,
            prevValue: prev.counterRaw,
            value: f.counterRaw,
            expected: null,
            detail: `节点 ${f.node} 代次 ${f.generation} 在 ${f.hwTimeNs}ns 出现重复时间戳`,
          });
        }
        const modulus = 2 ** f.width;
        const expected = (prev.counterRaw + 1) % modulus;
        if (f.counterRaw === prev.counterRaw) {
          events.push({
            kind: 'repeat',
            node: f.node,
            generation: f.generation,
            prevId: prev.id,
            frameId: f.id,
            prevTimeNs: prev.hwTimeNs,
            timeNs: f.hwTimeNs,
            prevValue: prev.counterRaw,
            value: f.counterRaw,
            expected,
            detail: `计数器重复 ${f.counterRaw}（期望 ${expected}）`,
          });
        } else if (f.counterRaw === expected) {
          // 正常；恰好到 0 时记一次环绕证据
          if (f.counterRaw === 0 && prev.counterRaw === modulus - 1) {
            events.push({
              kind: 'wrap',
              node: f.node,
              generation: f.generation,
              prevId: prev.id,
              frameId: f.id,
              prevTimeNs: prev.hwTimeNs,
              timeNs: f.hwTimeNs,
              prevValue: prev.counterRaw,
              value: f.counterRaw,
              expected,
              detail: `${f.width} bit 计数器在 ${modulus - 1} → 0 正常环绕`,
            });
          }
        } else {
          const missing = (f.counterRaw - expected + modulus) % modulus;
          events.push({
            kind: 'gap',
            node: f.node,
            generation: f.generation,
            prevId: prev.id,
            frameId: f.id,
            prevTimeNs: prev.hwTimeNs,
            timeNs: f.hwTimeNs,
            prevValue: prev.counterRaw,
            value: f.counterRaw,
            expected,
            detail: `计数器缺帧：期望 ${expected}，实际 ${f.counterRaw}，约缺 ${missing} 帧`,
          });
        }
      }
      prev = f;
    }
    series.push({
      key,
      node: arr[0].node,
      generation: arr[0].generation,
      frameIds: sorted.map((f) => f.id),
      events,
    });
  }
  return [...series].sort((a, b) => a.key.localeCompare(b.key));
}
