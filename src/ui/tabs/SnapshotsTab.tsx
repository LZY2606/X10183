import { useEffect, useState } from "react";
import { api } from "../api";

interface SnapshotView {
  id: number;
  name: string;
  createdAt: number;
  entries: { frameId: number; dbcVersionId: number; messageName: string | null; error: string | null }[];
  staleness: { frameId: number; frozenVersionId: number; currentVersionId: number | null; expired: boolean }[];
}

export function SnapshotsTab({ epoch, notify }: { epoch: number; notify: (m: string) => void }) {
  const [snaps, setSnaps] = useState<SnapshotView[]>([]);
  const [name, setName] = useState("");

  async function load() {
    setSnaps(await api.get<SnapshotView[]>("/snapshots"));
  }
  useEffect(() => {
    load().catch((e) => notify(e.message));
  }, [epoch]);

  async function createSnap() {
    try {
      const s = await api.post<SnapshotView>("/snapshots", { name: name || `调查-${new Date().toISOString().slice(11, 19)}` });
      notify(`快照「${s.name}」已冻结 ${s.entries.length} 条帧解码，继续指向当时的 DBC 定义`);
      setName("");
      load();
    } catch (e) {
      notify((e as Error).message);
    }
  }

  return (
    <div className="panel">
      <h2>冻结的调查快照（DBC 修订后仅受生效区间影响的解码变为过期）</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="快照名称" style={{ width: 240 }} />
        <button className="act" onClick={createSnap}>冻结当前重放结果</button>
      </div>
      <table>
        <thead>
          <tr><th>id</th><th>名称</th><th>冻结时间</th><th>帧数</th><th>当前已过期</th><th>版本指向</th></tr>
        </thead>
        <tbody>
          {snaps.map((s) => {
            const expired = s.staleness.filter((x) => x.expired).length;
            return (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td className="mono">{s.name}</td>
                <td className="small">{new Date(s.createdAt).toLocaleString()}</td>
                <td>{s.entries.length}</td>
                <td>
                  {expired === 0 ? (
                    <span className="tag pass">仍全部有效</span>
                  ) : (
                    <span className="tag fail">{expired} 帧过期（快照仍指向旧定义）</span>
                  )}
                </td>
                <td className="small mono">
                  {[...new Set(s.entries.map((e) => e.dbcVersionId))].map((v) => (
                    <span key={v} className="tag" style={{ marginRight: 4 }}>v{v}</span>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {snaps.length === 0 && <p className="muted small">冻结后即使导入新的 DBC 修订，快照中每帧仍记录创建时的确切版本 id。</p>}
    </div>
  );
}
