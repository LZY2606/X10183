import { api } from '../api.js';

interface StateMsg {
  id: number;
  name: string;
  signals: { name: string; unit: string | null }[];
}

export async function signalsView(root: HTMLElement) {
  root.innerHTML = `
    <div class="panel">
      <h2>信号曲线</h2>
      <div class="row">
        <select id="msg"></select><select id="sig"></select>
        <label class="muted"><input type="checkbox" id="rawmode" /> 显示 raw 值</label>
      </div>
    </div>
    <div class="panel"><div id="chart"></div><div id="points" class="muted" style="margin-top:8px"></div></div>`;

  const state = await api('/api/state');
  const msgsSigs: Record<string, Set<string>> = {};
  for (const v of state.dbcs) {
    const msgs: StateMsg[] = await api(`/api/dbc-messages?dbcId=${v.id}`);
    for (const m of msgs) {
      const key = m.name;
      if (!msgsSigs[key]) msgsSigs[key] = new Set();
      for (const s of m.signals) msgsSigs[key].add(s.name);
    }
  }
  const msgSel = root.querySelector<HTMLSelectElement>('#msg')!;
  const sigSel = root.querySelector<HTMLSelectElement>('#sig')!;
  msgSel.innerHTML = Object.keys(msgsSigs)
    .sort()
    .map((m) => `<option>${m}</option>`)
    .join('');
  const fillSigs = () => {
    const names = [...(msgsSigs[msgSel.value] ?? [])];
    sigSel.innerHTML = names.map((n) => `<option>${n}</option>`).join('');
  };
  msgSel.addEventListener('change', () => {
    fillSigs();
    draw();
  });
  sigSel.addEventListener('change', draw);
  root.querySelector('#rawmode')!.addEventListener('change', draw);
  fillSigs();
  draw();

  async function draw() {
    const points: any[] = await api(
      `/api/signal-series?message=${encodeURIComponent(msgSel.value)}&signal=${encodeURIComponent(sigSel.value)}`
    );
    const rawMode = (root.querySelector('#rawmode') as HTMLInputElement).checked;
    const chart = root.querySelector('#chart')!;
    if (points.length === 0) {
      chart.innerHTML = '<span class="muted">该信号暂无可绘制的解码值（可能处于未知 mux 分支）。</span>';
      root.querySelector('#points')!.textContent = '';
      return;
    }
    const W = 960;
    const H = 240;
    const xs = points.map((p) => p.hwTime);
    const ys = points.map((p) => (rawMode ? p.raw : p.physical));
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs, xMin + 1);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys, yMin + 1);
    const X = (t: number) => 46 + ((t - xMin) / (xMax - xMin)) * (W - 66);
    const Y = (v: number) => H - 34 - ((v - yMin) / (yMax - yMin || 1)) * (H - 56);
    const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.hwTime).toFixed(1)},${Y(rawMode ? p.raw : p.physical).toFixed(1)}`).join(' ');
    const dots = points
      .map(
        (p) =>
          `<circle cx="${X(p.hwTime).toFixed(1)}" cy="${Y(rawMode ? p.raw : p.physical).toFixed(1)}" r="3" fill="#4ea1ff"><title>帧#${p.frameId} @${p.hwTime}ms\nraw=${p.raw} phys=${p.physical}${p.enumValue ? ' ' + p.enumValue : ''}</title></circle>`
      )
      .join('');
    chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;background:var(--panel2);border-radius:6px">
      <text x="8" y="20" fill="#8497a8" font-size="11">${yMax.toFixed(2)}</text>
      <text x="8" y="${H - 30}" fill="#8497a8" font-size="11">${yMin.toFixed(2)}</text>
      <text x="46" y="${H - 8}" fill="#8497a8" font-size="11">${xMin}ms</text>
      <text x="${W - 80}" y="${H - 8}" fill="#8497a8" font-size="11">${xMax}ms</text>
      <path d="${path}" fill="none" stroke="#4ea1ff" stroke-width="2"/>${dots}</svg>`;
    root.querySelector('#points')!.innerHTML = points
      .map(
        (p) =>
          `<span class="pill ${p.enumValue ? 'ok' : 'muted'}" style="margin:2px">@${p.hwTime}ms raw=${p.raw} → ${p.physical}${p.enumValue ? ' ' + p.enumValue : ''}</span>`
      )
      .join('');
  }
}
