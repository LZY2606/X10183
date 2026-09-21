export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error ?? res.statusText), { status: res.status, body });
  return body as T;
}

export function hexId(canId: number, isExtended: boolean): string {
  return '0x' + canId.toString(16).toUpperCase().padStart(isExtended ? 8 : 3, '0') + (isExtended ? 'x' : '');
}
