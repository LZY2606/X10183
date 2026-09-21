import type { DatabaseSync } from "node:sqlite";
import { parseTrace } from "../core/dbc/trace";
import {
  insertFrames,
  listCounterRules,
  listCrcRules,
  listFrames,
  listVersions,
  resetCache,
  upsertCounterRule,
  upsertCrcRule,
} from "./repo";
import { replay } from "../core/replay";
import { checkCounters } from "../core/checks/counter";
import { checkCrcs } from "../core/checks/crc";
import {
  createSnapshot,
  getSnapshot,
  listSnapshots,
  snapshotStaleness,
} from "../core/snapshot";
import {
  VersionConflictError,
  decideMigration,
  diffVersions,
  ensureMigrations,
  listMigrations,
} from "../core/migration";
import { getMessages } from "./repo";

export interface ApiResponse {
  status: number;
  body: unknown;
}

export async function handleApi(
  db: DatabaseSync,
  method: string,
  path: string,
  rawBody: string,
): Promise<ApiResponse> {
  const json = (status: number, body: unknown): ApiResponse => ({ status, body });
  const ok = (body: unknown) => json(200, body);
  const body = rawBody ? safeJson(rawBody) : {};
  const query = path.includes("?") ? parseQuery(path.slice(path.indexOf("?") + 1)) : {};
  const route = path.split("?")[0].replace(/^\/api/, "");

  try {
    if (method === "GET" && route === "/health") return ok({ ok: true, app: "总线刻度" });

    if (method === "POST" && route === "/traces/import") {
      const { text, source } = body as { text?: string; source?: string };
      if (typeof text !== "string") return json(400, { error: "缺少 trace text" });
      const result = parseTrace(text, source ?? `import-${Date.now()}`);
      const ins = insertFrames(db, result.frames);
      return ok({ ...ins, parseErrors: result.errors, totalFrames: listFrames(db).length });
    }

    if (method === "GET" && route === "/frames") {
      return ok(listFrames(db));
    }

    if (method === "POST" && route === "/dbc") {
      const { name, sourceText, effectiveFrom, effectiveTo } = body as {
        name?: string;
        sourceText?: string;
        effectiveFrom?: number;
        effectiveTo?: number | null;
      };
      if (!name || typeof sourceText !== "string") return json(400, { error: "缺少 name/sourceText" });
      const v = await importDbcSync(db, {
        name,
        sourceText,
        effectiveFrom: Number(effectiveFrom ?? 0),
        effectiveTo: effectiveTo === undefined ? null : effectiveTo,
      });
      resetCache(db);
      return ok(v);
    }

    if (method === "GET" && route === "/dbc") {
      return ok(listVersions(db).map((v) => ({ ...v, messages: getMessages(db, v.id) })));
    }

    if (method === "GET" && route === "/replay") {
      const forced = query.version ? Number(query.version) : undefined;
      const gen = query.gen ? String(query.gen) : undefined;
      return ok(replay(db, { forcedVersionId: forced, gen }));
    }

    if (method === "GET" && route === "/timeline") {
      const decoded = replay(db);
      return ok(
        decoded.map((f) => ({
          frameId: f.frameId,
          channel: f.channel,
          hwTime: f.hwTime,
          gen: f.gen,
          arbId: f.arbId,
          kind: f.kind,
          messageName: f.messageName,
          dbcVersionId: f.dbcVersionId,
          dbcVersionName: f.dbcVersionName,
          dlc: f.data.length,
          error: f.error,
        })),
      );
    }

    if (method === "GET" && /^\/frames\/\d+$/.test(route)) {
      const id = Number(route.split("/").pop());
      const forced = query.version ? Number(query.version) : undefined;
      const f = replay(db, forced !== undefined ? { forcedVersionId: forced } : {}).find(
        (x) => x.frameId === id,
      );
      return f ? ok(f) : json(404, { error: "帧不存在" });
    }

    if (method === "GET" && route === "/checks/counters") {
      return ok(checkCounters(db, listCounterRules(db)));
    }

    if (method === "GET" && route === "/checks/crc") {
      return ok(checkCrcs(db, listCrcRules(db)));
    }

    if (method === "PUT" && route === "/rules/counter") {
      upsertCounterRule(db, body as never);
      return ok(listCounterRules(db));
    }

    if (method === "PUT" && route === "/rules/crc") {
      upsertCrcRule(db, body as never);
      return ok(listCrcRules(db));
    }

    if (method === "GET" && route === "/rules") {
      return ok({ counters: listCounterRules(db), crcs: listCrcRules(db) });
    }

    if (method === "POST" && route === "/snapshots") {
      const { name, frameIds } = body as { name?: string; frameIds?: number[] };
      return ok(createSnapshot(db, name ?? `snapshot-${Date.now()}`, frameIds));
    }

    if (method === "GET" && route === "/snapshots") {
      return ok(
        listSnapshots(db).map((s) => ({ ...s, staleness: snapshotStaleness(db, s) })),
      );
    }

    if (method === "GET" && /^\/snapshots\/\d+$/.test(route)) {
      const id = Number(route.split("/").pop());
      const s = getSnapshot(db, id);
      if (!s) return json(404, { error: "快照不存在" });
      return ok({ ...s, staleness: snapshotStaleness(db, s) });
    }

    if (method === "GET" && route === "/diff") {
      const from = Number(query.from);
      const to = Number(query.to);
      if (!from || !to) return json(400, { error: "需要 from/to 版本 id" });
      return ok(diffVersions(db, from, to));
    }

    if (method === "GET" && route === "/compare") {
      const from = Number(query.from);
      const to = Number(query.to);
      if (!from || !to) return json(400, { error: "需要 from/to 版本 id" });
      const framesA = replay(db, { forcedVersionId: from });
      const framesB = replay(db, { forcedVersionId: to });
      const byIdA = new Map(framesA.map((f) => [f.frameId, f]));
      const rows = framesB.map((b) => {
        const a = byIdA.get(b.frameId)!;
        return {
          frameId: b.frameId,
          hwTime: b.hwTime,
          channel: b.channel,
          gen: b.gen,
          arbId: b.arbId,
          kind: b.kind,
          fromVersion: { id: from, name: a.dbcVersionName, decoded: a },
          toVersion: { id: to, name: b.dbcVersionName, decoded: b },
        };
      });
      return ok(rows);
    }

    if (method === "POST" && route === "/migrations/ensure") {
      const { fromVersionId, toVersionId } = body as { fromVersionId?: number; toVersionId?: number };
      if (!fromVersionId || !toVersionId) return json(400, { error: "需要版本 id" });
      return ok(ensureMigrations(db, fromVersionId, toVersionId));
    }

    if (method === "GET" && route === "/migrations") {
      return ok(listMigrations(db));
    }

    if (method === "POST" && /^\/migrations\/\d+\/(approve|reject)$/.test(route)) {
      const parts = route.split("/");
      const id = Number(parts[2]);
      const decision = parts[3] === "approve" ? "approved" : "rejected";
      const { expectedLock } = body as { expectedLock?: number };
      if (typeof expectedLock !== "number") return json(400, { error: "缺少 expectedLock（并发版本号）" });
      try {
        return ok(decideMigration(db, id, decision, expectedLock));
      } catch (e) {
        if (e instanceof VersionConflictError) return json(409, { error: e.message, currentLock: e.current });
        throw e;
      }
    }

    if (method === "POST" && route === "/demo") {
      const { seedDemo } = await import("./demo");
      return ok(seedDemo(db));
    }

    return json(404, { error: `未找到路由：${method} ${route}` });
  } catch (e) {
    return json(400, { error: (e as Error).message });
  }
}

async function importDbcSync(
  db: DatabaseSync,
  input: { name: string; sourceText: string; effectiveFrom: number; effectiveTo: number | null },
) {
  const { importDbcVersion } = await import("./repo");
  return importDbcVersion(db, input);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

function parseQuery(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split("&")) {
    if (!part) continue;
    const [k, v = ""] = part.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}
