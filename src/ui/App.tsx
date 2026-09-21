import { useCallback, useState } from "react";
import { ImportTab } from "./tabs/ImportTab";
import { ReplayTab } from "./tabs/ReplayTab";
import { ChecksTab } from "./tabs/ChecksTab";
import { CompareTab } from "./tabs/CompareTab";
import { SnapshotsTab } from "./tabs/SnapshotsTab";
import { DbcTab } from "./tabs/DbcTab";

const TABS = [
  { id: "replay", name: "帧时间轴 / 重放" },
  { id: "import", name: "导入 trace / DBC" },
  { id: "dbc", name: "DBC 版本" },
  { id: "checks", name: "计数器缺口 / CRC 证据" },
  { id: "compare", name: "版本对比 / 迁移审批" },
  { id: "snapshots", name: "调查快照" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

export function App() {
  const [tab, setTab] = useState<TabId>("replay");
  const [toast, setToast] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const refresh = useCallback(() => setEpoch((e) => e + 1), []);

  return (
    <div>
      <header>
        <h1>总线刻度</h1>
        <span className="sub">Bus Scale · CAN trace 按采集时点重放 · 版本化 DBC 解码</span>
      </header>
      <nav>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.name}
          </button>
        ))}
      </nav>
      <main>
        {tab === "replay" && <ReplayTab epoch={epoch} notify={notify} />}
        {tab === "import" && (
          <ImportTab
            epoch={epoch}
            notify={(m) => {
              notify(m);
              refresh();
            }}
          />
        )}
        {tab === "dbc" && <DbcTab epoch={epoch} notify={notify} onChanged={refresh} />}
        {tab === "checks" && <ChecksTab epoch={epoch} notify={notify} />}
        {tab === "compare" && <CompareTab epoch={epoch} notify={notify} />}
        {tab === "snapshots" && <SnapshotsTab epoch={epoch} notify={notify} />}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
