import { DatabaseSync } from 'node:sqlite';

export function createDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY,
      generation INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY,
      import_id INTEGER NOT NULL REFERENCES imports(id),
      seq INTEGER NOT NULL,
      channel TEXT NOT NULL,
      hw_timestamp INTEGER NOT NULL,
      arbitration_id INTEGER NOT NULL,
      is_extended INTEGER NOT NULL,
      dlc INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_frames_import ON frames(import_id);
    CREATE INDEX IF NOT EXISTS idx_frames_ts ON frames(hw_timestamp);
    CREATE TABLE IF NOT EXISTS dbc_versions (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      version_no INTEGER NOT NULL,
      effective_from INTEGER,
      effective_to INTEGER,
      layout TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decodes (
      id INTEGER PRIMARY KEY,
      frame_id INTEGER NOT NULL REFERENCES frames(id),
      dbc_version_id INTEGER NOT NULL REFERENCES dbc_versions(id),
      result TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(frame_id, dbc_version_id)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      dbc_version_id INTEGER NOT NULL REFERENCES dbc_versions(id),
      frame_ids TEXT NOT NULL,
      results TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      from_version_id INTEGER NOT NULL REFERENCES dbc_versions(id),
      to_version_id INTEGER NOT NULL REFERENCES dbc_versions(id),
      mapping TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      version_no INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}
