import type { IncomingMessage, ServerResponse } from "node:http";
import { openDb } from "./db";
import { handleApi } from "./api";

/** 供 Vite dev server 使用的 /api 中间件；生产构建不含此层。 */
export async function apiMiddleware(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const result = await handleApi(
      openDb(),
      req.method ?? "GET",
      req.url ?? "/",
      rawBody,
    );
    res.statusCode = result.status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(result.body));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: (e as Error).message }));
  }
}
