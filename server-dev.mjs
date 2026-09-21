// 开发服务器：Vite 中间件 + “总线刻度” HTTP API（同一端口，无 CORS）。
import { createServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { getDb } from "./src/server/db.ts";
import { createApiHandler } from "./src/server/api.ts";
import { seedDatabase } from "./src/server/seed.ts";

function parseArgs(argv) {
  const args = { host: "127.0.0.1", port: 5243, strictPort: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") args.host = argv[++i];
    else if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--strictPort") args.strictPort = true;
  }
  return args;
}

const args = parseArgs(process.argv);

const vite = await createViteServer({
  configFile: new URL("./vite.config.ts", import.meta.url).pathname,
  server: { middlewareMode: true, host: args.host, strictPort: args.strictPort },
  appType: "spa"
});

const db = getDb();
const api = createApiHandler(db);

// 空库时播种示例数据，保证直接打开页面就有“总线刻度”可看。
const count = db.prepare("SELECT COUNT(*) AS c FROM dbc_version").get();
if (count.c === 0) seedDatabase(db);

const server = createServer((req, res) => {
  api(req, res).then((handled) => {
    if (!handled) vite.middlewares(req, res);
  });
});

server.listen(args.port, args.host, () => {
  console.log(`总线刻度 开发服务器: http://${args.host}:${args.port}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && args.strictPort) {
    console.error(`端口 ${args.port} 已被占用（--strictPort），退出。`);
    process.exit(1);
  }
  throw err;
});
