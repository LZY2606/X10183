import { api, fmtId, fmtNs } from '../api';

export async function renderInvestigations(root: HTMLElement) {
  root.innerHTML = `<div class="loading">加载调查快照…</div>`;
  const list = await api<any[]>('/api/investigations');
  root.innerHTML = `
    <h3>冻结的调查快照</h3>
    <div class="hint">快照在创建时复制帧数据与当时命中的 DBC 定义；之后修订 DBC 区间，快照仍指向旧定义。</div>
    ${list.length === 0 ? '<div class="muted">还没有调查。在「帧时间轴」中点击帧并冻结。</div>' : ''}
    ${list
      .map(
        (i) => `<div class="card" data-id="${i.id}">
          <h4>${i.name} <span class="muted">· ${new Date(i.createdMs).toLocaleString()} · 冻结版本 ${i.frozenVersionIds.join(', ')}</span></h4>
          <div class="rows-placeholder muted">点击展开 ${i.note ?? ''}</div>
        </div>`,
      )
      .join('')}`;
  root.querySelectorAll<HTMLElement>('.card').forEach((card) =>
    card.addEventListener('click', async () => {
      const id = card.dataset.id!;
      const detail = await api<any>(`/api/investigations/${id}`);
      card.querySelector('.rows-placeholder')!.innerHTML = detail.rows
        .map((r: any) => {
          const sigs = r.decoded.resolved
            ? r.decoded.decoded.signals
                .map((s: any) =>
                  s.unknownBranch
                    ? `<span class="warn">${s.name}=raw0x${(s.raw ?? 0).toString(16)}（未知分支）</span>`
                    : `<span title="bit ${s.bitRange.first}-${s.bitRange.last}">${s.name}=${s.value ?? s.raw}${s.enumLabel ? `(${s.enumLabel})` : ''}</span>`,
                )
                .join(' · ')
            : `<span class="warn">${r.decoded.reason}</span>`;
          return `<div class="snap-row">
            <span class="mono">${fmtId(r.arbId, r.extended)}</span>
            ${fmtNs(r.hwTimeNs)} · <b class="mono">${r.dataHex}</b>
            · 版本 <code>${r.versionLabel}</code> · ${r.messageName ?? '—'}
            <div class="hint snap-sigs">${sigs}</div>
          </div>`;
        })
        .join('');
    }),
  );
}
