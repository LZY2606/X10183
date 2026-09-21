import { createRequire } from "node:module";
// node:sqlite 在 Node 22.5+ 提供；经 createRequire 加载以兼容 esbuild/vitest 的内置模块解析。
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let activeDb: DatabaseSync | null = null;
let activePath = "";

export function dbPath(): string {
  return process.env.BUS_SCALE_DB ?? "data/bus-scale.sqlite";
}

export function openDb(path: string = dbPath()): DatabaseSync {
  if (activeDb && activePath === path) return activeDb;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  activeDb = db;
  activePath = path;
  return db;
}

/** 测试用独立内存库。 */
export function newTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    arb_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('std','ext')),
    data TEXT NOT NULL,
    hw_time REAL NOT NULL,
    gen TEXT NOT NULL,
    source TEXT NOT NULL,
    seq INTEGER NOT NULL,
    UNIQUE(channel, arb_id, kind, hw_time, source, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_frames_replay ON frames(gen, hw_time, id);

  CREATE TABLE IF NOT EXISTS dbc_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    effective_from REAL NOT NULL,
    effective_to REAL,
    source_text TEXT NOT NULL,
    imported_at REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_id INTEGER NOT NULL REFERENCES dbc_versions(id) ON DELETE CASCADE,
    arb_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('std','ext')),
    name TEXT NOT NULL,
    dlc INTEGER NOT NULL,
    transmitter TEXT NOT NULL DEFAULT '',
    UNIQUE(version_id, arb_id, kind)
  );

  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_bit INTEGER NOT NULL,
    length INTEGER NOT NULL,
    byte_order TEXT NOT NULL CHECK (byte_order IN ('intel','motorola')),
    signed INTEGER NOT NULL,
    scale REAL NOT NULL,
    offset REAL NOT NULL,
    unit TEXT NOT NULL DEFAULT '',
    mux_type TEXT NOT NULL CHECK (mux_type IN ('plain','switch','case')),
    mux_switch TEXT,
    mux_value INTEGER,
    UNIQUE(message_id, name)
  );

  CREATE TABLE IF NOT EXISTS enums (
    signal_id INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
    raw_value INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (signal_id, raw_value)
  );

  CREATE TABLE IF NOT EXISTS crc_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_name TEXT NOT NULL UNIQUE,
    cover_signals TEXT,
    crc_signal TEXT NOT NULL,
    poly INTEGER NOT NULL,
    init INTEGER NOT NULL,
    xor_out INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS counter_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_name TEXT NOT NULL UNIQUE,
    signal_name TEXT NOT NULL,
    width INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at REAL NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_name TEXT NOT NULL,
    from_version_id INTEGER NOT NULL,
    to_version_id INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
    lock_version INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    UNIQUE(message_name, from_version_id, to_version_id)
  );
  `);
}
