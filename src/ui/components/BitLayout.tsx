import type { DecodedSignal } from "../../core/types";

const SIG_COLORS = [
  "#4da3ff", "#37c978", "#f2b84b", "#ef5f67", "#9b8cff",
  "#46d6d6", "#f28ac2", "#8fce5a", "#e08a4e", "#7aa2f7",
];

/** 字节 × bit 网格（bit0=字节最低位），高亮每个信号的确切 bit 区间。 */
export function BitLayout({
  data,
  signals,
  selected,
}: {
  data: number[];
  signals: DecodedSignal[];
  selected?: string | null;
}) {
  const active = signals.filter((s) => s.status !== "inactive");
  const colorOf = new Map<string, string>();
  active.forEach((s, i) => colorOf.set(s.name, SIG_COLORS[i % SIG_COLORS.length]));

  const dlc = Math.max(8, data.length);
  const ownerAt = new Map<number, DecodedSignal>();
  for (const s of active) {
    for (const range of s.bits) for (let b = range.first; b <= range.last; b++) ownerAt.set(b, s);
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        {active.map((s) => (
          <span key={s.name} className="small mono">
            <span className="legendbox" style={{ background: colorOf.get(s.name) }} />
            {s.name} {s.bits.map((r) => `[${r.first}..${r.last}]`).join("")}
            {s.status === "unknown" && <span className="tag unknown">未知分支·保留raw</span>}
          </span>
        ))}
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        {Array.from({ length: dlc }, (_, byteIdx) => {
          const byteVal = data[byteIdx] ?? 0;
          return (
            <div key={byteIdx} style={{ textAlign: "center" }}>
              <div className="bytecell" style={{ marginBottom: 4 }}>
                <span className="muted">byte{byteIdx}</span>
                <span>{byteVal.toString(16).toUpperCase().padStart(2, "0")}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {[7, 6, 5, 4, 3, 2, 1, 0].map((bit) => {
                  const linear = byteIdx * 8 + bit;
                  const sig = ownerAt.get(linear);
                  const dim = sig && sig.status === "unknown";
                  return (
                    <div
                      key={bit}
                      className="bitbox"
                      title={sig ? `${sig.name} bit${linear}` : `bit${linear}`}
                      style={{
                        background: sig ? colorOf.get(sig.name) : "transparent",
                        opacity: dim ? 0.45 : 1,
                        outline: selected && sig?.name === selected ? "2px solid #fff" : undefined,
                        color: "#08111f",
                      }}
                    >
                      {bit}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
