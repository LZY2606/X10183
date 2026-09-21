PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS trace_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at REAL NOT NULL,
  source_name TEXT NOT NULL,
  frame_count INTEGER NOT NULL,
  ordinal INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL REFERENCES trace_imports(id),
  generation INTEGER NOT NULL,
  channel INTEGER NOT NULL,
  arbitration_id INTEGER NOT NULL,
  is_extended INTEGER NOT NULL,
  direction TEXT NOT NULL,
  hw_time REAL NOT NULL,
  dlc INTEGER NOT NULL,
  data BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(generation, channel, arbitration_id, is_extended, hw_time, data)
);
CREATE INDEX IF NOT EXISTS idx_frames_lookup ON frames(arbitration_id, is_extended, hw_time);
CREATE INDEX IF NOT EXISTS idx_frames_gen ON frames(generation);

CREATE TABLE IF NOT EXISTS dbc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_number INTEGER NOT NULL UNIQUE,
  label TEXT NOT NULL,
  valid_from REAL NOT NULL,
  valid_to REAL,
  source_name TEXT NOT NULL,
  content TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  imported_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dbc_version_id INTEGER NOT NULL REFERENCES dbc_versions(id),
  arbitration_id INTEGER NOT NULL,
  is_extended INTEGER NOT NULL,
  name TEXT NOT NULL,
  dlc INTEGER NOT NULL,
  transmitter TEXT NOT NULL,
  UNIQUE(dbc_version_id, arbitration_id, is_extended)
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  name TEXT NOT NULL,
  start_bit INTEGER NOT NULL,
  length INTEGER NOT NULL,
  byte_order TEXT NOT NULL,
  value_type TEXT NOT NULL,
  factor REAL NOT NULL,
  offset REAL NOT NULL,
  unit TEXT NOT NULL,
  mux_kind TEXT NOT NULL,
  mux_switch_name TEXT,
  mux_value INTEGER,
  UNIQUE(message_id, name)
);

CREATE TABLE IF NOT EXISTS signal_enums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id),
  value INTEGER NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interpretations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_id INTEGER NOT NULL REFERENCES frames(id),
  dbc_version_id INTEGER NOT NULL REFERENCES dbc_versions(id),
  message_id INTEGER NOT NULL REFERENCES messages(id),
  definition_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at REAL NOT NULL,
  UNIQUE(frame_id, dbc_version_id)
);
CREATE INDEX IF NOT EXISTS idx_interp_version ON interpretations(dbc_version_id);

CREATE TABLE IF NOT EXISTS counter_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_key TEXT NOT NULL UNIQUE,
  arbitration_id INTEGER NOT NULL,
  is_extended INTEGER NOT NULL,
  node TEXT NOT NULL,
  signal_name TEXT NOT NULL,
  modulus INTEGER NOT NULL,
  increment INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS crc_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_key TEXT NOT NULL UNIQUE,
  arbitration_id INTEGER NOT NULL,
  is_extended INTEGER NOT NULL,
  width INTEGER,
  poly INTEGER,
  init_value INTEGER,
  xor_out INTEGER,
  reflect_in INTEGER,
  reflect_out INTEGER,
  coverage_mode TEXT,
  coverage_first INTEGER,
  coverage_last INTEGER,
  coverage_positions TEXT,
  crc_positions TEXT,
  signal_name TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  note TEXT NOT NULL,
  frame_id INTEGER NOT NULL REFERENCES frames(id),
  dbc_version_id INTEGER NOT NULL,
  frame_json TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  decode_json TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_maps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  message_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  approved_at REAL,
  UNIQUE(from_version, to_version, message_key)
);
