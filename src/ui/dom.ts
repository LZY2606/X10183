type Attrs = Record<string, string | number | boolean | undefined | (() => void)>;
type Kids = (Node | string | null | undefined | false)[];

export function el(tag: 'input', attrs?: Attrs, ...kids: Kids): HTMLInputElement;
export function el(tag: 'select', attrs?: Attrs, ...kids: Kids): HTMLSelectElement;
export function el(tag: 'textarea', attrs?: Attrs, ...kids: Kids): HTMLTextAreaElement;
export function el(tag: 'svg', attrs?: Attrs, ...kids: Kids): SVGSVGElement;
export function el(tag: string, attrs?: Attrs, ...kids: Kids): HTMLElement;
export function el(
  tag: string,
  attrs: Attrs = {},
  ...children: Kids
): Element {
  const svgTags = new Set(['svg', 'text', 'line', 'path', 'circle', 'rect', 'g', 'polyline', 'polygon']);
  const node = (svgTags.has(tag)
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag)) as HTMLElement;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    }
    else if (k === 'className' || k === 'class') node.setAttribute('class', String(v));
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export function clear(node: HTMLElement): HTMLElement {
  node.replaceChildren();
  return node;
}

export function fmtId(arbId: number, extended: boolean): string {
  const hex = arbId.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0');
  return `0x${hex}`;
}

export function fmtTime(t: number): string {
  return t.toFixed(6);
}

export function fmtNum(n: number | null): string {
  if (n === null) return '—';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const box = document.createElement('div');
  box.className = `toast ${kind === 'error' ? 'error' : ''}`;
  box.textContent = message;
  document.body.append(box);
  setTimeout(() => box.remove(), 4000);
}
