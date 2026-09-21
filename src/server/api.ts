import type { Connect, Plugin } from 'vite';
import type { DbHandle } from './db.js';
import { listDbcVersions, storeDbc, storeTrace } from './db.js';
import { parseTrace } from '../core/trace.js';
import {
  compareVersions,
  freezeSnapshot,
  interpretAllFrames,
  interpretFrame,
  readSnapshot,
  runCounterChecks,
  runCrcChecks,
  signalCurve,
} from './analysis.js';
import {
  listCounterConfigs,
  listCrcConfigs,
  listFrames,
  listMigrationMaps,
  listSnapshots,
  putMigrationMap,
  approveMigrationMap,
  upsertCounterConfig,
  upsertCrcConfig,
} from './repositories.js';

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function apiPlugin(handle: DbHandle): Plugin {
  return {
    name: 'bus-scale-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res, next) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const path = url.pathname;
          const method = req.method ?? 'GET';

          if (method === 'GET' && path === '/state') {
            const frames = handle.db
              .prepare(
                `SELECT f.*, ti.ordinal AS import_ordinal FROM frames f
                 JOIN trace_imports ti ON ti.id = f.import_id
                 ORDER BY f.hw_time, f.id LIMIT 2000`
              )
              .all() as Record<string, unknown>[];
            const counts = handle.db
              .prepare('SELECT arbitration_id, is_extended, COUNT(*) AS n FROM frames GROUP BY 1,2')
              .all();
            json(res, 200, {
              versions: listDbcVersions(handle),
              imports: handle.db.prepare('SELECT * FROM trace_imports ORDER BY id').all(),
              frameCount: handle.db.prepare('SELECT COUNT(*) AS n FROM frames').get(),
              messages: counts,
              frames: frames.map((r) => ({
                id: Number(r.id),
                importId: Number(r.import_id),
                importOrdinal: Number(r.import_ordinal),
                generation: Number(r.generation),
                channel: Number(r.channel),
                arbitrationId: Number(r.arbitration_id),
                isExtended: Number(r.is_extended) === 1,
                direction: String(r.direction),
                hwTime: Number(r.hw_time),
                dlc: Number(r.dlc),
                data: Array.from((r.data as Buffer).values())
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join(' '),
              })),
              snapshots: listSnapshots(handle),
              counterConfigs: listCounterConfigs(handle),
              crcConfigs: listCrcConfigs(handle),
            });
            return;
          }

          if (method === 'POST' && path === '/import/trace') {
            const body = JSON.parse(await readBody(req)) as { text: string; name?: string };
            const { frames, errors } = parseTrace(body.text ?? '');
            const result = storeTrace(handle, body.name ?? 'pasted-trace.csv', frames);
            const interp = interpretAllFrames(handle);
            json(res, 200, { ...result, parseErrors: errors, ...interp });
            return;
          }

          if (method === 'POST' && path === '/import/dbc') {
            const body = JSON.parse(await readBody(req)) as {
              content: string;
              versionNumber: number;
              label: string;
              validFrom: number;
              validTo?: number | null;
              sourceName?: string;
            };
            const stored = storeDbc(handle, body.content, {
              versionNumber: body.versionNumber,
              label: body.label,
              validFrom: body.validFrom,
              validTo: body.validTo ?? null,
              sourceName: body.sourceName ?? `v${body.versionNumber}.dbc`,
            });
            const interp = interpretAllFrames(handle);
            json(res, 200, { version: stored, ...interp });
            return;
          }

          if (method === 'GET' && path === '/frames') {
            const idParam = url.searchParams.get('id');
            const extParam = url.searchParams.get('extended');
            const genParam = url.searchParams.get('generation');
            const rows = listFrames(handle, {
              id: idParam === null ? undefined : Number(idParam),
              isExtended: extParam === null ? undefined : extParam === '1',
              generation: genParam === null ? undefined : Number(genParam),
            });
            json(res, 200, rows);
            return;
          }

          if (method === 'GET' && path.startsWith('/frames/')) {
            const frameId = Number(path.split('/')[2]);
            const versionParam = url.searchParams.get('versionId');
            const interp = interpretFrame(
              handle,
              frameId,
              versionParam === null ? undefined : Number(versionParam)
            );
            if (!interp) return json(res, 404, { error: 'frame not found' });
            json(res, 200, interp);
            return;
          }

          if (method === 'GET' && path === '/curve') {
            const messageId = Number(url.searchParams.get('messageId'));
            const isExtended = url.searchParams.get('extended') === '1';
            const signalName = String(url.searchParams.get('signal'));
            const versionParam = url.searchParams.get('versionId');
            json(
              res,
              200,
              signalCurve(
                handle,
                messageId,
                isExtended,
                signalName,
                versionParam === null ? undefined : Number(versionParam)
              )
            );
            return;
          }

          if (method === 'GET' && path === '/analyze/counters') {
            json(res, 200, runCounterChecks(handle));
            return;
          }

          if (method === 'GET' && path === '/analyze/crc') {
            json(res, 200, runCrcChecks(handle));
            return;
          }

          if (method === 'POST' && path === '/config/counters') {
            const body = JSON.parse(await readBody(req));
            upsertCounterConfig(handle, {
              messageKey: body.messageKey,
              arbitrationId: body.arbitrationId,
              isExtended: body.isExtended,
              node: body.node,
              signalName: body.signalName,
              modulus: body.modulus,
              increment: body.increment,
            });
            json(res, 200, { ok: true });
            return;
          }

          if (method === 'POST' && path === '/config/crc') {
            const body = JSON.parse(await readBody(req));
            upsertCrcConfig(handle, {
              messageKey: body.messageKey,
              arbitrationId: body.arbitrationId,
              isExtended: body.isExtended,
              width: body.width ?? null,
              poly: body.poly ?? null,
              init: body.init ?? null,
              xorOut: body.xorOut ?? null,
              reflectIn: Boolean(body.reflectIn),
              reflectOut: Boolean(body.reflectOut),
              coverageMode: body.coverageMode ?? null,
              coverageFirst: body.coverageFirst ?? null,
              coverageLast: body.coverageLast ?? null,
              coveragePositions: body.coveragePositions ?? [],
              crcPositions: body.crcPositions ?? [],
              signalName: body.signalName ?? null,
            });
            json(res, 200, { ok: true });
            return;
          }

          if (method === 'GET' && path === '/compare') {
            const fromId = Number(url.searchParams.get('from'));
            const toId = Number(url.searchParams.get('to'));
            json(res, 200, {
              from: listDbcVersions(handle).find((v) => v.id === fromId),
              to: listDbcVersions(handle).find((v) => v.id === toId),
              messages: compareVersions(handle, fromId, toId),
              maps: listMigrationMaps(handle, fromId, toId),
            });
            return;
          }

          if (method === 'POST' && path === '/migration') {
            const body = JSON.parse(await readBody(req));
            const result2 = putMigrationMap(handle, {
              fromVersion: body.fromVersion,
              toVersion: body.toVersion,
              messageKey: body.messageKey,
              payload: body.payload ?? null,
              status: body.status,
              expectedVersion: body.expectedVersion,
            });
            json(res, result2.ok ? 200 : 409, result2);
            return;
          }

          if (method === 'POST' && path === '/migration/approve') {
            const body = JSON.parse(await readBody(req));
            const result2 = approveMigrationMap(
              handle,
              body.fromVersion,
              body.toVersion,
              body.messageKey,
              body.approver ?? 'tester',
              body.expectedVersion
            );
            json(res, result2.ok ? 200 : 'conflict' in result2 && result2.conflict ? 409 : 400, result2);
            return;
          }

          if (method === 'POST' && path === '/snapshots') {
            const body = JSON.parse(await readBody(req));
            const id = freezeSnapshot(
              handle,
              body.frameId,
              body.title ?? '调查快照',
              body.note ?? '',
              body.versionId
            );
            json(res, 200, { id });
            return;
          }

          if (method === 'GET' && path === '/snapshots/all') {
            json(res, 200, listSnapshots(handle));
            return;
          }

          if (method === 'GET' && path.startsWith('/snapshots/')) {
            const snap = readSnapshot(handle, Number(path.split('/')[2]));
            if (!snap) return json(res, 404, { error: 'snapshot not found' });
            json(res, 200, snap);
            return;
          }

          next();
        } catch (err) {
          json(res, 400, { error: (err as Error).message });
        }
      });
    },
  };
}
