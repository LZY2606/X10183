import { api, fmtId, fmtNs } from '../api';

export async function renderCompare(root: HTMLElement) {
  const versions = await api<any[]>('/api/dbc/versions');
  root.innerHTML = `
    <h3>比较两个 DBC 版本对同一批帧的影响</h3>
    <div class="toolbar">
      <label>旧 <select id="from">${versions.map((v) => `<option value="${v.id}">${v.label}</option>`).join('')}</select></label>
      <label>新 <select id="to">${versions.map((v, i) => `<option value="${v.id}" ${i === versions.length - 1 ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
      <button id="run" class="primary">比较全部帧</button>
    </div>
    <div id="result"></div>`;
  root.querySelector<HTMLButtonElement>('#run')!.addEventListener('click', async () => {
    const from = (root.querySelector('#from') as HTMLSelectElement).value;
    const to = (root.querySelector('#to') as HTMLSelectElement).value;
    const out = root.querySelector<HTMLElement>('#result')!;
    out.innerHTML = `<div class="loading">比较中…</div>`;
    const r = await api<any>(`/api/compare?from=${from}&to=${to}`);
    out.innerHTML = `
      <div class="cards-row"><div class="stat">总帧 ${r.stats.total}</div>
        <div class="stat ok">兼容 ${r.stats.compatible}</div>
        <div class="stat err">不兼容 ${r.stats.incompatible}</div></div>
      <table class="grid"><thead><tr><th>帧</th><th>时间</th><th>ID</th><th>旧消息</th><th>新消息</th><th>信号变化</th><th>结论</th><th></th></tr></thead>
        <tbody>${r.frames
          .map((f: any) => {
            const changed = f.signals.filter((s: any) => s.status !== 'unchanged');
            return `<tr>
              <td class="mono">#${f.frameId}</td><td>${fmtNs(f.hwTimeNs)}</td>
              <td class="mono">${fmtId(f.arbId, f.extended)}</td>
              <td>${f.fromMessage ?? '—'}</td><td>${f.toMessage ?? '—'}</td>
              <td>${changed
                .map((s: any) => `<div class="chg ${s.compatible ? 'ok' : 'err'}">${s.signal}: ${s.status}${s.note ? `（${s.note}）` : ''} raw ${s.from.raw ?? '—'}→${s.to.raw ?? '—'}</div>`)
                .join('') || '<span class="muted">无变化</span>'}
                ${f.notes.length ? `<div class="warn">${f.notes.join('；')}</div>` : ''}</td>
              <td>${f.compatible ? '<span class="tag2 ok">可迁移</span>' : '<span class="tag2 err">不兼容</span>'}</td>
              <td><button data-propose="${f.arbId}" data-ext="${f.extended ? 1 : 0}">生成迁移映射</button></td>
            </tr>`;
          })
          .join('')}</tbody></table>
      <div id="migrations"></div>`;

    out.querySelectorAll<HTMLButtonElement>('[data-propose]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          const m = await api('/api/migrations', {
            method: 'POST',
            body: JSON.stringify({
              fromVersionId: Number(from),
              toVersionId: Number(to),
              arbId: Number(btn.dataset.propose),
              extended: btn.dataset.ext === '1',
            }),
          });
          renderMigration(out, m, from, to);
        } catch (e) {
          alert((e as Error).message);
        }
      }),
    );
  });

  async function renderMigration(out: HTMLElement, m: any, from: string, to: string) {
    const box = out.querySelector<HTMLElement>('#migrations')!;
    box.innerHTML = `<div class="card">
      <h4>迁移映射 #${m.id}（${m.compatible ? '可批准' : '存在不兼容信号'}）</h4>
      <div class="hint">${m.summary} · 覆盖 ${m.frameCount} 帧</div>
      <table class="grid compact"><thead><tr><th>旧信号</th><th>映射到新信号</th></tr></thead><tbody>
        ${Object.entries(m.mapping)
          .map(
            ([k, v]) => `<tr><td>${k}</td><td>${v === null ? '<span class="err">✗ 无法兼容</span>' : `→ ${v}`}</td></tr>`,
          )
          .join('')}
      </tbody></table>
      <div class="toolbar">
        <button id="approve" class="primary">批准迁移（rv=<span id="rv">1</span>）</button>
        <button id="reject">标记无法兼容</button>
        <span class="hint">两个审批并发提交时，后到者将收到 409 版本号冲突</span>
      </div>
    </div>`;
    const decide = async (decision: 'approved' | 'incompatible') => {
      try {
        const r = await api(`/api/migrations/${m.id}/decision`, {
          method: 'POST',
          body: JSON.stringify({
            decision,
            mapping: decision === 'approved' ? m.mapping : null,
            expectedRowVersion: 1,
          }),
        });
        alert(`已${decision === 'approved' ? '批准' : '标记不兼容'}：状态=${r.status}, 新 rv=${r.rowVersion}`);
        void renderCompare(root);
        void from;
        void to;
      } catch (e) {
        alert(`操作失败：${(e as Error).message}`);
      }
    };
    box.querySelector('#approve')!.addEventListener('click', () => decide('approved'));
    box.querySelector('#reject')!.addEventListener('click', () => decide('incompatible'));
  }
}
