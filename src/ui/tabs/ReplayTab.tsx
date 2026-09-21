import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { BitLayout } from "../components/BitLayout";
import { SignalCurve } from "../components/SignalCurve";
import type { DecodedFrame } from "../../core/types";

export function ReplayTab({ epoch, notify }: { epoch: number; notify: (m: string) => void }) {
  const [frames, setFrames] = useState<DecodedFrame[]>([]);
  const [gen, setGen] = useState<string>("");
  const [selected, setSelected] = useState<number | null>(null);

  const gens = useMemo(() => [...new Set(frames.map((f) => f.gen))].sort(), [frames]);

  async function load(g = gen) {
    try {
      const data = await api.get<DecodedFrame[]>(`/replay${g ? `?gen=${encodeURIComponent(g)}` : ""}`);
      setFrames(data);
      setSelected((cur) => (cur && data.some((f) => f.frameId === cur) ? cur : data[0]?.frameId ?? null));
    } catch (e) {
      notify((e as Error).message);
    }
  }

  useEffect(() => {
    load("");
  }, [epoch]);

  const detail = frames.find((f) => f.frameId === selected) ?? null;

  return (
    <div>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>帧时间轴（按采集时点的生效 DBC 版本重放）</h2>
          <div className="row">
            <label className="small muted">采集代次</label>
            <select value={gen} onChange={(e) => { setGen(e.target.value); load(e.target.value); }}>
              <option value="">全部</option>
              {gens.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <button className="act secondary" onClick={() => load()}>重放</button>
          </div>
        </div>
        <Timeline frames={frames} selected={selected} onSelect={setSelected} />
      </div>

      {detail && (
        <div className="panel">
          <h2>
            帧 #{detail.frameId} ·{" "}
            <span className={`tag ${detail.kind === "ext" ? "ext" : "std"}`}>
              {detail.kind === "ext" ? "扩展" : "标准"}
            </span>{" "}
            <span className="mono">0x{detail.arbId.toString(16).toUpperCase()}</span> ·{" "}
            {detail.messageName ? (
              <>消息定义 <b>{detail.messageName}</b>（DBC {detail.dbcVersionName}）</>
            ) : (
              <span className="error-text">{detail.error}</span>
            )}
          </h2>
          <div className="muted small" style={{ marginBottom: 10 }}>
            通道 {detail.channel} · 硬件时间 {detail.hwTime}s · 代次 {detail.gen} ·
            数据 <span className="mono">{detail.data.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")}</span>
            {detail.muxBranches.map((b) => (
              <span key={b.switch} style={{ marginLeft: 8 }}>
                mux <b>{b.switch}</b>=<b>{b.value}</b>{" "}
                {b.known ? <span className="tag active">分支已知</span> : <span className="tag unknown">分支未知·保留raw</span>}
              </span>
            ))}
          </div>

          {detail.messageName && (
            <>
              <BitLayout data={detail.data} signals={detail.signals} />
              <div className="scroll" style={{ marginTop: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>信号</th><th>bit 区间</th><th>DBC start</th><th>字节序</th>
                      <th>缩放/偏置</th><th>raw</th><th>物理值</th><th>枚举</th><th>多路复用</th><th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.signals.map((s) => (
                      <tr key={s.name} style={{ opacity: s.status === "inactive" ? 0.5 : 1 }}>
                        <td className="mono">{s.name}</td>
                        <td className="mono">{s.bits.map((r) => `[${r.first}..${r.last}]`).join(" ")}</td>
                        <td className="mono">{s.startBitDbc}|{s.length}</td>
                        <td>{s.order === "intel" ? "Intel/LE" : "Motorola/BE"}{s.signed ? " · 有符号" : ""}</td>
                        <td className="mono">×{s.scale} {s.offset >= 0 ? "+" : "-"} {Math.abs(s.offset)}</td>
                        <td className="mono">{s.raw}</td>
                        <td className="mono">{s.physical} {s.unit}</td>
                        <td>{s.enumText ?? <span className="muted">—</span>}</td>
                        <td className="small">
                          {s.mux.type === "switch" && "开关"}
                          {s.mux.type === "case" && `${s.mux.switchName}=${s.mux.value}`}
                          {s.mux.type === "plain" && "—"}
                        </td>
                        <td>
                          <span className={`tag ${s.status}`}>
                            {s.status === "active" ? "active" : s.status === "inactive" ? "不属于分支" : "未知分支·raw"}
                          </span>
                          {s.reason && <div className="muted small">{s.reason}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <div className="panel">
        <h2>信号曲线</h2>
        <SignalCurve frames={frames} />
      </div>
    </div>
  );
}

function Timeline({
  frames,
  selected,
  onSelect,
}: {
  frames: DecodedFrame[];
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const t0 = frames[0]?.hwTime ?? 0;
  const t1 = frames.at(-1)?.hwTime ?? 1;
  const span = Math.max(t1 - t0, 1e-9);
  return (
    <div className="scroll" style={{ maxHeight: 180 }}>
      <div style={{ position: "relative", height: 44, background: "#121a28", borderRadius: 6, marginBottom: 8 }}>
        {frames.map((f) => {
          const left = ((f.hwTime - t0) / span) * 100;
          const color = f.error
            ? "#ef5f67"
            : f.muxBranches.some((b) => !b.known)
              ? "#9b8cff"
              : f.kind === "ext"
                ? "#f2b84b"
                : "#4da3ff";
          return (
            <div
              key={f.frameId}
              title={`#${f.frameId} t=${f.hwTime} ${f.messageName ?? f.error ?? ""} [${f.dbcVersionName}]`}
              onClick={() => onSelect(f.frameId)}
              style={{
                position: "absolute",
                left: `${left}%`,
                top: 6,
                width: 5,
                height: 30,
                borderRadius: 2,
                background: color,
                outline: selected === f.frameId ? "2px solid #fff" : undefined,
                cursor: "pointer",
              }}
            />
          );
        })}
      </div>
      <table>
        <thead>
          <tr><th>#</th><th>硬件时间</th><th>代次</th><th>通道</th><th>ID</th><th>消息 / DBC 版本</th><th>DLC</th></tr>
        </thead>
        <tbody>
          {frames.map((f) => (
            <tr key={f.frameId} className="clickable" onClick={() => onSelect(f.frameId)}
              style={{ outline: selected === f.frameId ? "1px solid #4da3ff" : undefined }}>
              <td>{f.frameId}</td>
              <td className="mono">{f.hwTime}</td>
              <td>{f.gen}</td>
              <td>{f.channel}</td>
              <td>
                <span className={`tag ${f.kind}`}>{f.kind === "ext" ? "EXT" : "STD"}</span>{" "}
                <span className="mono">0x{f.arbId.toString(16).toUpperCase()}</span>
              </td>
              <td>
                {f.messageName ? (
                  <>{f.messageName} <span className="muted small">({f.dbcVersionName})</span></>
                ) : (
                  <span className="error-text small">{f.error}</span>
                )}
              </td>
              <td>{f.data.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
