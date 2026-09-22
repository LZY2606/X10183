import { el, fmtId, toast } from './dom.js';
import { api } from '../api.js';
import type { DbcVersion, Migration, VersionComparison } from '../types.js';
import type { ViewContext } from './app.js';

export function compareView(ctx: ViewContext): HTMLElement {
  const root = el('div', { class: 'grid' });
  if (ctx.state.dbcs.length < 2) {
    root.append(el('div', { class: 'card muted' }, '需要至少两个 DBC 版本。请载入演示数据或导入多版 DBC。'));
    return root;
  }

  const fromSel = el('select', {}, ...ctx.state.dbcs.map((v) => el('option', { value: String(v.id) }, v.label)));
  const toSel = el(
    'select',
    {},
    ...ctx.state.dbcs.map((v, i) => el('option', { value: String(v.id), selected: i === 1 }, v.label))
  );
  const resultHost = el('div');
  const migrationHost = el('div');

  async function run(): Promise<void> {
    const from = Number(fromSel.value);
    const to = Number(toSel.value);
    if (from === to) {
      toast('请选择两个不同版本', 'error');
      return;
    }
    resultHost.replaceChildren(el('span', { class: 'muted small' }, '比较中…'));
    const cmp = await api.get<VersionComparison>(`/api/compare?from=${from}&to=${to}`);
    resultHost.replaceChildren(renderDiff(cmp));
    migrationHost.replaceChildren(await renderMigration(from, to, ctx));
  }

  root.append(
    el('div', { class: 'card' },
      el('h2', {}, '比较两个 DBC 版本对同一批帧的影响'),
      el('div', { class: 'row' },
        el('label', { class: 'inline' }, '旧版', fromSel),
        el('span', {}, '→'),
        el('label', { class: 'inline' }, '新版', toSel),
        el('button', { class: 'btn', onclick: () => run().catch((e) => toast(e.message, 'error')) }, '比较')
      ),
      el('div', { class: 'muted small', style: 'margin-top:6px' }, '同 ID 换布局、信号增删改、标准/扩展分类差异逐信号列出。')
    ),
    resultHost,
    migrationHost
  );
  void run();
  return root;
}

function renderDiff(cmp: VersionComparison): HTMLElement {
  const card = el('div', { class: 'card' },
    el('h2', {}, `比较结果（${cmp.framesCompared} 帧）`));
  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {}, ...['消息 ID', '消息名', '消息变更', '信号', 'start/len', '字节序', '缩放/偏置', 'mux', '信号变更'].map((h) => el('th', {}, h))))
  );
  const body = el('tbody');
  for (const m of cmp.messages) {
    for (const s of m.signals) {
      body.append(
        el('tr', {},
          el('td', { class: 'mono' }, `${fmtId(m.arbId, m.extended)}`),
          el('td', {}, m.messageName),
          el('td', {}, el('span', { class: `tag ${m.status === 'identical' ? 'identical' : 'changed'}` }, m.status)),
          el('td', { class: 'mono' }, s.name),
          el('td', { class: 'small mono' },
            `${s.from?.startBit ?? '—'}|${s.from?.length ?? '—'} → ${s.to?.startBit ?? '—'}|${s.to?.length ?? '—'}`),
          el('td', { class: 'small' }, `${s.from?.byteOrder ?? '—'} → ${s.to?.byteOrder ?? '—'}`),
          el('td', { class: 'small mono' },
            `${s.from ? `×${s.from.scale}+${s.from.offset}` : '—'} → ${s.to ? `×${s.to.scale}+${s.to.offset}` : '—'}`),
          el('td', { class: 'small' }, `${s.from?.muxType ?? '—'} → ${s.to?.muxType ?? '—'}`),
          el('td', {}, el('span', { class: `tag ${s.status}` }, s.status))
        )
      );
    }
  }
  table.append(body);
  card.append(el('div', { style: 'max-height:46vh;overflow:auto' }, table));
  return card;
}

async function renderMigration(from: number, to: number, ctx: ViewContext): Promise<HTMLElement> {
  const card = el('div', { class: 'card' }, el('h2', {}, '迁移映射审批'));
  try {
    let migration: Migration = await api.post('/api/migrations', { fromDbcId: from, toDbcId: to });
    const render = () => {
      card.replaceChildren(el('h2', {}, '迁移映射审批'));
      card.append(el('div', { class: 'pill-row' },
        el('span', { class: 'badge' }, `映射版本 ${migration.version}`),
        el('span', { class: `tag ${migration.status === 'approved' ? 'pass' : migration.status === 'incompatible' ? 'fail' : 'warn'}` },
          migration.status === 'approved' ? '已批准' : migration.status === 'incompatible' ? '标记为无法兼容' : '待审批'),
        el('span', { class: 'muted small' }, migration.rationale)
      ));
      const incompatible = migration.mapping.some((m) => m.status === 'removed' || m.signals.some((s) => s.status === 'removed'));
      if (incompatible) {
        card.append(el('div', { class: 'small', style: 'color:var(--amber);margin:6px 0' }, '检测到消息或信号被删除，请确认是否无法兼容。'));
      }
      if (migration.status === 'open') {
        const rationale = el('input', { placeholder: '审批说明（可选）', style: 'flex:1;min-width:220px' });
        card.append(el('div', { class: 'row', style: 'margin-top:8px' }, rationale,
          el('button', {
            class: 'btn',
            onclick: async () => {
              try {
                migration = await api.post(`/api/migrations/${migration.id}/decision`, {
                  status: 'approved',
                  rationale: rationale.value,
                  expectedVersion: migration.version
                });
                toast('迁移映射已批准');
                render();
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            }
          }, '批准迁移映射'),
          el('button', {
            class: 'btn danger',
            onclick: async () => {
              try {
                migration = await api.post(`/api/migrations/${migration.id}/decision`, {
                  status: 'incompatible',
                  rationale: rationale.value,
                  expectedVersion: migration.version
                });
                toast('已标记无法兼容');
                render();
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            }
          }, '标记无法兼容'),
          el('button', {
            class: 'btn ghost',
            onclick: async () => {
              try {
                await api.post(`/api/migrations/${migration.id}/decision`, {
                  status: 'approved',
                  rationale: '并发窗口模拟',
                  expectedVersion: migration.version
                });
                // 第二次相同版本号必须冲突
                await api.post(`/api/migrations/${migration.id}/decision`, {
                  status: 'approved',
                  rationale: '重复审批',
                  expectedVersion: migration.version
                });
              } catch (e) {
                toast(`并发冲突已拦截：${(e as Error).message}`);
                void ctx;
              }
            }
          }, '模拟并发冲突')
        ));
      } else {
        card.append(el('div', { class: 'muted small' }, '映射已终结，不可重复审批。'));
      }
    };
    render();
  } catch (e) {
    card.append(el('div', { class: 'tag fail' }, (e as Error).message));
  }
  return card;
}
