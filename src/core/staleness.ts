/**
 * Staleness: when a DBC revision appears, only decodes whose frame hardware
 * timestamp falls inside the revision's effective interval become stale.
 * Frozen investigation snapshots keep pointing at the old definition and are
 * never marked stale.
 */

export interface EffectiveInterval {
  /** inclusive */
  from: number;
  /** exclusive; null = open ended */
  to: number | null;
}

export function inInterval(t: number, iv: EffectiveInterval): boolean {
  return t >= iv.from && (iv.to === null || t < iv.to);
}

export interface DecodeRecordLike {
  frameHwTimestamp: number;
  dbcVersionId: number;
  snapshotId: number | null;
}

/**
 * A decode is stale iff it is not frozen in a snapshot, and some other DBC
 * version's effective interval covers the frame's hardware timestamp.
 */
export function isStale(
  decode: DecodeRecordLike,
  governingIntervals: { dbcVersionId: number; interval: EffectiveInterval }[],
): boolean {
  if (decode.snapshotId !== null) return false;
  return governingIntervals.some(
    (g) => g.dbcVersionId !== decode.dbcVersionId && inInterval(decode.frameHwTimestamp, g.interval),
  );
}
