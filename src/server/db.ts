// 总线刻度 — SQLite 连接与建表
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let instance: Database.Database | null = null;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 采集代次（导入批次）
CREATE TABLE IF NOT EXISTS generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  frame_count INTEGER NOT NULL DEFAULT 0
);

-- 原始帧：不可变载荷、通道、硬件时间、采集代次
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel INTEGER NOT NULL,
  arb_id INTEGER NOT NULL,
  id_kind TEXT NOT NULL CHECK (id_kind IN ('std','ext')),
  data BLOB NOT NULL,
  dlc INTEGER NOT NULL,
  hw_time_ns INTEGER NOT NULL,
  generation INTEGER NOT NULL REFERENCES generations(id),
  rx_order INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_frames_lookup
  ON frames (generation, arb_id, id_kind, hw_time_ns);

-- DBC 版本（带生效区间，revision 用于并发审批冲突）
CREATE TABLE IF NOT EXISTS dbc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  effective_from_ns INTEGER,
  effective_to_ns INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES dbc_versions(id) ON DELETE CASCADE,
  arb_id INTEGER NOT NULL,
  id_kind TEXT NOT NULL CHECK (id_kind IN ('std','ext')),
  name TEXT NOT NULL,
  length INTEGER NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  UNIQUE (version_id, arb_id, id_kind)
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  start_bit INTEGER NOT NULL,
  length INTEGER NOT NULL,
  byte_order INTEGER NOT NULL,
  signed INTEGER NOT NULL,
  factor REAL NOT NULL,
  offset REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  min_value REAL,
  max_value REAL,
  mux_type TEXT,
  mux_value INTEGER,
  role TEXT,
  crc_json TEXT,
  counter_modulus INTEGER,
  val_table_json TEXT NOT NULL DEFAULT '[]',
  ord INTEGER NOT NULL DEFAULT 0
);

-- 某帧采用了哪个消息定义/版本
CREATE TABLE IF NOT EXISTS decodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_id INTEGER NOT NULL UNIQUE REFERENCES frames(id) ON DELETE CASCADE,
  version_id INTEGER NOT NULL,
  message_name TEXT NOT NULL,
  arb_id INTEGER NOT NULL,
  id_kind TEXT NOT NULL,
  stale_reason TEXT,
  decoded_at TEXT NOT NULL
);

-- 解码信号：bit 区间、raw、物理值、枚举、mux 状态全部可追溯
CREATE TABLE IF NOT EXISTS decode_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decode_id INTEGER NOT NULL REFERENCES decodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_bit INTEGER NOT NULL,
  length INTEGER NOT NULL,
  byte_order INTEGER NOT NULL,
  signed INTEGER NOT NULL,
  factor REAL NOT NULL,
  offset REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  role TEXT,
  mux_type TEXT,
  mux_value INTEGER,
  bit_cells_json TEXT NOT NULL,
  raw_value INTEGER,
  phys_value REAL,
  enum_label TEXT,
  mux_skipped INTEGER NOT NULL DEFAULT 0,
  overrun INTEGER NOT NULL DEFAULT 0,
  ord INTEGER NOT NULL DEFAULT 0
);

-- 迁移映射审批（乐观锁 revision）
CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_version_id INTEGER NOT NULL,
  to_version_id INTEGER NOT NULL,
  arb_id INTEGER NOT NULL,
  id_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved','incompatible')),
  signal_mapping_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (from_version_id, to_version_id, arb_id, id_kind)
);

-- 冻结的调查快照（继续指向旧定义）
CREATE TABLE IF NOT EXISTS investigations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  frozen_at_ns INTEGER NOT NULL,
  frame_count INTEGER NOT NULL,
  version_ids_json TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
`;

export function openDb(path = process.env.BUSSCALE_DB ?? 'data/busscale.db'): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function getDb(path?: string): Database.Database {
  if (!instance) instance = openDb(path);
  return instance;
}

export function resetDb(path = process.env.BUSSCALE_DB ?? 'data/busscale.db'): Database.Database {
  if (instance) {
    instance.close();
    instance = null;
  }
  instance = openDb(path);
  return instance;
}

/** 与导入顺序无关的确定性帧排序（重复时间戳按载荷等内容决胜） */
export const FRAME_ORDER_CLAUSE = `
  ORDER BY f.generation, f.hw_time_ns, f.channel, f.arb_id, f.id_kind,
           hex(f.data), f.id
`;
