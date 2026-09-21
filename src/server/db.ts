import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  CounterRule,
  CrcRule,
  DbcVersion,
  ImportBatch,
  MessageDef,
  MigrationMapping,
  RawFrame,
  SignalDef,
  Snapshot
} from "../core/types.js";

let dbInstance: DatabaseSync | null = null;

export function getDb(path = process.env.BUSSCALE_DB ?? "data/busscale.db"): DatabaseSync {
  if (dbInstance) return dbInstance;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  dbInstance = db;
  return db;
}

/** 供测试重置使用。 */
export function resetDbInstance(): void {
  dbInstance = null;
}

export function freshInMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS import_batch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    generation TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    frame_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS raw_frame (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES import_batch(id),
    channel TEXT,
    arbitration_id INTEGER NOT NULL,
    extended INTEGER NOT NULL,
    hw_time_ns INTEGER NOT NULL,
    dlc INTEGER NOT NULL,
    data BLOB NOT NULL,
    seq_in_import INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_frame_time ON raw_frame(hw_time_ns);
  CREATE INDEX IF NOT EXISTS idx_frame_id ON raw_frame(arbitration_id, extended, channel);

  CREATE TABLE IF NOT EXISTS dbc_version (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    version_number INTEGER NOT NULL UNIQUE,
    effective_from_ns INTEGER,
    effective_to_ns INTEGER,
    source_text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message_def (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dbc_version_id INTEGER NOT NULL REFERENCES dbc_version(id),
    name TEXT NOT NULL,
    arbitration_id INTEGER NOT NULL,
    extended INTEGER NOT NULL,
    channel TEXT,
    dlc INTEGER NOT NULL,
    transmitter TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_msg_lookup ON message_def(arbitration_id, extended, channel);

  CREATE TABLE IF NOT EXISTS signal_def (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_def_id INTEGER NOT NULL REFERENCES message_def(id),
    name TEXT NOT NULL,
    start_bit INTEGER NOT NULL,
    length INTEGER NOT NULL,
    byte_order TEXT NOT NULL,
    signed INTEGER NOT NULL,
    scale REAL NOT NULL,
    offset REAL NOT NULL,
    minimum REAL,
    maximum REAL,
    unit TEXT,
    mux_kind TEXT NOT NULL,
    mux_value INTEGER,
    mux_switch_name TEXT,
    mux_ranges TEXT,
    enums TEXT
  );

  CREATE TABLE IF NOT EXISTS counter_rule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT,
    arbitration_id INTEGER NOT NULL,
    extended INTEGER NOT NULL,
    signal_name TEXT NOT NULL,
    bits INTEGER NOT NULL,
    factor INTEGER NOT NULL,
    increment INTEGER NOT NULL,
    node_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crc_rule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT,
    arbitration_id INTEGER NOT NULL,
    extended INTEGER NOT NULL,
    signal_name TEXT NOT NULL,
    width_bits INTEGER NOT NULL,
    start_byte INTEGER,
    length_bytes INTEGER,
    polynomial INTEGER,
    init_value INTEGER,
    xor_out INTEGER,
    reflect_input INTEGER NOT NULL DEFAULT 0,
    reflect_output INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS migration_mapping (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_version_id INTEGER NOT NULL REFERENCES dbc_version(id),
    to_version_id INTEGER NOT NULL REFERENCES dbc_version(id),
    message_def_key TEXT NOT NULL,
    from_message_name TEXT NOT NULL,
    to_message_name TEXT,
    signal_mappings TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    lock_version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(from_version_id, to_version_id, message_def_key)
  );

  CREATE TABLE IF NOT EXISTS snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    pinned_dbc_version_id INTEGER NOT NULL REFERENCES dbc_version(id),
    payload_json TEXT NOT NULL
  );
  `);
}

// ---------- 行 -> 领域对象 ----------

export function rowToFrame(r: Record<string, unknown>): RawFrame {
  return {
    id: r.id as number,
    importId: r.import_id as number,
    channel: (r.channel as string | null) ?? null,
    arbitrationId: r.arbitration_id as number,
    extended: !!r.extended,
    hwTimeNs: (r.hw_time_ns as bigint | number).toString(),
    data: Buffer.from(r.data as Uint8Array),
    seqInImport: r.seq_in_import as number
  };
}

export function rowToDbc(r: Record<string, unknown>): DbcVersion {
  return {
    id: r.id as number,
    name: r.name as string,
    versionNumber: r.version_number as number,
    effectiveFromNs: r.effective_from_ns === null ? null : (r.effective_from_ns as bigint | number).toString(),
    effectiveToNs: r.effective_to_ns === null ? null : (r.effective_to_ns as bigint | number).toString(),
    sourceText: r.source_text as string
  };
}

export function loadMessageDefs(db: DatabaseSync, dbcVersionId: number): MessageDef[] {
  const msgRows = db
    .prepare("SELECT * FROM message_def WHERE dbc_version_id = ? ORDER BY arbitration_id, extended, name")
    .all(dbcVersionId) as Record<string, unknown>[];
  return msgRows.map((m) => {
    const sigRows = db
      .prepare("SELECT * FROM signal_def WHERE message_def_id = ? ORDER BY id")
      .all(m.id) as Record<string, unknown>[];
    const signals: SignalDef[] = sigRows.map((s) => ({
      id: s.id as number,
      messageId: s.message_def_id as number,
      name: s.name as string,
      startBit: s.start_bit as number,
      length: s.length as number,
      byteOrder: s.byte_order as SignalDef["byteOrder"],
      signed: !!s.signed,
      scale: s.scale as number,
      offset: s.offset as number,
      minimum: (s.minimum as number | null) ?? null,
      maximum: (s.maximum as number | null) ?? null,
      unit: (s.unit as string | null) ?? null,
      muxKind: s.mux_kind as SignalDef["muxKind"],
      muxValue: (s.mux_value as number | null) ?? null,
      muxSwitchName: (s.mux_switch_name as string | null) ?? null,
      muxRanges: s.mux_ranges ? (JSON.parse(s.mux_ranges as string) as Array<[number, number]>) : null,
      enums: s.enums ? (JSON.parse(s.enums as string) as Record<number, string>) : null
    }));
    return {
      id: m.id as number,
      dbcVersionId,
      name: m.name as string,
      arbitrationId: m.arbitration_id as number,
      extended: !!m.extended,
      channel: (m.channel as string | null) ?? null,
      dlc: m.dlc as number,
      transmitter: (m.transmitter as string | null) ?? null,
      signals
    };
  });
}

export function loadAllFrames(db: DatabaseSync): RawFrame[] {
  const rows = db.prepare("SELECT * FROM raw_frame ORDER BY id").all() as Record<string, unknown>[];
  return rows.map(rowToFrame);
}

export function loadBatches(db: DatabaseSync): ImportBatch[] {
  const rows = db.prepare("SELECT * FROM import_batch ORDER BY id").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    label: r.label as string,
    generation: r.generation as string,
    importedAt: r.imported_at as string,
    frameCount: r.frame_count as number
  }));
}

export function loadDbcVersions(db: DatabaseSync): DbcVersion[] {
  const rows = db.prepare("SELECT * FROM dbc_version ORDER BY version_number").all() as Record<string, unknown>[];
  return rows.map(rowToDbc);
}

export function loadCounterRules(db: DatabaseSync): CounterRule[] {
  const rows = db.prepare("SELECT * FROM counter_rule ORDER BY id").all() as Record<string, unknown>[];
  return rows.map(rowToCounterRule);
}

export function rowToCounterRule(r: Record<string, unknown>): CounterRule {
  return {
    id: r.id as number,
    channel: (r.channel as string | null) ?? null,
    arbitrationId: r.arbitration_id as number,
    extended: !!r.extended,
    signalName: r.signal_name as string,
    bits: r.bits as number,
    factor: r.factor as number,
    increment: r.increment as number,
    nodeName: r.node_name as string
  };
}

export function loadCrcRules(db: DatabaseSync): CrcRule[] {
  const rows = db.prepare("SELECT * FROM crc_rule ORDER BY id").all() as Record<string, unknown>[];
  return rows.map(
    (r): CrcRule => ({
      id: r.id as number,
      channel: (r.channel as string | null) ?? null,
      arbitrationId: r.arbitration_id as number,
      extended: !!r.extended,
      signalName: r.signal_name as string,
      widthBits: r.width_bits as number,
      startByte: (r.start_byte as number | null) ?? null,
      lengthBytes: (r.length_bytes as number | null) ?? null,
      polynomial: (r.polynomial as number | null) ?? null,
      init: (r.init_value as number | null) ?? null,
      xorOut: (r.xor_out as number | null) ?? null,
      reflectInput: !!r.reflect_input,
      reflectOutput: !!r.reflect_output
    })
  );
}

export function loadMappings(db: DatabaseSync): MigrationMapping[] {
  const rows = db.prepare("SELECT * FROM migration_mapping ORDER BY id").all() as Record<string, unknown>[];
  return rows.map(
    (r): MigrationMapping => ({
      id: r.id as number,
      fromVersionId: r.from_version_id as number,
      toVersionId: r.to_version_id as number,
      messageDefKey: r.message_def_key as string,
      fromMessageName: r.from_message_name as string,
      toMessageName: (r.to_message_name as string | null) ?? null,
      signalMappings: r.signal_mappings as string,
      status: r.status as MigrationMapping["status"],
      note: (r.note as string | null) ?? null,
      lockVersion: r.lock_version as number
    })
  );
}

export function loadSnapshots(db: DatabaseSync): Snapshot[] {
  const rows = db.prepare("SELECT * FROM snapshot ORDER BY id").all() as Record<string, unknown>[];
  return rows.map(
    (r): Snapshot => ({
      id: r.id as number,
      label: r.label as string,
      createdAt: r.created_at as string,
      pinnedDbcVersionId: r.pinned_dbc_version_id as number,
      payloadJson: r.payload_json as string
    })
  );
}
