import { api, fmtNs } from '../api';

export async function renderVersions(root: HTMLElement) {
  root.innerHTML = `<div class="loading">加载 DBC 版本…</div>`;
  await draw(root);
}

async function draw(root: HTMLElement) {
  const versions = await api<any[]>('/api/dbc/versions');
  root.innerHTML = `
    <h3>DBC 版本与生效区间</h3>
    <div class="hint">区间半开 [start, end)；修订生效区间后，仅受影响时间点的解码会被标记为“过期”，已冻结快照继续指向旧定义。</div>
    <div class="timeline-bar">
      ${versions
        .map((v) => {
          const left = Math.min(100, Math.max(0, (v.startNs / 1_000_000_000) * 100));
          const width = v.endNs == null ? 100 - left : Math.max(4, ((v.endNs - v.startNs) / 1_000_000_000) * 100);
          return `<div class="seg" style="left:${left}%;width:${Math.min(width, 100 - left)}%">${v.label}</div>`;
        })
        .join('')}
    </div>
    ${(
      await Promise.all(
        versions.map(async (v) => {
          const doc = await api<any>(`/api/dbc/versions/${v.id}`);
          return `<div class="card">
            <h4>${v.label} <span class="muted">seq=${v.seq} · rv=${v.rowVersion}</span></h4>
            <div class="hint">生效：${fmtNs(v.startNs)} 至 ${v.endNs == null ? '开放' : fmtNs(v.endNs)}（端点半开）</div>
            <div class="interval-editor">
              <label>start(ms)<input type="number" data-k="startNs" value="${v.startNs / 1e6}"></label>
              <label>end(ms)<input type="number" data-k="endNs" value="${v.endNs == null ? '' : v.endNs / 1e6}" placeholder="开放"></label>
              <button data-save="${v.id}" data-rv="${v.rowVersion}">保存区间（乐观并发）</button>
            </div>
            <details><summary>${doc.doc.messages.length} 个消息定义（字节序/缩放/枚举/mux）</summary>
              ${doc.doc.messages
                .map(
                  (m: any) => `<div class="msgdef">
                  <b>${m.name}</b> <span class="mono">0x${m.arbId.toString(16).toUpperCase()} ${m.extended ? 'XTD' : 'STD'} ch=${m.channel ?? '*'} dlc=${m.dlc} node=${m.transmitter ?? '?'}</span>
                  <table class="grid compact"><tbody>
                    ${m.signals
                      .map(
                        (s: any) => `<tr><td>${s.name}${s.muxSwitch ? ' [M]' : s.muxValue != null ? ` [m${s.muxValue}]` : ''}</td>
                          <td class="mono">${s.startBit}|${s.length}@${s.byteOrder === 'intel' ? 1 : 0}${s.signed ? '-' : '+'}</td>
                          <td class="mono">(${s.factor},${s.offset})</td>
                          <td>${s.enums.map((e: any) => `${e.value}=${e.label}`).join(' ')}</td>
                          <td>${s.isCounter ? 'counter' : ''}${s.isCrc ? ' crc' : ''}</td></tr>`,
                      )
                      .join('')}
                  </tbody></table>
                  ${m.crc ? `<div class="hint">CRC: ${m.crc.signal} cover=[${m.crc.coverStart ?? '?'},${m.crc.coverEnd ?? '?'}) init=${m.crc.init ?? '?'} xor=${m.crc.xorOut ?? '?'}</div>` : ''}
                </div>`,
                )
                .join('')}
            </details>
          </div>`;
        }),
      )
    ).join('')}`;

  root.querySelectorAll<HTMLButtonElement>('[data-save]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const card = btn.closest('.card')!;
      const startNs = Number((card.querySelector('[data-k=startNs]') as HTMLInputElement).value) * 1e6;
      const endRaw = (card.querySelector('[data-k=endNs]') as HTMLInputElement).value;
      try {
        const r = await api(`/api/dbc/versions/${btn.dataset.save}`, {
          method: 'PATCH',
          body: JSON.stringify({
            startNs,
            endNs: endRaw === '' ? null : Number(endRaw) * 1e6,
            expectedRowVersion: Number(btn.dataset.rv),
          }),
        });
        alert(`已保存，新版本号 ${r.rowVersion}；受影响帧 ${r.staleFrameIds.length} 个，其解码已过期`);
        void draw(root);
      } catch (e) {
        alert(`保存失败：${(e as Error).message}`);
      }
    }),
  );
}
