import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS trace_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  frame_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES trace_imports(id),
  import_gen INTEGER NOT NULL,
  channel INTEGER NOT NULL,
  arb_id INTEGER NOT NULL,
  extended INTEGER NOT NULL,
  hw_time REAL NOT NULL,
  data_hex TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_frames_order ON frames(hw_time, channel, arb_id, extended, data_hex, id);
CREATE INDEX IF NOT EXISTS idx_frames_import ON frames(import_id);

CREATE TABLE IF NOT EXISTS dbc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  effective_from REAL,
  effective_to REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS message_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dbc_id INTEGER NOT NULL REFERENCES dbc_versions(id) ON DELETE CASCADE,
  arb_id INTEGER NOT NULL,
  extended INTEGER NOT NULL,
  name TEXT NOT NULL,
  dlc INTEGER NOT NULL,
  transmitter TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_msg_dbc ON message_defs(dbc_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg ON message_defs(dbc_id, arb_id, extended);

CREATE TABLE IF NOT EXISTS signal_defs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_def_id INTEGER NOT NULL REFERENCES message_defs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_bit INTEGER NOT NULL,
  length INTEGER NOT NULL,
  byte_order TEXT NOT NULL,
  signed INTEGER NOT NULL DEFAULT 0,
  scale REAL NOT NULL DEFAULT 1,
  offset REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT '',
  mux_type TEXT NOT NULL DEFAULT 'none',
  mux_switch INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sig_msg ON signal_defs(message_def_id);

CREATE TABLE IF NOT EXISTS value_descs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_def_id INTEGER NOT NULL REFERENCES signal_defs(id) ON DELETE CASCADE,
  raw INTEGER NOT NULL,
  label TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_val_sig ON value_descs(signal_def_id);

CREATE TABLE IF NOT EXISTS rule_counters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dbc_id INTEGER NOT NULL REFERENCES dbc_versions(id) ON DELETE CASCADE,
  arb_id INTEGER NOT NULL,
  extended INTEGER NOT NULL,
  signal_name TEXT NOT NULL,
  width INTEGER NOT NULL,
  node TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_counter
  ON rule_counters(dbc_id, arb_id, extended, signal_name);

CREATE TABLE IF NOT EXISTS rule_checksums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dbc_id INTEGER NOT NULL REFERENCES dbc_versions(id) ON DELETE CASCADE,
  arb_id INTEGER NOT NULL,
  extended INTEGER NOT NULL,
  signal_name TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'crc8',
  start_byte INTEGER,
  end_byte INTEGER,
  init INTEGER,
  xor_in INTEGER,
  xor_out INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rule_checksum
  ON rule_checksums(dbc_id, arb_id, extended, signal_name);

CREATE TABLE IF NOT EXISTS decode_cache (
  frame_id INTEGER PRIMARY KEY REFERENCES frames(id) ON DELETE CASCADE,
  dbc_id INTEGER REFERENCES dbc_versions(id),
  message_def_id INTEGER,
  json TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  frame_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_dbc_id INTEGER NOT NULL REFERENCES dbc_versions(id),
  to_dbc_id INTEGER NOT NULL REFERENCES dbc_versions(id),
  status TEXT NOT NULL DEFAULT 'open',
  rationale TEXT NOT NULL DEFAULT '',
  mapping TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_migration ON migrations(from_dbc_id, to_dbc_id);
`;

export function openDb(filename: string): DB {
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
