import { api } from '../api.js';
import { toast } from '../app.js';

const SAMPLE = `# canid, ext(1/0), channel, hwtime_ms, data_hex, acquisition_gen
0x100,0,1,210000,123456789ABCDEF0,3
0x18FEF100x,1,1,211000,0011223344556677,3
0x300,0,1,212000,050A0B0C0D0E0F00,3`;

const SAMPLE_DBC = `BO_ 500 NEW_MSG: 8 ECU
 SG_ Level m5 : 0|8@0+ (1,0) [0|255] "" ECU
 SG_ Switch M : 8|4@1+ (1,0) [0|15] "" ECU
 VAL_ 500 Switch 0 "Off" 1 "On";`;

export async function importView(root: HTMLElement) {
  root.innerHTML = `
    <div class="panel">
      <h2>导入 CAN trace</h2>
      <div class="muted">CSV：<code class="k">canid, ext, channel, hwtime_ms, data_hex, acquisition_gen</code>；扩展帧 id 以 <code class="k">x</code> 结尾或 ext=1。原始帧、通道、硬件时间与采集代次原样保存。</div>
      <textarea id="trace" style="margin-top:8px">${SAMPLE}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="go">导入 trace</button><span id="r1" class="muted"></span></div>
    </div>
    <div class="panel">
      <h2>导入 DBC 版本（带生效区间）</h2>
      <div class="row">
        <input id="label" placeholder="版本标签 DBC-v3.0" style="width:160px" />
        <input id="from" type="number" placeholder="生效起 ms（空=−∞）" style="width:180px" />
        <input id="to" type="number" placeholder="生效止 ms（空=+∞，半开）" style="width:180px" />
      </div>
      <textarea id="dbc" style="margin-top:8px">${SAMPLE_DBC}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="godbc">导入 DBC</button><span id="r2" class="muted"></span></div>
    </div>`;

  root.querySelector('#go')!.addEventListener('click', async () => {
    const text = (root.querySelector('#trace') as HTMLTextAreaElement).value;
    const res = await api('/api/trace-import', { method: 'POST', body: JSON.stringify({ text }) });
    (root.querySelector('#r1') as HTMLElement).textContent = `已保存 ${res.count} 帧（解码顺序只依赖硬件时间与帧 id，导入顺序不影响结果）。`;
    toast(`导入 ${res.count} 帧`);
  });
  root.querySelector('#godbc')!.addEventListener('click', async () => {
    const label = (root.querySelector('#label') as HTMLInputElement).value.trim() || `DBC-${Date.now()}`;
    const fromTok = (root.querySelector('#from') as HTMLInputElement).value.trim();
    const toTok = (root.querySelector('#to') as HTMLInputElement).value.trim();
    const text = (root.querySelector('#dbc') as HTMLTextAreaElement).value;
    const res = await api('/api/dbc', {
      method: 'POST',
      body: JSON.stringify({
        label,
        effectiveFrom: fromTok === '' ? null : Number(fromTok),
        effectiveTo: toTok === '' ? null : Number(toTok),
        text
      })
    });
    (root.querySelector('#r2') as HTMLElement).textContent =
      `已创建 ${label}，解析错误 ${res.parseErrors.length} 条。仅处于其生效区间内的帧会采用新定义。`;
  });
}
