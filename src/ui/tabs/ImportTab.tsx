import { useState } from "react";
import { api } from "../api";

const SAMPLE_TRACE = `channel,arb_id,kind,data,hw_time,gen
can0,0x100,std,"A0 03 41 11 F4 01 01 00",0.1,gen1
can0,0x18f001,ext,"0F A0 FF 83 00 00 00 00",1.0,gen1
`;

const SAMPLE_DBC = `BO_ 256 ENGINE_STATUS: 8 ECU
 SG_ EngineSpeed : 0|16@0- (0.25,-100) ["rpm"]
 SG_ EngineTemp : 16|8@0- (1,-40) ["degC"]
 SG_ Counter : 48|8@0+ (1,0) [""]
 SG_ Crc : 56|8@0+ (1,0) [""]

VAL_ 256 Mode 0 "Idle" 1 "Run";
`;

export function ImportTab({ notify }: { epoch: number; notify: (m: string) => void }) {
  const [trace, setTrace] = useState(SAMPLE_TRACE);
  const [source, setSource] = useState("manual");
  const [dbcName, setDbcName] = useState("ENG-A-manual");
  const [dbcText, setDbcText] = useState(SAMPLE_DBC);
  const [from, setFrom] = useState("20");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  async function importTrace() {
    setBusy(true);
    try {
      const r = await api.post<{ inserted: number; skipped: number; parseErrors: unknown[] }>(
        "/traces/import",
        { text: trace, source },
      );
      notify(`导入 ${r.inserted} 帧，跳过重复 ${r.skipped} 帧，解析错误 ${r.parseErrors.length} 行`);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importDbc() {
    setBusy(true);
    try {
      const v = await api.post<{ id: number }>("/dbc", {
        name: dbcName,
        sourceText: dbcText,
        effectiveFrom: Number(from),
        effectiveTo: to === "" ? null : Number(to),
      });
      notify(`DBC「${dbcName}」已入库（id=${v.id}），半开生效区间 [${from}, ${to || "∞"})`);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function seedDemo() {
    setBusy(true);
    try {
      const r = await api.post<{ framesInserted: number; note: string }>("/demo", {});
      notify(`演示数据就绪：${r.framesInserted} 帧。${r.note}`);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid2">
      <div className="panel">
        <h2>导入 CAN trace（原始帧/通道/硬件时间/采集代次）</h2>
        <textarea value={trace} onChange={(e) => setTrace(e.target.value)} spellCheck={false} />
        <div className="row" style={{ marginTop: 8 }}>
          <label className="small muted">来源标签</label>
          <input value={source} onChange={(e) => setSource(e.target.value)} style={{ width: 140 }} />
          <button className="act" disabled={busy} onClick={importTrace}>导入 trace</button>
          <button className="act secondary" disabled={busy} onClick={seedDemo}>载入演示数据集</button>
        </div>
        <p className="muted small">
          CSV 表头自动识别 <span className="mono">channel / arb_id / kind(std|ext) / data / hw_time / gen</span>；
          也支持 <span className="mono">id dlc b0 b1 … time</span> 的空白分隔行；扩展 id 可加 <span className="mono">X</span> 后缀。
          重复 (通道,id,kind,时间,来源,序号) 被幂等忽略，导入顺序不影响重放结果。
        </p>
      </div>

      <div className="panel">
        <h2>导入 DBC 修订（带半开生效区间）</h2>
        <textarea value={dbcText} onChange={(e) => setDbcText(e.target.value)} spellCheck={false} />
        <div className="row" style={{ marginTop: 8 }}>
          <input value={dbcName} onChange={(e) => setDbcName(e.target.value)} style={{ width: 150 }} placeholder="版本名" />
          <label className="small muted">from(s)</label>
          <input value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 80 }} />
          <label className="small muted">to(s, 空=开放)</label>
          <input value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 80 }} />
          <button className="act" disabled={busy} onClick={importDbc}>导入 DBC</button>
        </div>
        <p className="muted small">
          扩展帧在 <span className="mono">BO_</span> / <span className="mono">VAL_</span> 的 id 上带 0x80000000 标志，标准帧与扩展帧分别建定义；
          相同 arbitration id 的生效区间重叠会被拒绝，保证采集时点唯一定义。
        </p>
      </div>
    </div>
  );
}
