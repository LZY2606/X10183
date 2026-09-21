import { api } from '../api.js';

const STATUS: Record<string, { label: string; cls: string }> = {
  passed: { label: '通过', cls: 'ok' },
  failed: { label: '不通过', cls: 'fail' },
  unchecked: { label: '未核验', cls: 'warn' }
};

export async function crcView(root: HTMLElement) {
  root.innerHTML = `
    <div class="panel">
      <h2>CRC 规则</h2>
      <div class="muted">覆盖范围 / 初值 / 异或值任一缺失，结果只能是「未核验」，不会报通过。算法：8-bit 多项式 0x07，逐位反馈 + 末尾 XOR。</div>
      <details style="margin-top:8px"><summary>配置规则</summary>
        <div class="row" style="margin-top:8px">
          <input id="msg" placeholder="消息名 MOTOR_STATUS" style="width:200px" />
          <input id="sig" placeholder="CRC 信号名 Crc8" style="width:130px" />
          <input id="cover" placeholder="覆盖区间 0:56" value="0:56" style="width:120px" />
          <input id="init" type="number" placeholder="初值" value="255" style="width:90px" />
          <input id="xor" type="number" placeholder="异或值" value="0" style="width:90px" />
          <button class="btn" id="save">保存并核验</button>
          <button class="btn ghost" id="incomplete">保存不完整配置（演示未核验）</button>
        </div>
      </details>
    </div>
    <div id="reports"></div>`;

  const render = async () => {
    const reports: any[] = await api('/api/crc');
    const box = root.querySelector('#reports')!;
    box.innerHTML = reports
      .map(
        (r) => `<div class="panel">
        <h2>${r.messageName}
          ${
            r.configured
              ? '<span class="pill ok">配置完整</span>'
              : `<span class="pill warn">配置不完整：${r.missingConfig.join(', ')}</span>`
          }
        </h2>
        ${
          r.evidences.length === 0
            ? '<p class="muted">无匹配帧</p>'
            : `<div class="scroll"><table><thead><tr><th>帧</th><th>时间(ms)</th><th>帧中CRC</th><th>计算CRC</th><th>结论</th><th>说明</th></tr></thead>
          <tbody>${r.evidences
            .map(
              (e: any) => `<tr><td>#${e.frameId}</td><td class="mono">${e.hwTime}</td>
              <td class="mono">${e.expected === null ? '—' : '0x' + e.expected.toString(16).padStart(2, '0').toUpperCase()}</td>
              <td class="mono">${e.computed === null ? '—' : '0x' + e.computed.toString(16).padStart(2, '0').toUpperCase()}</td>
              <td><span class="pill ${STATUS[e.status].cls}">${STATUS[e.status].label}</span></td>
              <td class="muted">${e.reason}</td></tr>`
            )
            .join('')}</tbody></table></div>`
        }
      </div>`
      )
      .join('');
  };

  const save = async (incomplete: boolean) => {
    const messageName = (root.querySelector('#msg') as HTMLInputElement).value.trim() || 'MOTOR_STATUS';
    const signalName = (root.querySelector('#sig') as HTMLInputElement).value.trim() || 'Crc8';
    const cover = (root.querySelector('#cover') as HTMLInputElement).value.trim();
    const coverage = cover
      .split(',')
      .map((tok) => {
        const [startBit, len] = tok.split(':').map(Number);
        return { startBit, bitLength: len };
      })
      .filter((c) => Number.isFinite(c.startBit) && Number.isFinite(c.bitLength));
    const initTok = (root.querySelector('#init') as HTMLInputElement).value.trim();
    const xorTok = (root.querySelector('#xor') as HTMLInputElement).value.trim();
    await api('/api/crc', {
      method: 'POST',
      body: JSON.stringify({
        messageName,
        signalName,
        coverage: incomplete ? [] : coverage,
        init: incomplete || initTok === '' ? null : Number(initTok),
        xorOut: incomplete || xorTok === '' ? null : Number(xorTok),
        dbcId: null
      })
    });
    render();
  };
  root.querySelector('#save')!.addEventListener('click', () => save(false));
  root.querySelector('#incomplete')!.addEventListener('click', () => save(true));

  render();
}
