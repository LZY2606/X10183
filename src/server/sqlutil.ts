/**
 * node:sqlite 将 INTEGER 列以 bigint 返回；本应用的 id/时间值均在安全整数范围内，
 * 统一在边界转换为 number，避免散落到业务代码。
 */
export function row<T = Record<string, unknown>>(r: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out as T;
}

export function rows<T = Record<string, unknown>>(list: Record<string, unknown>[]): T[] {
  return list.map((r) => row<T>(r));
}
