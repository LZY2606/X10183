// 总线刻度 — 前端 API 客户端
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.error ?? `请求失败 ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => call<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    call<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T,>(path: string, body?: unknown) =>
    call<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: <T,>(path: string, body?: unknown) =>
    call<T>(path, { method: 'DELETE', body: JSON.stringify(body ?? {}) })
};
