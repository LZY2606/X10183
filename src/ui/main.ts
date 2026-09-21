// 总线刻度 — 前端入口与视图编排
import './style.css';
import { h, clear, fmtHexId, fmtTime, fmtBytes, badge, type Child } from './dom.js';
import { bitGrid, bitEvidence, lineChart, signalColor } from './components.js';
import { api } from './api.js';
import type {
  CounterReport, CrcReport, DbcVersion, FrameDecode,
  VersionCompare, Snapshot
} from '../shared/types.js';

const app = document.querySelector<HTMLDivElement>('#app')!;

interface State {
  tab: string;
  versions: DbcVersion[];
  decodes: FrameDecode[];
  selectedFrame: number | null;
  filterGen: string;
  filterId: string;
  signalKey: string;
  gen: number | undefined;
  counters: CounterReport[];
  crc: CrcReport[];
  compare: VersionCompare | null;
  snapshots: Omit<Snapshot, 'payload'>[];
}

const state: State = {
  tab: 'timeline',
  versions: [],
  decodes: [],
  selectedFrame: null,
  filterGen: '',
  filterId: '',
  signalKey: '',
  gen: undefined,
  counters: [],
  crc: [],
  compare: null,
  snapshots: []
};

function header(): HTMLElement {
  const tabs: [string, string][] = [
    ['timeline', '帧时间轴'],
    ['signals', '信号曲线'],
    ['counters', '计数器缺口'],
    ['crc', 'CRC 证据'],
    ['versions', '版本对比 / 迁移'],
    ['snapshots', '调查快照']
  ];
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' },
      h('span', { class: 'logo' }, '▮▮'),
      h('h1', {}, '总线刻度'),
      h('span', { class: 'sub' }, 'CAN trace × 版本化 DBC 重放')
    ),
    h('nav', { class: 'tabs' },
      ...tabs.map(([id, label]) =>
        h('button', {
          class: `tab ${state.tab === id ? 'active' : ''}`,
          onClick: () => { state.tab = id; void refresh(); }
        }, label)
      )
    ),
    h('div', { class: 'tools' },
      h('button', { class: 'btn ghost', onClick: () => void(redecode()) }, '重新解码'),
      h('button', { class: 'btn ghost', onClick: () => void(importDemo()) }, '追加演示批次')
    )
  );
}

async function importDemo() {
  const label = window.prompt('新采集代次标签', `追加导入 ${new Date().toLocaleTimeString()}`);
  if (label === null) return;
  const frames = [
    { channel: 0, arbId: 0x100, idKind: 'std', data: '4A1F78D1E0000000', hwTimeNs: Date.now() * 1e6 }
  ];
  try {
    await api.post('/api/imports', { label, frames });
    await api.post('/api/redecode', {});
    await refresh();
    toast(`已导入代次「${label}」`);
  } catch (e) {
    toast((e as Error).message, true);
  }
}

async function redecode() {
  const stats = await api.post<{ decoded: number; unmatched: number; stale: number }>('/api/redecode', {});
  await refresh();
  toast(`重放完成：解码 ${stats.decoded}，未匹配 ${stats.unmatched}，过期 ${stats.stale}`);
}

function toast(msg: string, error = false) {
  const t = h('div', { class: `toast ${error ? 'err' : ''}` }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

async function loadCommon() {
  state.versions = await api.get<DbcVersion[]>('/api/versions');
  const q = new URLSearchParams();
  if (state.filterGen) q.set('generation', state.filterGen);
  if (state.filterId) q.set('arbId', state.filterId);
  state.decodes = await api.get<FrameDecode[]>(`/api/decodes?${q.toString()}`);
  state.snapshots = await api.get<Omit<Snapshot, 'payload'>[]>('/api/snapshots');
}

async function refresh() {
  await loadCommon();
  if (state.tab === 'counters') {
    const q = state.filterGen ? `?generation=${state.filterGen}` : '';
    state.counters = await api.get<CounterReport[]>(`/api/analysis/counters${q}`);
  }
  if (state.tab === 'crc') {
    const q = state.filterGen ? `?generation=${state.filterGen}` : '';
    state.crc = await api.get<CrcReport[]>(`/api/analysis/crc${q}`);
  }
  render();
}

function render() {
  clear(app);
  app.append(header());
  const main = h('main', { class: 'content' });
  app.append(main);
  switch (state.tab) {
    case 'timeline': main.append(timelineView()); break;
    case 'signals': main.append(signalsView()); break;
    case 'counters': main.append(countersView()); break;
    case 'crc': main.append(crcView()); break;
    case 'versions': main.append(versionsView()); break;
    case 'snapshots': main.append(snapshotsView()); break;
  }
}

function filterBar(onChange: () => void): HTMLElement {
  const gens = [...new Set(state.decodes.map((d) => d.generation))].sort((a, b) => a - b);
  return h('div', { class: 'filterbar' },
    h('label', {}, '代次 ',
      selectEl(['', ...gens.map(String)], state.filterGen, (v) => { state.filterGen = v; onChange(); })),
    h('label', {}, 'ID ',
      textEl(state.filterId, '如 0x100 / 256 / ext', (v) => { state.filterId = v; onChange(); }, 14)),
    h('span', { class: 'muted' }, `共 ${state.decodes.length} 条解码`)
  );
}

function selectEl(options: string[], value: string, onInput: (v: string) => void) {
  return h('select', {
    onChange: (e) => onInput((e.target as HTMLSelectElement).value)
  }, ...options.map((o) => h('option', { value: o, ...(o === value ? { selected: true } : {}) },
    o === '' ? '全部' : `G${o}`)));
}

function textEl(value: string, placeholder: string, onInput: (v: string) => void, size = 20) {
  return h('input', {
    type: 'text', value, placeholder, size: String(size),
    onChange: (e) => onInput((e.target as HTMLInputElement).value)
  });
}

function versionLabel(id: number): string {
  return state.versions.find((v) => v.id === id)?.label ?? `#${id}`;
}

// ---- 视图 1：帧时间轴 + 解码详情 ----------------------------------------
function timelineView(): Child {
  const detail = state.decodes.find((d) => d.frameId === state.selectedFrame) ?? state.decodes[0];
  return h('div', { class: 'split' },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-h' }, filterBar(() => void(refresh()) )),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'grid' },
          h('thead', {}, h('tr', {},
            h('th', {}, '硬件时间'), h('th', {}, '代次'), h('th', {}, '通道'),
            h('th', {}, 'Arbitration ID'), h('th', {}, '消息'), h('th', {}, '版本'),
            h('th', {}, 'DLC'), h('th', {}, '数据'), h('th', {}, '状态'))),
          h('tbody', {},
            ...state.decodes.slice(0, 400).map((d) =>
              h('tr', {
                class: `row ${detail?.frameId === d.frameId ? 'sel' : ''}`,
                onClick: () => { state.selectedFrame = d.frameId; render(); }
              },
                h('td', { class: 'mono' }, fmtTime(d.hwTimeNs)),
                h('td', { class: 'mono' }, `G${d.generation}`),
                h('td', { class: 'mono' }, String(d.channel)),
                h('td', { class: 'mono' }, fmtHexId(d.arbId, d.idKind)),
                h('td', {}, d.messageName),
                h('td', { class: 'mono small' }, versionLabel(d.versionId)),
                h('td', { class: 'mono' }, String(d.dlc)),
                h('td', { class: 'mono small' }, fmtBytes(d.dataB64)),
                h('td', {}, d.staleReason
                  ? badge('过期', 'warn')
                  : badge('现行', 'ok'))
              )
            )
          )
        )
      )
    ),
    h('section', { class: 'panel detail' }, detail ? decodeDetail(detail) : h('p', { class: 'muted' }, '没有可显示的解码'))
  );
}

function decodeDetail(d: FrameDecode): Child {
  const staleMap: Record<string, string> = {
    'message-removed': '消息定义已从当前生效版本移除',
    moved: '该时间点现由其他 DBC 版本生效',
    changed: '信号定义已修订（布局/缩放/枚举等）'
  };
  return [
    h('div', { class: 'panel-h' },
      h('div', {},
        h('h2', {}, `${d.messageName} `, h('span', { class: 'mono small' }, fmtHexId(d.arbId, d.idKind))),
        h('div', { class: 'muted small' },
          `采用 ${versionLabel(d.versionId)} · 帧 #${d.frameId} · ${fmtTime(d.hwTimeNs)} · G${d.generation} · 通道 ${d.channel}`
        )
      ),
      d.staleReason ? badge('过期解码', 'warn') : badge('现行定义', 'ok')
    ),
    d.staleReason ? h('div', { class: 'note warn-note' }, staleMap[d.staleReason]) : null,
    h('div', { class: 'detail-grid' },
      h('div', {},
        h('h3', {}, 'Bit 布局（可追溯到确切 bit 区间）'),
        bitGrid(d.signals, d.dlc)
      )
    ),
    h('h3', {}, '信号解码'),
    h('div', { class: 'sig-cards' },
      ...d.signals.map((s, i) => h('div', {
        class: `sig-card ${s.muxSkipped ? 'mux-skip' : ''}`,
        style: `border-left-color:${signalColor(i)}`
      },
        h('div', { class: 'sig-head' },
          h('strong', {}, s.signalName),
          h('span', { class: 'muted small' },
            `${s.byteOrder === 0 ? 'Motorola' : 'Intel'} · start=${s.startBit} · len=${s.length}${s.signed ? ' · 有符号' : ''}`),
          s.role === 'counter' ? badge('计数器', 'info') : null,
          s.role === 'crc' ? badge('CRC', 'info') : null,
          s.muxType === 'Mux' ? badge('Mux 开关', 'info') : null,
          typeof s.muxType === 'string' && s.muxType !== 'Mux' ? badge(`分支 ${s.muxValue}`, 'info') : null,
          s.muxSkipped ? badge('分支未知·保留 raw bits', 'warn') : null
        ),
        h('div', { class: 'sig-vals' },
          h('div', {}, '原始值 ', h('span', { class: 'mono' }, s.rawValue === null ? '—' : `0x${s.rawValue.toString(16).toUpperCase()} (${s.rawValue})`)),
          h('div', {}, '物理值 ', h('span', { class: 'mono strong' }, s.physValue === null ? '—' : String(s.physValue)), ` ${s.unit}`),
          s.enumLabel ? h('div', { class: 'enum' }, '枚举 ', badge(s.enumLabel, 'ok')) : null
        ),
        bitEvidence(s, d.dataB64),
        s.overrun ? h('div', { class: 'note warn-note' }, 'bit 区间超出 DLC') : null
      ))
    )
  ];
}

export { render, refresh, state };

// ---- 视图 2：信号曲线 ----------------------------------------------------
function signalsView(): Child {
  const grouped = new Map<string, FrameDecode[]>();
  for (const d of state.decodes) {
    for (const s of d.signals) {
      const key = `${d.arbId}|${d.idKind}|${s.signalName}`;
      const list = grouped.get(key) ?? [];
      list.push(d);
      grouped.set(key, list);
    }
  }
  const keys = [...grouped.keys()].sort();
  if (!state.signalKey && keys[0]) state.signalKey = keys[0];
  const [arbStr, kind, sigName] = state.signalKey.split('|');
  const current = state.decodes
    .filter((d) => String(d.arbId) === arbStr && d.idKind === kind)
    .map((d) => {
      const s = d.signals.find((x) => x.signalName === sigName);
      if (!s) return null;
      return {
        frameId: d.frameId, hwTimeNs: d.hwTimeNs, generation: d.generation,
        raw: s.rawValue, phys: s.physValue, muxSkipped: s.muxSkipped, enumLabel: s.enumLabel
      };
    })
    .filter(Boolean) as import('../shared/types.js').SignalPoint[];
  const sampleSig = state.decodes
    .flatMap((d) => d.signals.map((s) => ({ d, s })))
    .find(({ d, s }) => String(d.arbId) === arbStr && d.idKind === kind && s.signalName === sigName);
  const unit = sampleSig?.s.unit ?? '';

  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-h' }, filterBar(() => void refresh()))),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-h' },
        h('h2', {}, '信号曲线'),
        h('label', {}, '选择信号 ',
          h('select', {
            onChange: (e) => { state.signalKey = (e.target as HTMLSelectElement).value; render(); }
          }, ...keys.map((k) =>
            h('option', { value: k, ...(k === state.signalKey ? { selected: true } : {}) },
              k.split('|').slice(0, 2).join(' · ') + ' · ' + k.split('|')[2])
          ))
        )
      ),
      lineChart(current, unit),
      h('p', { class: 'muted small' }, '空心橙点：多路复用分支未知，仅保留 raw bits，不产生物理值。')
    )
  );
}

// ---- 视图 3：计数器缺口 --------------------------------------------------
function countersView(): Child {
  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-h' }, filterBar(() => void refresh()))),
    ...state.counters.map((r) => {
      const bad = r.events.filter((e) => e.kind !== 'init');
      return h('section', { class: 'panel' },
        h('div', { class: 'panel-h' },
          h('h2', {}, `${r.messageName}.${r.signalName} `,
            h('span', { class: 'muted small' }, `节点 ${r.node} · 模 ${r.modulus} · 检查 ${r.checked} 帧`)),
          bad.length === 0 ? badge('无缺口', 'ok') : badge(`${bad.length} 个异常`, 'warn')
        ),
        h('div', { class: 'table-wrap' },
          h('table', { class: 'grid' },
            h('thead', {}, h('tr', {},
              h('th', {}, '硬件时间'), h('th', {}, '代次'), h('th', {}, '类型'),
              h('th', {}, '期望'), h('th', {}, '实际'), h('th', {}, '缺帧数'), h('th', {}, '说明'))),
            h('tbody', {}, ...r.events.map((e) =>
              h('tr', {},
                h('td', { class: 'mono' }, fmtTime(e.hwTimeNs)),
                h('td', { class: 'mono' }, `G${e.generation}`),
                h('td', {}, eventBadge(e.kind)),
                h('td', { class: 'mono' }, e.expected === null ? '—' : String(e.expected)),
                h('td', { class: 'mono' }, String(e.actual)),
                h('td', { class: 'mono' }, e.gapCount ? String(e.gapCount) : '—'),
                h('td', { class: 'small' }, e.detail)
              )
            ))
          )
        )
      );
    }),
    state.counters.length === 0 ? h('p', { class: 'muted' }, '没有标记为计数器的信号。') : null
  );
}

function eventBadge(kind: string): Child {
  if (kind === 'wrap') return badge('环绕', 'info');
  if (kind === 'repeat') return badge('重复', 'warn');
  if (kind === 'missing') return badge('缺帧', 'bad');
  return badge('首帧', 'ok');
}

// ---- 视图 4：CRC 证据 ----------------------------------------------------
function crcView(): Child {
  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-h' }, filterBar(() => void refresh()))),
    ...state.crc.map((r) => {
      const pass = r.results.filter((x) => x.status === 'pass').length;
      const fail = r.results.filter((x) => x.status === 'fail').length;
      const unchecked = r.results.filter((x) => x.status === 'unchecked').length;
      const invalid = r.results.filter((x) => x.status === 'invalid').length;
      const cfg = r.config;
      return h('section', { class: 'panel' },
        h('div', { class: 'panel-h' },
          h('h2', {}, `${r.messageName}.${r.signalName} `,
            h('span', { class: 'muted small' }, `节点 ${r.node}`)),
          h('div', { class: 'badges' },
            pass ? badge(`${pass} 通过`, 'ok') : null,
            fail ? badge(`${fail} 失败`, 'bad') : null,
            unchecked ? badge(`${unchecked} 未核验`, 'warn') : null,
            invalid ? badge(`${invalid} 越界`, 'bad') : null,
            (!pass && !fail && !unchecked && !invalid) ? badge('无帧', 'info') : null
          )
        ),
        h('div', { class: 'note' },
          cfg
            ? `规则：覆盖 B${cfg.startByte}..B${cfg.endByte - 1}，多项式 0x${(cfg.polynomial ?? 0x07).toString(16)}，初值 ${cfg.init === null ? '【缺失】' : cfg.init}，异或值 ${cfg.xorOut === null ? '【缺失】' : cfg.xorOut}`
            : '未配置 CRC 规则（覆盖范围/初值/异或值不完整时只能给“未核验”，不能报通过）'
        ),
        h('div', { class: 'table-wrap' },
          h('table', { class: 'grid' },
            h('thead', {}, h('tr', {},
              h('th', {}, '硬件时间'), h('th', {}, '代次'), h('th', {}, '状态'),
              h('th', {}, '帧内'), h('th', {}, '计算'), h('th', {}, '覆盖字节'), h('th', {}, '证据'))),
            h('tbody', {}, ...r.results.slice(0, 200).map((x) =>
              h('tr', {},
                h('td', { class: 'mono' }, fmtTime(x.hwTimeNs)),
                h('td', { class: 'mono' }, `G${x.generation}`),
                h('td', {}, crcBadge(x.status)),
                h('td', { class: 'mono' }, x.expected === null ? '—' : `0x${x.expected.toString(16).toUpperCase().padStart(2, '0')}`),
                h('td', { class: 'mono' }, x.actual === null ? '—' : `0x${x.actual.toString(16).toUpperCase().padStart(2, '0')}`),
                h('td', { class: 'mono small' }, x.coveredBytes.length ? x.coveredBytes.map((b) => `B${b}`).join(',') : '—'),
                h('td', { class: 'small' }, x.reason)
              )
            ))
          )
        )
      );
    }),
    state.crc.length === 0 ? h('p', { class: 'muted' }, '没有标记为 CRC 的信号。') : null
  );
}

function crcBadge(status: string): Child {
  if (status === 'pass') return badge('通过', 'ok');
  if (status === 'fail') return badge('失败', 'bad');
  if (status === 'invalid') return badge('覆盖越界', 'bad');
  return badge('未核验', 'warn');
}

// ---- 视图 5：版本对比 / 迁移审批 -----------------------------------------
let compareA = '';
let compareB = '';

function versionsView(): Child {
  const stale = state.decodes.filter((d) => d.staleReason);
  if (!compareA && state.versions[0]) compareA = String(state.versions[0].id);
  if (!compareB && state.versions[1]) compareB = String(state.versions[1].id);
  if (!compareB && state.versions[0] && !state.versions[1]) compareB = String(state.versions[0].id);

  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-h' }, h('h2', {}, 'DBC 版本与生效区间')),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'grid' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'ID'), h('th', {}, '名称'), h('th', {}, 'revision'),
            h('th', {}, '生效起(ns)'), h('th', {}, '生效止(ns)'), h('th', {}, '说明'))),
          h('tbody', {}, ...state.versions.map((v) =>
            h('tr', {},
              h('td', { class: 'mono' }, String(v.id)),
              h('td', {}, v.label),
              h('td', { class: 'mono' }, String(v.revision)),
              h('td', { class: 'mono' }, v.effectiveFromNs === null ? '-∞' : String(v.effectiveFromNs)),
              h('td', { class: 'mono' }, v.effectiveToNs === null ? '+∞' : String(v.effectiveToNs)),
              h('td', { class: 'small muted' }, v.note ?? ''))
          ))
        )
      )
    ),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-h' },
        h('h2', {}, '比较两个版本对同一批帧的影响'),
        h('div', { class: 'inline' },
          versionSelect(compareA, (v) => { compareA = v; }),
          h('span', {}, ' ⇄ '),
          versionSelect(compareB, (v) => { compareB = v; }),
          h('button', { class: 'btn', onClick: () => void(doCompare()) }, '比较')
        )
      ),
      compareTable(state.compare)
    ),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-h' },
        h('h2', {}, `受生效区间影响的过期解码（${stale.length}）`)),
      stale.length
        ? h('div', { class: 'table-wrap' },
            h('table', { class: 'grid' },
              h('thead', {}, h('tr', {},
                h('th', {}, '时间'), h('th', {}, '帧'), h('th', {}, '旧版本'), h('th', {}, '原因'))),
              h('tbody', {}, ...stale.slice(0, 100).map((d) =>
                h('tr', {},
                  h('td', { class: 'mono' }, fmtTime(d.hwTimeNs)),
                  h('td', { class: 'mono' }, `${fmtHexId(d.arbId, d.idKind)} ${d.messageName}`),
                  h('td', { class: 'small' }, versionLabel(d.versionId)),
                  h('td', { class: 'small' }, staleReasonText(d.staleReason)))
              ))
            )
          )
        : h('p', { class: 'muted' }, '没有过期解码（全部帧按当前版本解释）。')
    )
  );
}

function staleReasonText(reason: string | null): string {
  return reason === 'message-removed' ? '消息已移除'
    : reason === 'moved' ? '生效版本切换'
    : reason === 'changed' ? '信号定义改变' : '';
}

function versionSelect(value: string, onInput: (v: string) => void) {
  return h('select', {
    onChange: (e) => onInput((e.target as HTMLSelectElement).value)
  }, ...state.versions.map((v) =>
    h('option', { value: String(v.id), ...(String(v.id) === value ? { selected: true } : {}) }, v.label)));
}

async function doCompare() {
  try {
    state.compare = await api.get<VersionCompare>(`/api/compare/${compareA}/${compareB}`);
    render();
  } catch (e) {
    toast((e as Error).message, true);
  }
}

function compareTable(c: VersionCompare | null): Child {
  if (!c) return h('p', { class: 'muted' }, '选择两个版本后点击“比较”。');
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'grid' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'ID'), h('th', {}, `A：${c.versionA.label}`),
        h('th', {}, `B：${c.versionB.label}`), h('th', {}, '关系'),
        h('th', {}, '受影响帧数'), h('th', {}, '判定依据'), h('th', {}, '操作'))),
      h('tbody', {}, ...c.entries.map((entry) => {
        const impact = c.frameImpact.find(
          (f) => f.arbId === entry.arbId && f.idKind === entry.idKind
        );
        return h('tr', {},
          h('td', { class: 'mono' }, fmtHexId(entry.arbId, entry.idKind)),
          h('td', {}, entry.messageNameA ?? '—'),
          h('td', {}, entry.messageNameB ?? '—'),
          h('td', {}, relationBadge(entry.relation)),
          h('td', { class: 'mono' }, String(impact?.frameCount ?? 0)),
          h('td', { class: 'small' }, entry.reason),
          h('td', {},
            entry.relation === 'incompatible'
              ? h('button', { class: 'btn mini bad-btn', onClick: () => void(decide(entry.arbId, entry.idKind, 'incompatible')) }, '标记无法兼容')
              : (entry.relation === 'compatible' || entry.relation === 'unchanged')
                ? h('button', { class: 'btn mini', onClick: () => void(decide(entry.arbId, entry.idKind, 'approved')) }, '批准迁移映射')
                : h('span', { class: 'muted small' }, '—'))
        );
      }))
    )
  );
}

function relationBadge(rel: string): Child {
  if (rel === 'unchanged') return badge('完全一致', 'ok');
  if (rel === 'compatible') return badge('可兼容迁移', 'info');
  if (rel === 'incompatible') return badge('无法兼容', 'bad');
  if (rel === 'added') return badge('新增', 'info');
  return badge('移除', 'warn');
}

async function decide(arbId: number, idKind: 'std' | 'ext', status: 'approved' | 'incompatible') {
  try {
    const result = await api.post<{ revision: number }>('/api/migrations', {
      fromVersionId: Number(compareA),
      toVersionId: Number(compareB),
      arbId,
      idKind,
      status,
      expectedRevision: undefined
    });
    toast(`已记录「${status === 'approved' ? '批准迁移' : '无法兼容'}」，revision=${result.revision}`);
  } catch (e) {
    toast((e as Error).message, true);
  }
}

// ---- 视图 6：调查快照（冻结，继续指向旧定义） ---------------------------
let snapshotDetail: Snapshot | null = null;

function snapshotsView(): Child {
  return h('div', { class: 'split' },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-h' },
        h('h2', {}, '冻结的调查快照'),
        h('button', {
          class: 'btn',
          onClick: async () => {
            const label = window.prompt('快照名称', `调查快照 ${new Date().toLocaleString()}`);
            if (!label) return;
            await api.post('/api/snapshots', { label });
            await refresh();
            toast('快照已冻结');
          }
        }, '冻结当前解码')
      ),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'grid' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'ID'), h('th', {}, '名称'), h('th', {}, '创建时间'),
            h('th', {}, '解码数'), h('th', {}, '引用版本'))),
          h('tbody', {}, ...state.snapshots.map((s) =>
            h('tr', {
              class: snapshotDetail?.id === s.id ? 'sel' : '',
              onClick: () => void(openSnapshot(s.id))
            },
              h('td', { class: 'mono' }, String(s.id)),
              h('td', {}, s.label),
              h('td', { class: 'small' }, new Date(s.createdAt).toLocaleString()),
              h('td', { class: 'mono' }, String(s.frameCount)),
              h('td', { class: 'mono small' }, s.versionIds.map((v) => `#${v}`).join(', ')))
          ))
        )
      )
    ),
    h('section', { class: 'panel detail' },
      snapshotDetail ? frozenDetail(snapshotDetail) : h('p', { class: 'muted' }, '点击左侧快照查看冻结内容（DBC 修订后仍保留旧定义与旧解码）。'))
  );
}

async function openSnapshot(id: number) {
  snapshotDetail = await api.get<Snapshot>(`/api/snapshots/${id}`);
  render();
}

function frozenDetail(s: Snapshot): Child {
  return [
    h('div', { class: 'panel-h' },
      h('div', {},
        h('h2', {}, s.label),
        h('div', { class: 'muted small' },
          `冻结于 ${fmtTime(s.payload.frozenAtNs)} · ${s.payload.decodes.length} 条解码 · ` +
          `版本：${s.payload.versions.map((v) => `${v.label}#${v.id}r${v.revision}`).join('；')}`
        )
      )
    ),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'grid' },
        h('thead', {}, h('tr', {},
          h('th', {}, '时间'), h('th', {}, '帧'), h('th', {}, '消息'),
          h('th', {}, '冻结时版本'), h('th', {}, '信号（含 raw/物理值/位区间）'))),
        h('tbody', {}, ...s.payload.decodes.slice(0, 100).map((d) =>
          h('tr', {},
            h('td', { class: 'mono' }, fmtTime(d.hwTimeNs)),
            h('td', { class: 'mono' }, fmtHexId(d.arbId, d.idKind)),
            h('td', {}, d.messageName),
            h('td', { class: 'small' },
              s.payload.versions.find((v) => v.id === d.versionId)?.label ?? `#${d.versionId}`),
            h('td', { class: 'small' },
              d.signals.map((sig) =>
                `${sig.signalName}=${sig.muxSkipped ? `raw[${sig.bitCells.length}b]` : sig.physValue ?? '—'}`
              ).join(', '))
          )
        ))
      )
    )
  ];
}

// ---- 启动：首次进入自动播种演示数据 --------------------------------------
async function boot() {
  try {
    const status = await api.get<{ seeded: boolean }>('/api/status');
    if (!status.seeded) {
      toast('空仓库：正在载入演示 trace 与两版 DBC…');
      await api.post('/api/seed', {});
    }
    await refresh();
  } catch (e) {
    app.append(h('div', { class: 'fatal' }, `初始化失败：${(e as Error).message}`));
  }
}

void boot();
