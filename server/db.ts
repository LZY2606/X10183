import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS imports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  label TEXT,
  generation INTEGER,
  content_hash TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS frames(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES imports(id),
  generation INTEGER NOT NULL,
  channel INTEGER NOT NULL,
  hw_time REAL NOT NULL,
  arb_id INTEGER NOT NULL,
  is_extended INTEGER NOT NULL,
  dlc INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_frames_time ON frames(hw_time);
CREATE INDEX IF NOT EXISTS idx_frames_msg ON frames(arb_id, is_extended);
CREATE TABLE IF NOT EXISTS dbc_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  effective_from REAL NOT NULL,
  effective_to REAL,
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS decodes(
  frame_id INTEGER PRIMARY KEY REFERENCES frames(id),
  dbc_version_id INTEGER,
  result TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS snapshot_decodes(
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  frame_id INTEGER NOT NULL,
  dbc_version_id INTEGER,
  result TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, frame_id)
);
CREATE TABLE IF NOT EXISTS crc_rules(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  is_extended INTEGER NOT NULL,
  signal TEXT NOT NULL,
  poly INTEGER, init INTEGER, xor_out INTEGER,
  cover_start INTEGER, cover_end INTEGER
);
CREATE TABLE IF NOT EXISTS migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  mapping TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDatabase(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
