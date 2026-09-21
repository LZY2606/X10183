import type { DbcVersion, MessageDef } from "./types";

/**
 * 生效区间为半开 [from, to)。同一 (arbId, kind) 的区间不允许重叠；
 * 若导入时出现重叠，按版本 id 较小者生效，并把重叠信息暴露给调用方拒绝写入。
 */
export interface EffectiveAt {
  version: DbcVersion;
}

export function versionCovers(v: Pick<DbcVersion, "effectiveFrom" | "effectiveTo">, t: number): boolean {
  return t >= v.effectiveFrom && (v.effectiveTo === null || t < v.effectiveTo);
}

/** 检查同一键的版本区间是否重叠（null = 开放）。 */
export function rangesOverlap(
  a: { effectiveFrom: number; effectiveTo: number | null },
  b: { effectiveFrom: number; effectiveTo: number | null },
): boolean {
  const aEnd = a.effectiveTo ?? Number.POSITIVE_INFINITY;
  const bEnd = b.effectiveTo ?? Number.POSITIVE_INFINITY;
  return a.effectiveFrom < bEnd && b.effectiveFrom < aEnd;
}

/** 在一组版本中按采集时点选取唯一生效版本；无匹配返回 null（端点 to 不包含）。 */
export function selectVersionAt(versions: DbcVersion[], t: number): DbcVersion | null {
  const covers = versions.filter((v) => versionCovers(v, t));
  if (covers.length === 0) return null;
  // 不变量保证无重叠；防御性地取 id 最小。
  covers.sort((a, b) => a.id - b.id);
  return covers[0];
}

export function messageKey(arbId: number, kind: "std" | "ext"): string {
  return `${kind}:${arbId}`;
}

export function findMessage(
  messagesByVersion: Map<number, MessageDef[]>,
  versionId: number,
  arbId: number,
  kind: "std" | "ext",
): MessageDef | null {
  const list = messagesByVersion.get(versionId) ?? [];
  return list.find((m) => m.arbId === arbId && m.kind === kind) ?? null;
}
