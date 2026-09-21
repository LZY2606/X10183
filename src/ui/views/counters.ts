import { api } from '../api.js';

const KIND: Record<string, { label: string; cls: string }> = {
  wrap: { label: '环绕', cls: 'ok' },
  duplicate: { label: '重复', cls: 'warn' },
  missing: { label: '缺帧', cls: 'fail' }
};

export async function countersView(root: HTMLElement) {
  root.innerHTML = `
    <div class="panel">
      <h2>计数器规则（按节点 + 采集代次检查）</h2>
      <details><summary>添加 / 修改规则</summary>
        <div class="row" style="margin-top:8px">
          <input id="node" placeholder="节点，如 MCU" style="width:110px" />
          <input id="signal" placeholder="计数器信号名" style="width:180px" />
          <input id="max" type="number" placeholder="最大值（空=按位宽）" style="width:170px" />
          <button class="btn" id="save">保存规则</button>
        </div>
      </details>
    </div>
    <div id="reports"></div>`;

  const render = async () => {
    const reports: any[] = await api('/api/counters');
    const box = root.querySelector('#reports')!;
    if (reports.length === 0) {
      box.innerHTML = '<div class="panel muted">尚无计数器规则。</div>';
      return;
    }
    box.innerHTML = reports
      .map(
        (r) => `<div class="panel">
        <h2>${r.node} · <code class="k">${r.signalName}</code>
          ${r.ordered ? '<span class="pill ok">连续无缺</span>' : '<span class="pill fail">发现异常</span>'}</h2>
        <div class="muted">分组：${r.groups
          .map((g: any) => `G${g.acquisitionGen}（${g.count} 帧）`)
          .join('，')}；环绕事件仅提示，不计错误。</div>
        ${
          r.events.length === 0
            ? '<p class="muted">无事件</p>'
            : `<div class="scroll" style="margin-top:8px"><table><thead><tr><th>事件</th><th>帧</th><th>时间(ms)</th><th>代次</th><th>期望</th><th>实际</th><th>丢失</th></tr></thead>
          <tbody>${r.events
            .map(
              (e: any) => `<tr><td><span class="pill ${KIND[e.kind].cls}">${KIND[e.kind].label}</span></td>
              <td>#${e.frameId}</td><td class="mono">${e.hwTime}</td><td>G${e.acquisitionGen}</td>
              <td class="mono">${e.expected}</td><td class="mono">${e.actual}</td>
              <td>${e.lost ?? '—'}</td></tr>`
            )
            .join('')}</tbody></table></div>`
        }
      </div>`
      )
      .join('');
  };

  root.querySelector('#save')!.addEventListener('click', async () => {
    const node = (root.querySelector('#node') as HTMLInputElement).value.trim();
    const signalName = (root.querySelector('#signal') as HTMLInputElement).value.trim();
    const maxTok = (root.querySelector('#max') as HTMLInputElement).value.trim();
    if (!node || !signalName) return;
    await api('/api/counters', {
      method: 'POST',
      body: JSON.stringify({ node, signalName, maxValue: maxTok === '' ? null : Number(maxTok), dbcId: null })
    });
    render();
  });

  render();
}
