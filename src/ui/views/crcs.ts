import { api } from '../api';

export async function renderCrcs(root: HTMLElement) {
  root.innerHTML = `<div class="loading">核验 CRC…</div>`;
  const report = await api<any>('/api/crcs');
  const cls = (s: string) => (s === 'pass' ? 'ok' : s === 'fail' ? 'err' : 'neutral');
  root.innerHTML = `
    <h3>CRC 证据</h3>
    <div class="cards-row">
      <div class="stat ok">通过 ${report.summary.pass}</div>
      <div class="stat err">失败 ${report.summary.fail}</div>
      <div class="stat neutral">未核验 ${report.summary.notVerified}</div>
      <div class="stat warn">截断 ${report.summary.truncated}</div>
    </div>
    <div class="hint">规则缺少覆盖范围、初值或异或值时，状态只能是“未核验”，绝不报通过。</div>
    <table class="grid"><thead><tr><th>帧</th><th>消息</th><th>状态</th><th>覆盖字节</th><th>期望/实际</th><th>证据</th></tr></thead>
      <tbody>${report.evidences
        .map(
          (e: any) => `<tr>
            <td class="mono">#${e.frameId}</td><td>${e.messageName}</td>
            <td><span class="tag2 ${cls(e.status)}">${e.status}</span></td>
            <td class="mono">[${e.coveredBytes.join(',') || '—'}]</td>
            <td class="mono">${e.expected != null ? `0x${e.expected.toString(16)} / 0x${(e.actual ?? 0).toString(16)}` : '—'}</td>
            <td class="muted">${e.reason ?? `init=0x${(e.rule.init ?? 0).toString(16)} xor=0x${(e.rule.xorOut ?? 0).toString(16)}`}</td>
          </tr>`,
        )
        .join('')}</tbody></table>`;
}
