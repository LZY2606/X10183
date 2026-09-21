import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let dbCounter = 0;

export function openDatabase(path?: string): DatabaseSync {
  const file = path ?? process.env.BUSSCALE_DB ?? 'data/busscale.db';
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function newMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(`file:busscale_mem_${++dbCounter}?mode=memory&cache=shared`);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trace_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    imported_at_ms INTEGER NOT NULL,
    format TEXT NOT NULL,
    frame_count INTEGER NOT NULL DEFAULT 0,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    first_seen_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    arb_id INTEGER NOT NULL,
    id_kind TEXT NOT NULL CHECK (id_kind IN ('standard','extended')),
    channel TEXT NOT NULL DEFAULT '0',
    hw_time_ms INTEGER NOT NULL,
    generation TEXT NOT NULL,
    tx_node TEXT,
    data TEXT NOT NULL,
    import_id INTEGER NOT NULL REFERENCES trace_imports(id),
    seq INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_frames_order
    ON frames (arb_id, id_kind, generation, channel, hw_time_ms, seq);
  CREATE INDEX IF NOT EXISTS idx_frames_time ON frames (hw_time_ms, seq);

  CREATE TABLE IF NOT EXISTS dbc_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    revision INTEGER NOT NULL,
    effective_start_ms INTEGER NOT NULL,
    effective_end_ms INTEGER,
    imported_at_ms INTEGER NOT NULL,
    doc_json TEXT NOT NULL,
    UNIQUE (label, revision)
  );
  CREATE INDEX IF NOT EXISTS idx_dbc_interval ON dbc_revisions (effective_start_ms, effective_end_ms);

  CREATE TABLE IF NOT EXISTS frame_decodes (
    frame_id INTEGER NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    revision_id INTEGER NOT NULL REFERENCES dbc_revisions(id),
    decoded_at_ms INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (frame_id, revision_id)
  );

  CREATE TABLE IF NOT EXISTS counter_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node TEXT NOT NULL,
    message_key TEXT NOT NULL,
    signal_name TEXT NOT NULL,
    window INTEGER,
    UNIQUE (node, message_key)
  );

  CREATE TABLE IF NOT EXISTS crc_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key TEXT NOT NULL UNIQUE,
    signal_name TEXT NOT NULL,
    algo TEXT NOT NULL CHECK (algo IN ('crc8','sum8')),
    cover_start_byte INTEGER,
    cover_end_byte INTEGER,
    init INTEGER,
    xor_out INTEGER
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at_ms INTEGER NOT NULL,
    frame_filter TEXT,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS snapshot_decodes (
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    frame_id INTEGER NOT NULL,
    revision_id INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    frame_json TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, frame_id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_revision_id INTEGER NOT NULL REFERENCES dbc_revisions(id),
    to_revision_id INTEGER NOT NULL REFERENCES dbc_revisions(id),
    message_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','incompatible')),
    mapping_json TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (from_revision_id, to_revision_id, message_key)
  );
  `);
}
