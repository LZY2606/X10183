import { api } from './api.js';
import { timelineView } from './views/timeline.js';
import { signalsView } from './views/signals.js';
import { countersView } from './views/counters.js';
import { crcView } from './views/crc.js';
import { compareView } from './views/compare.js';
import { importView } from './views/imports.js';
import { snapshotView } from './views/snapshots.js';

const TABS = [
  { id: 'timeline', label: '帧时间轴', render: timelineView },
  { id: 'signals', label: '信号曲线 / Bit 布局', render: signalsView },
  { id: 'counters', label: '计数器缺口', render: countersView },
  { id: 'crc', label: 'CRC 证据', render: crcView },
  { id: 'compare', label: 'DBC 版本比较', render: compareView },
  { id: 'imports', label: '导入', render: importView },
  { id: 'snapshots', label: '调查快照', render: snapshotView }
] as const;

export function toast(msg: string, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

export async function mountApp(root: HTMLElement) {
  const state = await api('/api/state');
  root.innerHTML = `
    <header class="topbar">
      <h1>总线刻度</h1>
      <span class="sub">按采集时点重放 CAN trace · ${state.frameCount} 帧 · ${state.dbcs.length} 个 DBC 版本</span>
    </header>
    <nav class="tabs">${TABS.map((t) => `<button data-tab="${t.id}">${t.label}</button>`).join('')}</nav>
    <main id="view"></main>`;

  const nav = root.querySelector('nav.tabs')!;
  const view = root.querySelector<HTMLElement>('#view')!;

  const activate = (id: string) => {
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    const tab = TABS.find((t) => t.id === id)!;
    view.innerHTML = '';
    tab.render(view).catch((e) => {
      view.innerHTML = `<div class="panel fail">加载失败：${String(e?.message ?? e)}</div>`;
    });
  };
  nav.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
    if (b) activate(b.dataset.tab!);
  });
  activate('timeline');
}
