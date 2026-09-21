/** 极简 DOM 构造工具 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(c as Node | string);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmtHex(n: number, pad = 3): string {
  return '0x' + n.toString(16).toUpperCase().padStart(pad, '0');
}

export function fmtBytes(data: number[]): string {
  return data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number, w = 2) => String(x).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function fmtNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 10000) / 10000);
}

export function badge(text: string, kind: 'ok' | 'warn' | 'bad' | 'info'): HTMLElement {
  return h('span', { class: `badge ${kind}`, text });
}

export function verdictBadge(verdict: string): HTMLElement {
  if (verdict === 'pass') return badge('通过', 'ok');
  if (verdict === 'fail') return badge('失败', 'bad');
  return badge('未核验', 'warn');
}
