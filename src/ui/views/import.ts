import { api } from '../api';

const EXAMPLE = `# timeNs  id#data ... gen=N ch=CAN1 （## 表示扩展帧）
21000000  0x100#0000000000000000  gen=2 ch=CAN1
22000000  0x200#9000be0000000000  gen=2 ch=CAN1
23000000  0x18FE4A00##fa2438ff00000000  gen=2 ch=CAN2`;

export function renderImport(root: HTMLElement) {
  root.innerHTML = `
    <h3>导入 CAN trace</h3>
    <p class="hint">支持文本格式（每行：硬件时间 ID#数据 [gen=N] [ch=通道]，<code>##</code> 为扩展帧）或 JSON 数组。
      导入结果与导入顺序无关：帧按内容哈希获得确定性 id；重复内容计为 duplicates。</p>
    <label>批次名 <input id="bname" value="手动导入 ${new Date().toLocaleTimeString()}"></label>
    <textarea id="trace" rows="10" style="width:100%;font-family:monospace">${EXAMPLE}</textarea>
    <div class="toolbar">
      <button id="go" class="primary">导入</button>
      <span id="result" class="hint"></span>
    </div>`;
  root.querySelector<HTMLButtonElement>('#go')!.addEventListener('click', async () => {
    const name = (root.querySelector('#bname') as HTMLInputElement).value;
    const text = (root.querySelector('#trace') as HTMLTextAreaElement).value;
    const out = root.querySelector<HTMLElement>('#result')!;
    try {
      const r = await api('/api/traces/import', { method: 'POST', body: JSON.stringify({ name, text }) });
      out.innerHTML = `✅ 批次 #${r.batchId}：新增 ${r.inserted} 帧，重复 ${r.duplicates} 帧`;
    } catch (e) {
      out.innerHTML = `<span class="err">导入失败：${(e as Error).message}</span>`;
    }
  });
}
