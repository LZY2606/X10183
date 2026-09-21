import { api, fmtNs } from '../api';

export async function renderCounters(root: HTMLElement) {
  root.innerHTML = `<div class="loading">分析计数器（按节点 × 采集代次）…</div>`;
  const report = await api<{ series: any[]; skipped: string[] }>('/api/counters');
  const kindLabel: Record<string, { text: string; cls: string }> = {
    wrap: { text: '环绕', cls: 'ok' },
    repeat: { text: '重复', cls: 'warn' },
    gap: { text: '缺帧', cls: 'err' },
    'duplicate-timestamp': { text: '重复时间戳', cls: 'warn' },
  };
  root.innerHTML = `
    <h3>计数器检查（节点 × 采集代次）</h3>
    <div class="hint">同一节点不同采集代次独立成序列；时间相同的帧按帧 id 确定性排序。</div>
    ${report.series
      .map(
        (s) => `<div class="card">
          <h4>节点 <code>${s.node}</code> · 代次 ${s.generation}
            <span class="muted">（${s.frameIds.length} 帧，${s.events.length} 个事件）</span></h4>
          ${s.events.length === 0 ? '<div class="muted">无异常</div>' : ''}
          <table class="grid"><thead><tr><th>类型</th><th>时间</th><th>帧</th><th>值变化</th><th>说明</th></tr></thead>
            <tbody>${s.events
              .map((e: any) => {
                const k = kindLabel[e.kind];
                return `<tr>
                  <td><span class="tag2 ${k.cls}">${k.text}</span></td>
                  <td class="mono">${fmtNs(e.timeNs)}</td>
                  <td class="mono">#${e.prevId ?? '?'} → #${e.frameId}</td>
                  <td class="mono">${e.prevValue ?? '—'} → ${e.value}${e.expected != null ? `（期望 ${e.expected}）` : ''}</td>
                  <td>${e.detail}</td>
                </tr>`;
              })
              .join('')}</tbody></table>
        </div>`,
      )
      .join('')}
    ${report.skipped.length ? `<div class="warnbox">${report.skipped.join('<br>')}</div>` : ''}`;
}
