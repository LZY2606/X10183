import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function createDb(path?: string): DatabaseSync {
  const dbPath = path ?? process.env.BUS_SCALE_DB ?? 'bus-scale.db';
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  initSchema(db);
  return db;
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY,
      trace_id INTEGER NOT NULL REFERENCES traces(id),
      generation INTEGER NOT NULL,
      channel TEXT NOT NULL,
      hw_timestamp REAL NOT NULL,
      arbitration_id INTEGER NOT NULL,
      is_extended INTEGER NOT NULL,
      dlc INTEGER NOT NULL,
      data BLOB NOT NULL,
      hex TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_frames_trace ON frames(trace_id, hw_timestamp);
    CREATE TABLE IF NOT EXISTS dbc_versions (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      effective_from REAL NOT NULL,
      effective_to REAL,
      content TEXT NOT NULL,
      parsed TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS decodes (
      frame_id INTEGER NOT NULL REFERENCES frames(id),
      dbc_version_id INTEGER NOT NULL REFERENCES dbc_versions(id),
      message TEXT,
      result TEXT NOT NULL,
      PRIMARY KEY (frame_id, dbc_version_id)
    );
    CREATE TABLE IF NOT EXISTS counter_configs (
      id INTEGER PRIMARY KEY,
      message TEXT NOT NULL,
      signal TEXT NOT NULL,
      max_value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crc_configs (
      id INTEGER PRIMARY KEY,
      message TEXT NOT NULL,
      signal TEXT,
      coverage_start INTEGER,
      coverage_length INTEGER,
      width INTEGER,
      polynomial INTEGER,
      initial INTEGER,
      xor_out INTEGER
    );
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      from_version_id INTEGER NOT NULL,
      to_version_id INTEGER NOT NULL,
      mapping TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      dbc_version_id INTEGER NOT NULL,
      trace_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
