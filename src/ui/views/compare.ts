import { api, hexId } from '../api.js';
import { toast } from '../app.js';

export async function compareView(root: HTMLElement) {
  root.innerHTML = `
    <div class="panel">
      <h2>比较两个 DBC 版本对同一批帧的影响</h2>
      <div class="row">
        <select id="from"></select><span>→</span><select id="to"></select>
        <button class="btn" id="run">比较</button>
      </div>
      <div class="muted" style="margin-top:6px">审批迁移映射或标记无法兼容；并发审批基于 lock_version，冲突时会被拒绝（409）。</div>
    </div>
    <div class="panel" id="result" style="display:none"></div>
    <div class="panel">
      <h2>过期解码检查</h2>
      <div class="row"><button class="btn ghost" id="stale">用左侧（旧）版本重放并标出过期帧</button></div>
      <div id="stalelist" style="margin-top:10px"></div>
    </div>`;

  const state = await api('/api/state');
  const opts = state.dbcs
    .map((v: any) => `<option value="${v.id}">${v.label} [${v.effectiveFrom ?? '−∞'}, ${v.effectiveTo ?? '+∞'})</option>`)
    .join('');
  (root.querySelector('#from') as HTMLSelectElement).innerHTML = opts;
  (root.querySelector('#to') as HTMLSelectElement).innerHTML = opts;
  if (state.dbcs[1]) (root.querySelector('#to') as HTMLSelectElement).value = String(state.dbcs[1].id);

  const run = async () => {
    const from = (root.querySelector('#from') as HTMLSelectElement).value;
    const to = (root.querySelector('#to') as HTMLSelectElement).value;
    if (from === to) return toast('请选择两个不同版本', true);
    const diffs: any[] = await api(`/api/compare?from=${from}&to=${to}`);
    const box = root.querySelector<HTMLElement>('#result')!;
    box.style.display = 'block';
    box.innerHTML = `<h2>布局差异与迁移映射</h2><div class="scroll"><table><thead><tr>
      <th>ID</th><th>v 旧消息</th><th>v 新消息</th><th>新增信号</th><th>移除信号</th><th>变化字段</th><th>状态</th><th>版本号</th><th>操作</th>
    </tr></thead><tbody>${diffs
      .map(
        (d) => `<tr data-mid="${d.migration.id}">
        <td class="mono">${hexId(d.canId, d.isExtended)}</td>
        <td>${d.fromMessage ?? '—'}</td><td>${d.toMessage ?? '—'}</td>
        <td>${d.addedSignals.map((s: string) => `<span class="pill ok">+${s}</span>`).join(' ') || '—'}</td>
        <td>${d.removedSignals.map((s: string) => `<span class="pill fail">-${s}</span>`).join(' ') || '—'}</td>
        <td>${d.changedSignals
          .map((c: any) => `${c.name}: ${c.fields.join('/')}`)
          .join('<br/>') || (d.compatible ? '<span class="muted">完全兼容</span>' : '—')}</td>
        <td class="status">${statusPill(d.migration.status)}</td>
        <td class="lock mono">v${d.migration.lockVersion}</td>
        <td>
          <button class="btn act" data-status="approved">批准映射</button>
          <button class="btn ghost act" data-status="incompatible">标记不兼容</button>
        </td></tr>`
      )
      .join('')}</tbody></table></div>`;

    box.querySelectorAll('button.act').forEach((b) =>
      b.addEventListener('click', async () => {
        const tr = (b as HTMLElement).closest('tr')!;
        const id = Number(tr.dataset.mid);
        const lockVersion = Number((tr.querySelector('.lock') as HTMLElement).textContent!.slice(1));
        const status = (b as HTMLElement).dataset.status!;
        try {
          const res = await api('/api/migration-approve', {
            method: 'POST',
            body: JSON.stringify({ id, status, lockVersion })
          });
          (tr.querySelector('.status') as HTMLElement).innerHTML = statusPill(status);
          (tr.querySelector('.lock') as HTMLElement).textContent = `v${res.lockVersion}`;
          toast(`已${status === 'approved' ? '批准' : '标记不兼容'}（新版本号 v${res.lockVersion}）`);
        } catch (e: any) {
          if (e.status === 409) {
            (tr.querySelector('.status') as HTMLElement).innerHTML = statusPill('pending');
            (tr.querySelector('.lock') as HTMLElement).textContent = `v${e.body.currentLock}`;
            toast(`版本冲突：他人已更新至 v${e.body.currentLock}，请刷新后重试`, true);
          } else {
            toast(String(e.message), true);
          }
        }
      })
    );
  };

  root.querySelector('#run')!.addEventListener('click', run);

  // 过期重放检查
  root.querySelector('#stale')!.addEventListener('click', async () => {
    const dbcId = Number((root.querySelector('#from') as HTMLSelectElement).value);
    const rows: any[] = await api(`/api/replay-with?dbcId=${dbcId}`);
    const stale = rows.filter((r) => r.stale);
    const box = root.querySelector('#stalelist')!;
    box.innerHTML = stale.length === 0
      ? '<span class="muted">该版本对全部帧仍是当前生效定义。</span>'
      : `<div class="muted" style="margin-bottom:6px">用旧版本解码时有 ${stale.length} 帧的定义已过期（当前生效 DBC 已不同）：</div>
         <table><thead><tr><th>帧</th><th>时间(ms)</th><th>ID</th><th>旧定义</th><th>消息</th></tr></thead><tbody>${stale
           .map((r) => `<tr><td>#${r.id}</td><td class="mono">${r.hwTime}</td>
             <td class="mono">0x${r.canId.toString(16).toUpperCase()}</td>
             <td class="stale">${r.usedDbc}</td><td>${r.messageName ?? '—'}</td></tr>`)
           .join('')}</tbody></table>`;
  });
}

function statusPill(s: string): string {
  if (s === 'approved') return '<span class="pill ok">已批准</span>';
  if (s === 'incompatible') return '<span class="pill fail">不兼容</span>';
  return '<span class="pill muted">待审批</span>';
}
