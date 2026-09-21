import { useEffect, useState } from "react";
import { api } from "../api";
import type { DbcVersion, MigrationRecord, VersionDiff } from "../../core/types";

export function CompareTab({ notify }: { epoch: number; notify: (m: string) => void }) {
  const [versions, setVersions] = useState<DbcVersion[]>([]);
  const [from, setFrom] = useState<number | "">("");
  const [to, setTo] = useState<number | "">("");
  const [diff, setDiff] = useState<{ from: string; to: string; diffs: VersionDiff[] } | null>(null);
  const [migrations, setMigrations] = useState<MigrationRecord[]>([]);
  const [frameIdx, setFrameIdx] = useState(0);
  const [compareRows, setCompareRows] = useState<CompareRow[]>([]);

  async function loadVersions() {
    const all = await api.get<(DbcVersion & { messages?: unknown[] })[]>("/dbc");
    setVersions(all.map(({ messages, ...v }) => v));
    if (all.length >= 2) {
      setFrom(all[0].id);
      setTo(all[1].id);
    }
  }
  useEffect(() => {
    loadVersions().catch((e) => notify(e.message));
  }, []);

  async function runDiff() {
    if (!from || !to) return;
    try {
      const d = await api.get<{ from: string; to: string; diffs: VersionDiff[] }>(
        `/diff?from=${from}&to=${to}`,
      );
      setDiff(d);
      const ms = await api.post<MigrationRecord[]>("/migrations/ensure", {
        fromVersionId: Number(from),
        toVersionId: Number(to),
      });
      setMigrations(ms);
      const rows = await api.get<CompareRow[]>(`/compare?from=${from}&to=${to}`);
      setCompareRows(rows);
      setFrameIdx(0);
    } catch (e) {
      notify((e as Error).message);
    }
  }

  async function decide(m: MigrationRecord, decision: "approved" | "rejected", lockOverride?: number) {
    try {
      await api.post(`/migrations/${m.id}/${decision === "approved" ? "approve" : "reject"}`, {
        expectedLock: lockOverride ?? m.lockVersion,
      });
      notify(`消息「${m.messageName}」迁移已${decision === "approved" ? "批准" : "标记无法兼容"}（lock v${m.lockVersion} → v${m.lockVersion + 1}）`);
      const ms = await api.get<MigrationRecord[]>("/migrations");
      setMigrations(ms);
    } catch (e) {
      notify((e as Error).message);
    }
  }

  const row = compareRows[frameIdx];

  return (
    <div>
      <div className="panel">
        <h2>比较两个 DBC 版本对同一批帧的影响</h2>
        <div className="row">
          <select value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {versions.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <span>→</span>
          <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
            {versions.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
          <button className="act" onClick={runDiff}>比较</button>
        </div>
      </div>

      {diff && (
        <div className="panel">
          <h2>迁移映射（{diff.from} → {diff.to}）</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>消息</th><th>ID</th><th>结论</th><th>信号映射</th><th>审批（乐观锁 v{migrations[0]?.lockVersion ?? 1}）</th></tr>
              </thead>
              <tbody>
                {diff.diffs.map((d) => {
                  const mig = migrations.find((m) => m.messageName === d.messageName);
                  return (
                    <tr key={`${d.kind}-${d.arbId}`}>
                      <td className="mono">{d.messageName}</td>
                      <td className="mono">
                        <span className={`tag ${d.kind}`}>{d.kind}</span> 0x{d.arbId.toString(16).toUpperCase()}
                      </td>
                      <td><span className={`tag ${d.status}`}>{d.status}</span><div className="small muted">{d.summary}</div></td>
                      <td>
                        {d.mappings.map((mp) => (
                          <div key={mp.signalName} className="small">
                            <span className={`tag ${mp.classification}`}>{mp.classification}</span>{" "}
                            <span className="mono">{mp.oldSignal ?? "∅"} → {mp.newSignal ?? "∅"}</span>
                            <span className="muted"> {mp.note}</span>
                          </div>
                        ))}
                      </td>
                      <td>
                        {mig ? (
                          <>
                            <div className="small muted">当前：{mig.status} · lock v{mig.lockVersion}</div>
                            <div className="row" style={{ marginTop: 4 }}>
                              <button className="act" disabled={mig.status !== "pending"}
                                onClick={() => decide(mig, "approved")}>批准迁移映射</button>
                              <button className="act danger" disabled={mig.status !== "pending"}
                                onClick={() => decide(mig, "rejected")}>标记无法兼容</button>
                            </div>
                            <details className="small" style={{ marginTop: 4 }}>
                              <summary>模拟并发：用过期版本号 v{Math.max(mig.lockVersion - 1, 1)} 提交</summary>
                              <div className="row" style={{ marginTop: 4 }}>
                                <button className="act secondary"
                                  onClick={() => decide(mig, "approved", Math.max(mig.lockVersion - 1, 1))}>
                                  用旧 lock v{Math.max(mig.lockVersion - 1, 1)} 抢批（应 409）
                                </button>
                              </div>
                            </details>
                          </>
                        ) : <span className="muted small">{d.status === "added" ? "新增消息" : "删除消息"}，无映射</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {row && (
        <div className="panel">
          <h2>同一帧在两个版本下的解码对比</h2>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="act secondary" disabled={frameIdx === 0} onClick={() => setFrameIdx(frameIdx - 1)}>上一帧</button>
            <span className="small">#{row.frameId} t={row.hwTime}s {row.gen} 0x{row.arbId.toString(16).toUpperCase()} ({row.kind})</span>
            <button className="act secondary" disabled={frameIdx >= compareRows.length - 1} onClick={() => setFrameIdx(frameIdx + 1)}>下一帧</button>
          </div>
          <div className="grid2">
            <DecodedColumn title={`${row.fromVersion.name} (v${row.fromVersion.id})`} frame={row.fromVersion.decoded} />
            <DecodedColumn title={`${row.toVersion.name} (v${row.toVersion.id})`} frame={row.toVersion.decoded} />
          </div>
        </div>
      )}
    </div>
  );
}

function DecodedColumn({ title, frame }: { title: string; frame: CompareRow["fromVersion"]["decoded"] }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 10 }}>
      <div className="small muted" style={{ marginBottom: 6 }}>{title}</div>
      {frame.error ? <div className="error-text small">{frame.error}</div> : (
        <table>
          <tbody>
            {frame.signals.filter((s) => s.status !== "inactive").map((s) => (
              <tr key={s.name}>
                <td className="mono small">{s.name}</td>
                <td className="mono small muted">{s.bits.map((r) => `[${r.first}..${r.last}]`).join(" ")}</td>
                <td className="mono small">raw {s.raw}</td>
                <td className="mono small">{s.physical} {s.unit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface CompareRow {
  frameId: number;
  hwTime: number;
  channel: string;
  gen: string;
  arbId: number;
  kind: "std" | "ext";
  fromVersion: { id: number; name: string; decoded: import("../../core/types").DecodedFrame };
  toVersion: { id: number; name: string; decoded: import("../../core/types").DecodedFrame };
}
