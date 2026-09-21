import { createRequire } from 'node:module';

// node:sqlite 是较新的内置模块，部分打包器静态分析无法识别，运行时加载
const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;
const { DatabaseSync } = sqlite;
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let dbInstance: DatabaseSync | null = null;
let dbPath = 'data/bus-scale.db';

export function setDbPath(p: string) {
  dbPath = p;
  dbInstance = null;
}

export function db(): DatabaseSync {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(dbPath), { recursive: true });
  const d = new DatabaseSync(dbPath);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(d);
  dbInstance = d;
  return d;
}

export function resetDatabase(): void {
  const d = db();
  d.exec(`DELETE FROM migrations; DELETE FROM snapshots; DELETE FROM crc_rules; DELETE FROM counter_rules;
          DELETE FROM signals; DELETE FROM messages; DELETE FROM frames; DELETE FROM dbc_versions;
          DELETE FROM sqlite_sequence;`);
}

/** 测试与内存场景 */
export function openMemory(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON;');
  migrate(d);
  dbInstance = d;
  return d;
}

function migrate(d: DatabaseSync) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    can_id INTEGER NOT NULL,
    is_extended INTEGER NOT NULL,
    channel INTEGER NOT NULL,
    hw_time INTEGER NOT NULL,
    data_hex TEXT NOT NULL,
    acquisition_gen INTEGER NOT NULL,
    import_seq INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_frames_time ON frames(hw_time);
  CREATE INDEX IF NOT EXISTS idx_frames_id ON frames(can_id, is_extended);

  CREATE TABLE IF NOT EXISTS dbc_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL UNIQUE,
    effective_from INTEGER,
    effective_to INTEGER,
    created_at INTEGER NOT NULL,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dbc_id INTEGER NOT NULL REFERENCES dbc_versions(id) ON DELETE CASCADE,
    can_id INTEGER NOT NULL,
    is_extended INTEGER NOT NULL,
    name TEXT NOT NULL,
    dlc INTEGER NOT NULL,
    transmitter TEXT,
    UNIQUE(dbc_id, can_id, is_extended)
  );

  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_bit INTEGER NOT NULL,
    bit_length INTEGER NOT NULL,
    byte_order TEXT NOT NULL,
    sign TEXT NOT NULL,
    factor REAL NOT NULL,
    offset REAL NOT NULL,
    minimum REAL,
    maximum REAL,
    unit TEXT,
    mux_role TEXT NOT NULL DEFAULT 'normal',
    enum_map TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS counter_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node TEXT NOT NULL,
    signal_name TEXT NOT NULL,
    max_value INTEGER,
    dbc_id INTEGER REFERENCES dbc_versions(id) ON DELETE SET NULL,
    UNIQUE(node, signal_name)
  );

  CREATE TABLE IF NOT EXISTS crc_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_name TEXT NOT NULL UNIQUE,
    signal_name TEXT,
    coverage TEXT NOT NULL DEFAULT '[]',
    init INTEGER,
    xor_out INTEGER,
    dbc_id INTEGER REFERENCES dbc_versions(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    frozen_dbc_id INTEGER,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_dbc_id INTEGER NOT NULL REFERENCES dbc_versions(id) ON DELETE CASCADE,
    to_dbc_id INTEGER NOT NULL REFERENCES dbc_versions(id) ON DELETE CASCADE,
    can_id INTEGER NOT NULL,
    is_extended INTEGER NOT NULL,
    from_message TEXT,
    to_message TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    lock_version INTEGER NOT NULL DEFAULT 0,
    UNIQUE(from_dbc_id, to_dbc_id, can_id, is_extended)
  );
  `);
}
