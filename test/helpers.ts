import { getDb, reopenDb } from '../src/server/db';
import { seedIfEmpty } from '../src/server/seed';

export function freshDb(): string {
  const p = `data/test-${process.pid}-${Math.random().toString(36).slice(2)}.db`;
  process.env.BUS_SCALE_DB = p;
  reopenDb(p);
  seedIfEmpty();
  return p;
}

export { getDb };
