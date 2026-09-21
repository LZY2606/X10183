import { useMemo, useState } from "react";
import type { DecodedFrame } from "../../core/types";

/** 信号物理值曲线（内联 SVG），X 轴为硬件时间；悬停显示帧。 */
export function SignalCurve({ frames }: { frames: DecodedFrame[] }) {
  const signalNames = useMemo(() => {
    const names = new Set<string>();
    for (const f of frames)
      for (const s of f.signals) if (s.status === "active") names.add(s.name);
    return [...names];
  }, [frames]);
  const [name, setName] = useState<string>(signalNames[0] ?? "");

  const points = useMemo(() => {
    const out: { t: number; v: number; f: DecodedFrame; raw: number; enumText: string | null }[] = [];
    for (const f of frames) {
      const sig = f.signals.find((s) => s.name === name && s.status === "active");
      if (sig) out.push({ t: f.hwTime, v: sig.physical, f, raw: sig.raw, enumText: sig.enumText });
    }
    return out;
  }, [frames, name]);

  if (signalNames.length === 0) return <div className="muted small">当前批次没有可绘制的信号</div>;

  const w = 760;
  const h = 220;
  const pad = 42;
  const t0 = points[0]?.t ?? 0;
  const t1 = points.at(-1)?.t ?? 1;
  const vs = points.map((p) => p.v);
  const vMin = Math.min(...vs, 0);
  const vMax = Math.max(...vs, 1);
  const x = (t: number) => pad + ((t - t0) / Math.max(t1 - t0, 1e-9)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - vMin) / Math.max(vMax - vMin, 1e-9)) * (h - pad * 2);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <select value={name} onChange={(e) => setName(e.target.value)}>
          {signalNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="muted small">
          {points.length} 个采样点 · 物理值范围 {vMin.toFixed(2)} ~ {vMax.toFixed(2)}
        </span>
      </div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: "#121a28", borderRadius: 6 }}>
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <line key={g} x1={pad} x2={w - pad} y1={pad + g * (h - pad * 2)} y2={pad + g * (h - pad * 2)} stroke="#23304a" />
        ))}
        <path d={path} fill="none" stroke="#4da3ff" strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.v)} r={3} fill="#4da3ff">
            <title>{`t=${p.t}s raw=${p.raw} phys=${p.v}${p.enumText ? ` (${p.enumText})` : ""} gen=${p.f.gen}`}</title>
          </circle>
        ))}
        <text x={pad} y={16} fill="#8a99b3" fontSize={11}>
          {name}
        </text>
        <text x={pad} y={h - 12} fill="#8a99b3" fontSize={10}>
          {t0}s
        </text>
        <text x={w - pad - 30} y={h - 12} fill="#8a99b3" fontSize={10}>
          {t1}s
        </text>
      </svg>
    </div>
  );
}
