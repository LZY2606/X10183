import { renderTimeline } from './views/timeline';
import { renderCounters } from './views/counters';
import { renderCrcs } from './views/crcs';
import { renderVersions } from './views/versions';
import { renderCompare } from './views/compare';
import { renderInvestigations } from './views/investigations';
import { renderImport } from './views/import';

const tabs: Array<{ id: string; label: string; render: (root: HTMLElement) => Promise<void> | void }> = [
  { id: 'timeline', label: '帧时间轴', render: renderTimeline },
  { id: 'counters', label: '计数器缺口', render: renderCounters },
  { id: 'crcs', label: 'CRC 证据', render: renderCrcs },
  { id: 'versions', label: 'DBC 版本', render: renderVersions },
  { id: 'compare', label: '版本对比 / 迁移', render: renderCompare },
  { id: 'investigations', label: '调查快照', render: renderInvestigations },
  { id: 'import', label: '导入 trace', render: renderImport },
];

function shell() {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">🚌 <b>总线刻度</b><span class="sub">按采集时点重放并解释 CAN 信号</span></div>
      <nav class="tabs">${tabs.map((t, i) => `<button data-tab="${t.id}" class="${i === 0 ? 'active' : ''}">${t.label}</button>`).join('')}</nav>
    </header>
    <main id="view" class="view"></main>
  `;
  const view = app.querySelector<HTMLElement>('#view')!;
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => {
      app.querySelectorAll('[data-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = tabs.find((t) => t.id === btn.dataset.tab)!;
      void tab.render(view);
    }),
  );
  return view;
}

shell();
void tabs[0].render(document.querySelector<HTMLElement>('#view')!);
