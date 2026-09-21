export const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  imported_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  arb_id INTEGER NOT NULL,
  extended INTEGER NOT NULL,
  channel TEXT,
  hw_time_ns INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  data BLOB NOT NULL,
  data_hex TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_frames_time ON frames(hw_time_ns);
CREATE INDEX IF NOT EXISTS idx_frames_batch ON frames(batch_id);

CREATE TABLE IF NOT EXISTS batch_frames (
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  frame_id INTEGER NOT NULL REFERENCES frames(id),
  PRIMARY KEY (batch_id, frame_id)
);

CREATE TABLE IF NOT EXISTS dbc_versions (
  id INTEGER PRIMARY KEY,
  seq INTEGER NOT NULL,
  label TEXT NOT NULL,
  start_ns INTEGER NOT NULL,
  end_ns INTEGER,
  doc TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_dbc_interval ON dbc_versions(start_ns, end_ns);

CREATE TABLE IF NOT EXISTS investigations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  frozen_version_ids TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS investigation_rows (
  id INTEGER PRIMARY KEY,
  investigation_id INTEGER NOT NULL REFERENCES investigations(id),
  frame_id INTEGER NOT NULL,
  frame_arb_id INTEGER NOT NULL,
  frame_extended INTEGER NOT NULL,
  frame_time_ns INTEGER NOT NULL,
  frame_data_hex TEXT NOT NULL,
  version_id INTEGER NOT NULL,
  version_label TEXT NOT NULL,
  message_name TEXT,
  decoded TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_rows ON investigation_rows(investigation_id);

CREATE TABLE IF NOT EXISTS migrations (
  id INTEGER PRIMARY KEY,
  from_version_id INTEGER NOT NULL,
  to_version_id INTEGER NOT NULL,
  arb_id INTEGER NOT NULL,
  extended INTEGER NOT NULL,
  frame_count INTEGER NOT NULL,
  mapping TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  row_version INTEGER NOT NULL DEFAULT 1,
  updated_ms INTEGER NOT NULL,
  UNIQUE(from_version_id, to_version_id, arb_id, extended)
);
`;
