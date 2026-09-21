import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type { DbcVersion, MessageDef } from "../../core/types";

type VersionRow = DbcVersion & { messages: MessageDef[] };

export function DbcTab({
  epoch,
  notify,
  onChanged,
}: {
  epoch: number;
  notify: (m: string) => void;
  onChanged: () => void;
}) {
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);

  async function load() {
    setVersions(await api.get<VersionRow[]>("/dbc"));
  }
  useEffect(() => {
    load().catch((e) => notify(e.message));
  }, [epoch]);

  return (
    <div className="panel">
      <h2>DBC 版本与生效区间</h2>
      <table>
        <thead>
          <tr>
            <th>id</th><th>版本</th><th>生效区间（半开）</th><th>消息数</th><th>消息（arb id / 字节序）</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <Fragment key={v.id}>
              <tr className="clickable" onClick={() => setOpenId(openId === v.id ? null : v.id)}>
                <td>{v.id}</td>
                <td className="mono">{v.name}</td>
                <td className="mono">
                  [{v.effectiveFrom}, {v.effectiveTo === null ? "∞" : v.effectiveTo})
                </td>
                <td>{v.messages.length}</td>
                <td>
                  {v.messages.map((m) => (
                    <span key={`${m.kind}-${m.arbId}`} className="tag mono" style={{ marginRight: 6 }}>
                      {m.kind === "ext" ? "EXT" : "STD"} 0x{m.arbId.toString(16).toUpperCase()} {m.name}
                    </span>
                  ))}
                </td>
              </tr>
              {openId === v.id && (
                <tr>
                  <td colSpan={5}>
                    <pre className="mono small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
                      {v.sourceText}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {versions.length === 0 && <p className="muted small">还没有 DBC。先到“导入”页载入演示数据集。</p>}
      <button className="act secondary" style={{ marginTop: 10 }} onClick={() => { load(); onChanged(); }}>
        刷新
      </button>
    </div>
  );
}
