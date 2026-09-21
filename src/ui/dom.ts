// 总线刻度 — 极简 DOM 构建助手
export type Child = Node | string | number | false | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as (e: Event) => void);
    } else if (k === 'value') {
      (el as HTMLInputElement).value = String(v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement): HTMLElement {
  el.replaceChildren();
  return el;
}

export function fmtHexId(arbId: number, kind: 'std' | 'ext'): string {
  const w = kind === 'ext' ? 8 : 3;
  return `0x${arbId.toString(16).toUpperCase().padStart(w, '0')}${kind === 'ext' ? ' X' : ''}`;
}

export function fmtTime(ns: number): string {
  if (Math.abs(ns) >= 1_000_000) return `${(ns / 1_000_000).toFixed(3)} ms`;
  if (Math.abs(ns) >= 1_000) return `${(ns / 1_000).toFixed(1)} µs`;
  return `${ns} ns`;
}

export function fmtBytes(b64: string): string {
  const bin = atob(b64);
  return [...Array.from(bin, (c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))].join(' ');
}

export function badge(text: string, cls: string): HTMLElement {
  return h('span', { class: `badge ${cls}` }, text);
}
