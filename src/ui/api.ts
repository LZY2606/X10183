export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const fmtNs = (ns: number): string => {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(3)} ms`;
  if (ns >= 1000) return `${(ns / 1000).toFixed(1)} µs`;
  return `${ns} ns`;
};

export const fmtId = (id: number, extended: boolean): string =>
  `${extended ? 'x' : 's'} 0x${id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0')}`;
