import { api } from '../api.js';
import { toast } from '../app.js';

export async function snapshotView(root: HTMLElement) {
  root.innerHTML = `
    <div class="panel">
      <h2>冻结的调查快照</h2>
      <div class="muted">快照按创建时选择的 DBC 定义固化全部解码结果；之后 DBC 修订只影响实时解码（标记为过期），快照仍指向旧定义。</div>
      <div class="row" style="margin-top:8px">
        <input id="label" placeholder="快照名称" style="width:200px" />
        <select id="dbc"></select>
        <button class="btn" id="create">创建快照</button>
      </div>
    </div>
    <div class="panel" id="list"></div>`;
  const state = await api('/api/state');
  (root.querySelector('#dbc') as HTMLSelectElement).innerHTML =
    '<option value="">各帧创建时的生效版本</option>' +
    state.dbcs.map((v: any) => `<option value="${v.id}">强制使用 ${v.label}</option>`).join('');

  const render = async () => {
    const s = await api('/api/state');
    const box = root.querySelector('#list')!;
    if (s.snapshots.length === 0) {
      box.innerHTML = '<span class="muted">还没有快照。</span>';
      return;
    }
    box.innerHTML = `<table><thead><tr><th>#</th><th>名称</th><th>创建时间</th><th>冻结 DBC</th><th></th></tr></thead><tbody>${s.snapshots
      .map(
        (sn: any) => `<tr><td>${sn.id}</td><td>${sn.label}</td>
        <td>${new Date(sn.createdAt).toLocaleString()}</td>
        <td>${sn.frozenDbcId ? '#' + sn.frozenDbcId : '按生效区间'}</td>
        <td><button class="btn ghost view" data-id="${sn.id}">查看冻结解码</button></td></tr>`
      )
      .join('')}</tbody></table><div id="viewer" style="margin-top:12px"></div>`;
    box.querySelectorAll('.view').forEach((b) =>
      b.addEventListener('click', async () => {
        const payload: any = await api(`/api/snapshot?id=${(b as HTMLElement).dataset.id}`);
        const rows = payload.frames.slice(0, 30).map((d: any) => {
          const sigs = d.signals
            .filter((x: any) => !x.muxUnknown && x.physical !== null)
            .map((x: any) => `${x.signalName}=${x.physical}${x.unit ?? ''}`)
            .join(', ');
          return `<tr><td>#${d.frame.id}</td><td class="mono">${d.frame.hwTime}</td>
          <td>${d.message?.name ?? '—'}</td><td class="mono">${d.dbc?.label ?? '—'}</td>
          <td>${sigs}</td></tr>`;
        });
        box.querySelector('#viewer')!.innerHTML = `
          <h3>快照内容（冻结于 ${payload.dbc?.label ?? '生效区间'}，前 30 帧）</h3>
          <div class="scroll"><table><thead><tr><th>帧</th><th>时间</th><th>消息</th><th>冻结定义</th><th>信号值</th></tr></thead>
          <tbody>${rows.join('')}</tbody></table></div>`;
      })
    );
  };

  root.querySelector('#create')!.addEventListener('click', async () => {
    const label = (root.querySelector('#label') as HTMLInputElement).value.trim() || `调查快照 ${new Date().toLocaleTimeString()}`;
    const dbcTok = (root.querySelector('#dbc') as HTMLSelectElement).value;
    await api('/api/snapshot', {
      method: 'POST',
      body: JSON.stringify({ label, dbcId: dbcTok === '' ? null : Number(dbcTok) })
    });
    toast('快照已冻结');
    render();
  });
  render();
}
