import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  allFrameViews,
  approveMapping,
  compareVersions,
  counterAnalysis,
  crcAnalysis,
  createSnapshot,
  decodeWithVersion,
  importDbc,
  importTrace,
  listSnapshots,
  proposeMappings,
  OptimisticLockError
} from "./service.js";
import {
  loadCrcRules,
  loadCounterRules,
  loadDbcVersions,
  loadMappings,
  loadMessageDefs
} from "./db.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

export function createApiHandler(db: DatabaseSync) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname;
    if (!path.startsWith("/api/")) return false;

    try {
      if (req.method === "GET" && path === "/api/state") {
        const forced = url.searchParams.get("version");
        const forcedId = forced === null || forced === "auto" ? null : Number(forced);
        const versions = loadDbcVersions(db);
        const decoded = decodeWithVersion(db, forcedId);
        const definitions = new Map(
          versions.map((v) => [v.id, loadMessageDefs(db, v.id)])
        );
        return sendJson(res, 200, {
          versions,
          definitions: Object.fromEntries(definitions),
          batches: allFrameViews(db).reduce<Record<string, unknown[]>>((acc, view) => {
            (acc[view.generation] ??= []).push(view);
            return acc;
          }, {}),
          frames: decoded,
          counters: counterAnalysis(db),
          crc: crcAnalysis(db),
          mappings: loadMappings(db),
          counterRules: loadCounterRules(db),
          crcRules: loadCrcRules(db),
          snapshots: listSnapshots(db)
        }), true;
      }

      if (req.method === "POST" && path === "/api/import/trace") {
        const body = JSON.parse(await readBody(req)) as {
          text: string;
          label: string;
          generation: string;
        };
        const result = importTrace(db, body.text, { label: body.label, generation: body.generation });
        return sendJson(res, 200, result), true;
      }

      if (req.method === "POST" && path === "/api/import/dbc") {
        const body = JSON.parse(await readBody(req)) as {
          text: string;
          name?: string;
          versionNumber?: number;
          effectiveFromNs?: string | null;
          effectiveToNs?: string | null;
        };
        try {
          const version = importDbc(db, body.text, body);
          return sendJson(res, 200, version), true;
        } catch (e) {
          return sendJson(res, 409, { error: (e as Error).message }), true;
        }
      }

      if (req.method === "GET" && path === "/api/compare") {
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        return sendJson(res, 200, compareVersions(db, from, to)), true;
      }

      if (req.method === "POST" && path === "/api/mappings/propose") {
        const body = JSON.parse(await readBody(req)) as { from: number; to: number };
        return sendJson(res, 200, proposeMappings(db, body.from, body.to)), true;
      }

      if (req.method === "POST" && path === "/api/mappings/approve") {
        const body = JSON.parse(await readBody(req)) as {
          id: number;
          lock: number;
          decision: "approved" | "incompatible";
          note?: string | null;
        };
        try {
          const mapping = approveMapping(db, body.id, body.lock, body.decision, body.note ?? null);
          return sendJson(res, 200, mapping), true;
        } catch (e) {
          const status = e instanceof OptimisticLockError ? 409 : 400;
          return sendJson(res, status, { error: (e as Error).message }), true;
        }
      }

      if (req.method === "POST" && path === "/api/snapshots") {
        const body = JSON.parse(await readBody(req)) as {
          label: string;
          versionId: number;
          frameIds?: number[];
        };
        return sendJson(res, 200, createSnapshot(db, body.label, body.versionId, body.frameIds)), true;
      }

      if (req.method === "GET" && path === "/api/snapshots") {
        return sendJson(res, 200, listSnapshots(db)), true;
      }

      if (req.method === "GET" && path === "/api/counters") {
        return sendJson(res, 200, counterAnalysis(db)), true;
      }

      if (req.method === "GET" && path === "/api/crc") {
        return sendJson(res, 200, crcAnalysis(db)), true;
      }

      sendJson(res, 404, { error: "未知接口" });
      return true;
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
      return true;
    }
  };
}
