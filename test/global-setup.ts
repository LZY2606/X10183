import { mkdirSync } from 'node:fs';
mkdirSync('data', { recursive: true });
process.env.BUS_SCALE_DB = `data/test-${process.pid}.db`;
export default function setup() {
  process.env.BUS_SCALE_DB = `data/test-${process.pid}.db`;
}
