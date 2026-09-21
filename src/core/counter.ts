/**
 * Rolling-counter integrity checks, grouped per node and import generation.
 * Frames must be supplied in deterministic order (hw timestamp, then a stable
 * tiebreak) so results do not depend on ingestion order.
 */

export interface CounterSample {
  /** stable frame identity used only for deterministic ordering */
  frameKey: string;
  hwTimestamp: number;
  value: number;
}

export type CounterEventType = "wrap" | "duplicate" | "missing";

export interface CounterEvent {
  type: CounterEventType;
  atTimestamp: number;
  prevValue: number;
  value: number;
  /** number of missing counter steps, only for type 'missing' */
  missingCount: number;
}

export interface CounterReport {
  total: number;
  events: CounterEvent[];
  ok: boolean;
}

export function checkCounter(samples: CounterSample[], modulus: number): CounterReport {
  const events: CounterEvent[] = [];
  const ordered = [...samples].sort(
    (a, b) => a.hwTimestamp - b.hwTimestamp || a.frameKey.localeCompare(b.frameKey),
  );
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const step = (cur.value - prev.value + modulus) % modulus;
    if (step === 0) {
      events.push({
        type: "duplicate",
        atTimestamp: cur.hwTimestamp,
        prevValue: prev.value,
        value: cur.value,
        missingCount: 0,
      });
    } else if (step === 1) {
      if (cur.value < prev.value) {
        events.push({
          type: "wrap",
          atTimestamp: cur.hwTimestamp,
          prevValue: prev.value,
          value: cur.value,
          missingCount: 0,
        });
      }
    } else {
      events.push({
        type: "missing",
        atTimestamp: cur.hwTimestamp,
        prevValue: prev.value,
        value: cur.value,
        missingCount: step - 1,
      });
      if (cur.value < prev.value) {
        // The gap spans a wrap boundary; record the wrap as well.
        events.push({
          type: "wrap",
          atTimestamp: cur.hwTimestamp,
          prevValue: prev.value,
          value: cur.value,
          missingCount: 0,
        });
      }
    }
  }
  return { total: ordered.length, events, ok: events.every((e) => e.type === "wrap") };
}
