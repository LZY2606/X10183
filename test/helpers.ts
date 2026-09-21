import { openDb } from '../src/server/db.js';
import type Database from 'better-sqlite3';
import type { MessageDef, SignalDef, DbcVersionInput } from '../src/shared/types.js';

export function tempDb(): Database.Database {
  const db = openDb(':memory:');
  return db;
}

export function s(p: Partial<SignalDef> & Pick<SignalDef, 'name' | 'startBit' | 'length' | 'byteOrder'>): SignalDef {
  return {
    versionId: 0,
    name: p.name,
    startBit: p.startBit,
    length: p.length,
    byteOrder: p.byteOrder,
    signed: p.signed ?? false,
    factor: p.factor ?? 1,
    offset: p.offset ?? 0,
    unit: p.unit ?? '',
    min: p.min ?? null,
    max: p.max ?? null,
    muxType: p.muxType ?? null,
    muxValue: p.muxValue ?? null,
    role: p.role ?? null,
    crc: p.crc ?? null,
    counterModulus: p.counterModulus ?? null,
    valTable: p.valTable ?? []
  };
}

export function msg(p: Partial<MessageDef> & Pick<MessageDef, 'arbId' | 'name' | 'signals'>): MessageDef {
  return {
    versionId: 0,
    arbId: p.arbId,
    idKind: p.idKind ?? 'std',
    name: p.name,
    length: p.length ?? 8,
    sender: p.sender ?? 'ECU',
    signals: p.signals
  };
}

export function versionInput(
  label: string,
  messages: MessageDef[],
  range: { from?: number | null; to?: number | null } = {}
): DbcVersionInput {
  return {
    label,
    effectiveFromNs: range.from === undefined ? null : range.from,
    effectiveToNs: range.to === undefined ? null : range.to,
    messages
  };
}
