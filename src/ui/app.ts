import { el, clear, toast } from './dom.js';
import { api } from '../api.js';
import { importView } from './import.js';
import { explorerView } from './explorer.js';
import { versionsView } from './versions.js';
import { countersView } from './counters.js';
import { checksumsView } from './checksums.js';
import { compareView } from './compare.js';
import { snapshotsView } from './snapshots.js';
import type { DbcVersion } from '../types.js';

export interface AppState {
  dbcs: DbcVersion[];
  stale: number;
  importCount: number;
  selectedFrameId: number | null;
}

type Tab = 'explorer' | 'import' | 'versions' | 'counters' | 'crc' | 'compare' | 'snapshots';
const TAB_IDS: Tab[] = ['explorer', 'import', 'versions', 'counters', 'crc', 'compare', 'snapshots'];
const fromHash = (): Tab => {
  const h = location.hash.replace(/^#\/?/, '') as Tab;
  return TAB_IDS.includes(h) ? h : 'explorer';
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'explorer', label: '时间轴 / 帧' },
  { id: 'import', label: '导入' },
  { id: 'versions', label: 'DBC 版本' },
  { id: 'counters', label: '计数器缺口' },
  { id: 'crc', label: 'CRC 证据' },
  { id: 'compare', label: '版本比较 / 迁移' },
  { id: 'snapshots', label: '调查快照' }
];

export function mountApp(root: HTMLDivElement): void {
  let tab: Tab = fromHash();
  const state: AppState = { dbcs: [], stale: 0, importCount: 0, selectedFrameId: null };

  async function refresh(soft = false): Promise<void> {
    try {
      const s = await api.get<{ dbcs: DbcVersion[]; stale: number; imports: unknown[] }>('/api/state');
      state.dbcs = s.dbcs;
      state.stale = s.stale;
      state.importCount = s.imports.length;
      if (!soft) render();
      else renderChrome();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  const header = el('header', { class: 'topbar' }) as HTMLElement;
  const main = el('main') as HTMLElement;

  function renderChrome(): void {
    clear(header);
    header.append(
      el('div', { class: 'brand' }, '总线刻度', el('small', {}, 'CAN trace × 版本化 DBC 重放')),
      el(
        'nav',
        { class: 'tabs' },
        ...TABS.map((t) =>
          el(
            'button',
            {
              class: t.id === tab ? 'active' : '',
              onclick: () => {
                tab = t.id;
                location.hash = `/${t.id}`;
                render();
              }
            },
            t.label
          )
        )
      ),
      el('div', { class: 'spacer' }),
      el('span', { class: 'badge' }, `DBC ${state.dbcs.length}`),
      el('span', { class: 'badge' }, `采集 ${state.importCount}`),
      state.stale > 0 ? el('span', { class: 'badge warn', title: 'DBC 生效区间修订后需要重新解码' }, `过期解码 ${state.stale}`) : el('span', { class: 'badge' }, '解码最新')
    );
  }

  const ctx = {
    state,
    refresh,
    selectFrame(id: number) {
      state.selectedFrameId = id;
      render();
    },
    toast
  };

  function render(): void {
    renderChrome();
    clear(main);
    const view =
      tab === 'import'
        ? importView(ctx)
        : tab === 'versions'
          ? versionsView(ctx)
          : tab === 'counters'
            ? countersView(ctx)
            : tab === 'crc'
              ? checksumsView(ctx)
              : tab === 'compare'
                ? compareView(ctx)
                : tab === 'snapshots'
                  ? snapshotsView(ctx)
                  : explorerView(ctx);
    main.append(view);
  }

  render();
  window.addEventListener('hashchange', () => {
    tab = fromHash();
    render();
  });
  void refresh();
  root.append(header, main);
}

export interface ViewContext {
  state: AppState;
  refresh: (soft?: boolean) => Promise<void>;
  selectFrame: (id: number) => void;
  toast: (msg: string, kind?: 'info' | 'error') => void;
}
