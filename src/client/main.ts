import "./style.css";
import { api, dataHex, type AppState, type DecodedFrame } from "./api.js";
import { renderTimeline } from "./views/timeline.js";
import { renderBits } from "./views/bits.js";
import { renderCurves } from "./views/curves.js";
import { renderCounters } from "./views/counters.js";
import { renderCrc } from "./views/crc.js";
import { renderCompare } from "./views/compare.js";
import { renderSnapshots } from "./views/snapshots.js";
import { bindCompare } from "./views/compare.js";

let state: AppState | null = null;
let activeTab = "timeline";
export let selectedFrameId: number | null = null;

export function setSelectedFrame(id: number | null): void {
  selectedFrameId = id;
  rerender();
}

export async function refresh(): Promise<void> {
  const sel = document.querySelector<HTMLSelectElement>("#versionSelect")!;
  const version = sel?.value ?? "auto";
  state = await api<AppState>(`/api/state?version=${encodeURIComponent(version)}`);
  rerender();
}

function rerender(): void {
  if (!state) return;
  const main = document.querySelector<HTMLElement>("#main")!;
  const frame = state.frames.find((f) => f.view.frame.id === selectedFrameId) ?? null;
  switch (activeTab) {
    case "timeline":
      main.innerHTML = renderTimeline(state, frame);
      break;
    case "bits":
      main.innerHTML = renderBits(state, frame);
      break;
    case "curves":
      main.innerHTML = renderCurves(state);
      break;
    case "counters":
      main.innerHTML = renderCounters(state);
      break;
    case "crc":
      main.innerHTML = renderCrc(state);
      break;
    case "compare":
      main.innerHTML = renderCompare(state);
      break;
    case "snapshots":
      main.innerHTML = renderSnapshots(state);
      break;
  }
  bindEvents(main);
}

function bindEvents(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("[data-frame-id]").forEach((el) => {
    el.addEventListener("click", () => setSelectedFrame(Number(el.dataset.frameId)));
  });
  root.querySelectorAll<HTMLElement>("[data-tab-go]").forEach((el) => {
    el.addEventListener("click", () => {
      activeTab = el.dataset.tabGo!;
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.textContent?.includes(tabLabel(activeTab)) ?? false));
      rerender();
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-approve]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.approve);
      const lock = Number(btn.dataset.lock);
      const decision = btn.dataset.decision as "approved" | "incompatible";
      try {
        await api("/api/mappings/approve", {
          method: "POST",
          body: JSON.stringify({ id, lock, decision })
        });
        await refresh();
      } catch (e) {
        alert((e as Error).message);
      }
    });
  });
  if (activeTab === "compare") bindCompare(getState());
  const snapshotBtn = root.querySelector<HTMLButtonElement>("#doSnapshot");
  if (snapshotBtn) {
    snapshotBtn.addEventListener("click", async () => {
      const label = root.querySelector<HTMLInputElement>("#snapshotLabel")!.value;
      const versionId = Number(root.querySelector<HTMLSelectElement>("#snapshotVersion")!.value);
      await api("/api/snapshots", { method: "POST", body: JSON.stringify({ label: label || `快照 ${new Date().toLocaleString()}`, versionId }) });
      await refresh();
    });
  }
}

function tabLabel(tab: string): string {
  const map: Record<string, string> = {
    timeline: "帧时间轴",
    bits: "Bit",
    curves: "信号曲线",
    counters: "计数器",
    crc: "CRC",
    compare: "版本对比",
    snapshots: "快照"
  };
  return map[tab] ?? tab;
}

function initChrome(): void {
  document.querySelectorAll<HTMLElement>(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeTab = btn.dataset.tab!;
      rerender();
    });
  });
  document.querySelector<HTMLButtonElement>("#refreshBtn")!.addEventListener("click", refresh);
  document.querySelector<HTMLButtonElement>("#snapshotBtn")!.addEventListener("click", () => {
    activeTab = "snapshots";
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === "snapshots"));
    rerender();
  });
}

async function init(): Promise<void> {
  initChrome();
  state = await api<AppState>("/api/state?version=auto");
  const sel = document.querySelector<HTMLSelectElement>("#versionSelect")!;
  sel.innerHTML =
    `<option value="auto">自动（按帧时间生效区间）</option>` +
    state.versions
      .map((v) => `<option value="${v.id}">v${v.versionNumber} · ${v.name}</option>`)
      .join("");
  sel.addEventListener("change", rerender);
  rerender();
}

export function getState(): AppState {
  if (!state) throw new Error("state not loaded");
  return state;
}

export { activeTab };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
export function fmtTime(ns: string): string {
  const n = BigInt(ns);
  const ms = Number(n / 1_000_000n);
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "") + "." + (n % 1_000_000n).toString().padStart(6, "0");
}

void init();
