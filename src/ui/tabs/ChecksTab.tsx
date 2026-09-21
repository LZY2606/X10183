import { useEffect, useState } from "react";
import { api } from "../api";
import type { CounterEvent, CrcEvidence } from "../../core/types";

export function ChecksTab({ epoch, notify }: { epoch: number; notify: (m: string) => void }) {
  const [counters, setCounters] = useState<CounterEvent[]>([]);
  const [crcs, setCrcs] = useState<CrcEvidence[]>([]);
  const [rules, setRules] = useState<{
    counters: { messageName: string; signalName: string; width: number }[];
    crcs: CrcRuleView[];
  }>({ counters: [], crcs: [] });

  async function load() {
    try {
      const [c, r, cr] = await Promise.all([
        api.get<CounterEvent[]>("/checks/counters"),
        api.get<{ counters: { messageName: string; signalName: string; width: number }[]; crcs: CrcRuleView[] }>("/rules"),
        api.get<CrcEvidence[]>("/checks/crc"),
      ]);
      setCounters(c);
      setRules(r);
      setCrcs(cr);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  useEffect(() => {
    load();
  }, [epoch]);

  const crcSummary = {
    pass: crcs.filter((c) => c.verdict === "pass").length,
    fail: crcs.filter((c) => c.verdict === "fail").length,
    unverified: crcs.filter((c) => c.verdict === "unverified").length,
  };

  return (
    <div>
      <div className="panel">
        <h2>核验规则（配置不完整时 CRC 只能“未核验”，不会报通过）</h2>
        <RuleEditor onSaved={load} rules={rules} notify={notify} />
      </div>

      <div className="panel">
        <h2>计数器缺口（按节点 + 采集代次分组）</h2>
        {counters.length === 0 && <div className="muted small">未发现环绕/重复/缺帧事件（或未配置计数器规则）。</div>}
        <div className="scroll">
          <table>
            <thead>
              <tr><th>帧</th><th>时间</th><th>代次</th><th>节点</th><th>ID</th><th>类型</th><th>期望</th><th>实际</th><th>说明</th></tr>
            </thead>
            <tbody>
              {counters.map((e, i) => (
                <tr key={i}>
                  <td>#{e.frameId}</td>
                  <td className="mono">{e.hwTime}</td>
                  <td>{e.gen}</td>
                  <td>{e.node || <span className="muted">未知节点</span>}</td>
                  <td className="mono">0x{e.arbId.toString(16).toUpperCase()}</td>
                  <td><span className={`tag ${e.type}`}>{e.type}</span></td>
                  <td className="mono">{e.expected}</td>
                  <td className="mono">{e.actual}</td>
                  <td className="small">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2>
          CRC 证据{" "}
          <span className="small muted">
            <span className="tag pass">pass {crcSummary.pass}</span>{" "}
            <span className="tag fail">fail {crcSummary.fail}</span>{" "}
            <span className="tag unverified">未核验 {crcSummary.unverified}</span>
          </span>
        </h2>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>帧</th><th>时间</th><th>代次</th><th>结论</th><th>期望</th><th>帧内</th><th>poly/init/xor</th><th>覆盖 bit 边界</th><th>说明</th></tr>
            </thead>
            <tbody>
              {crcs.map((c, i) => (
                <tr key={i}>
                  <td>#{c.frameId}</td>
                  <td className="mono">{c.hwTime}</td>
                  <td>{c.gen}</td>
                  <td><span className={`tag ${c.verdict}`}>{c.verdict === "unverified" ? "未核验" : c.verdict}</span></td>
                  <td className="mono">{c.expected === null ? "—" : `0x${c.expected.toString(16).toUpperCase().padStart(2, "0")}`}</td>
                  <td className="mono">{c.actual === null ? "—" : `0x${c.actual.toString(16).toUpperCase().padStart(2, "0")}`}</td>
                  <td className="mono small">
                    {c.poly.toString(16)}/{c.init.toString(16)}/{c.xorOut.toString(16)}
                  </td>
                  <td className="mono small">
                    {c.coveredBits.length === 0 ? "—" : c.coveredBits.map((b) => `[${b.first}..${b.last}]`).join(" ")}
                    {c.crcBits && <div className="muted">crc [{c.crcBits.first}..{c.crcBits.last}]</div>}
                  </td>
                  <td className="small">{c.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

interface CrcRuleView {
  messageName: string;
  coverSignals: string[] | null;
  crcSignal: string;
  poly: number;
  init: number;
  xorOut: number;
}

function RuleEditor({
  onSaved,
  rules,
  notify,
}: {
  onSaved: () => void;
  rules: { counters: { messageName: string; signalName: string; width: number }[]; crcs: CrcRuleView[] };
  notify: (m: string) => void;
}) {
  const [msg, setMsg] = useState("ENGINE_STATUS");
  const [counterSig, setCounterSig] = useState("Counter");
  const [width, setWidth] = useState(8);
  const [crcSig, setCrcSig] = useState("Crc");
  const [cover, setCover] = useState("EngineSpeed,EngineTemp,Mode,Torque");
  const [poly, setPoly] = useState("0x07");
  const [init, setInit] = useState("0x00");
  const [xor, setXor] = useState("0x00");

  async function save() {
    try {
      await api.put("/rules/counter", { messageName: msg, signalName: counterSig, width: Number(width) });
      await api.put("/rules/crc", {
        messageName: msg,
        coverSignals: cover.trim() === "" ? null : cover.split(",").map((s) => s.trim()).filter(Boolean),
        crcSignal: crcSig,
        poly: Number(poly),
        init: Number(init),
        xorOut: Number(xor),
      });
      notify("规则已保存");
      onSaved();
    } catch (e) {
      notify((e as Error).message);
    }
  }

  return (
    <div>
      <div className="row">
        <input value={msg} onChange={(e) => setMsg(e.target.value)} style={{ width: 150 }} placeholder="消息名" />
        <label className="small muted">计数器信号</label>
        <input value={counterSig} onChange={(e) => setCounterSig(e.target.value)} style={{ width: 110 }} />
        <label className="small muted">位宽</label>
        <input value={width} onChange={(e) => setWidth(Number(e.target.value))} style={{ width: 60 }} />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <label className="small muted">CRC 信号</label>
        <input value={crcSig} onChange={(e) => setCrcSig(e.target.value)} style={{ width: 90 }} />
        <label className="small muted">覆盖信号(逗号分隔,空=除CRC外全部)</label>
        <input value={cover} onChange={(e) => setCover(e.target.value)} style={{ width: 260 }} />
        <label className="small muted">poly</label>
        <input value={poly} onChange={(e) => setPoly(e.target.value)} style={{ width: 70 }} />
        <label className="small muted">init</label>
        <input value={init} onChange={(e) => setInit(e.target.value)} style={{ width: 70 }} />
        <label className="small muted">xorOut</label>
        <input value={xor} onChange={(e) => setXor(e.target.value)} style={{ width: 70 }} />
        <button className="act" onClick={save}>保存规则</button>
      </div>
      {(rules.counters.length > 0 || rules.crcs.length > 0) && (
        <div className="small muted" style={{ marginTop: 8 }}>
          已配置：
          {rules.counters.map((c) => (
            <span key={c.messageName} className="mono" style={{ marginRight: 10 }}>
              counter:{c.messageName}.{c.signalName}({c.width}b)
            </span>
          ))}
          {rules.crcs.map((c) => (
            <span key={c.messageName} className="mono">
              crc:{c.messageName}.{c.crcSignal} poly={c.poly.toString(16)} init={c.init.toString(16)} xor={c.xorOut.toString(16)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
