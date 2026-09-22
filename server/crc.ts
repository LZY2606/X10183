import type { DB } from './db.js';
import type { CrcEvidence } from '../src/types.js';
import { listFramesOrdered } from './repo.js';
import { decodeFrame } from './decode.js';

interface ChecksumRuleRow {
  dbc_id: number;
  arb_id: number;
  extended: number;
  signal_name: string;
  algorithm: string;
  start_byte: number | null;
  end_byte: number | null;
  init: number | null;
  xor_in: number | null;
  xor_out: number | null;
}

export function isConfigured(r: ChecksumRuleRow): boolean {
  return (
    r.start_byte !== null &&
    r.end_byte !== null &&
    r.init !== null &&
    r.xor_in !== null &&
    r.xor_out !== null &&
    r.start_byte >= 0 &&
    r.end_byte >= r.start_byte &&
    r.end_byte <= 7
  );
}

function crc8Table(poly = 0x07): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ poly) & 0xff : (c << 1) & 0xff;
    table.push(c);
  }
  return table;
}

const TABLE = crc8Table();

function computeCrc8(bytes: number[], init: number, xorIn: number, xorOut: number): number {
  let crc = init & 0xff;
  for (const b of bytes) {
    const v = (b ^ xorIn) & 0xff;
    crc = TABLE[(crc ^ v) & 0xff];
  }
  return (crc ^ xorOut) & 0xff;
}

function computeXor(bytes: number[], init: number, xorIn: number, xorOut: number): number {
  let acc = init & 0xff;
  for (const b of bytes) acc = (acc ^ ((b ^ xorIn) & 0xff)) & 0xff;
  return (acc ^ xorOut) & 0xff;
}

export function analyzeChecksums(db: DB): CrcEvidence[] {
  const rules = db.prepare('SELECT * FROM rule_checksums ORDER BY id').all() as ChecksumRuleRow[];
  if (!rules.length) return [];
  const frames = listFramesOrdered(db);
  const out: CrcEvidence[] = [];

  for (const frame of frames) {
    for (const rule of rules) {
      if (rule.arb_id !== frame.arbId || !!rule.extended !== frame.extended) continue;
      const decoded = decodeFrame(db, frame.id);
      // 规则绑定到具体 DBC 版本：只有帧确实由该版本解码时才适用
      if (decoded.dbcId !== rule.dbc_id) continue;
      const sig = decoded.signals.find((s) => s.name === rule.signal_name);
      if (!sig) continue;
      const message = decoded.dbcId
        ? ((db
            .prepare('SELECT transmitter FROM message_defs WHERE id = ?')
            .get(decoded.messageDefId) as { transmitter: string } | undefined) ?? undefined)
        : undefined;

      const base = {
        frameId: frame.id,
        arbId: frame.arbId,
        extended: frame.extended,
        hwTime: frame.hwTime,
        importGen: frame.importGen,
        node: message?.transmitter ?? decoded.dbcLabel ?? '',
        signalName: rule.signal_name,
        algorithm: rule.algorithm,
        startByte: rule.start_byte,
        endByte: rule.end_byte,
        init: rule.init,
        xorIn: rule.xor_in,
        xorOut: rule.xor_out
      };

      if (!isConfigured(rule)) {
        out.push({
          ...base,
          configured: false,
          status: 'unchecked',
          detail: '校验配置不完整（覆盖范围/初值/异或值缺失或越界），未核验',
          coverageCells: [],
          expected: null,
          actual: null
        });
        continue;
      }

      // 覆盖边界：包含 endByte；校验字节自身排除
      const checksumBytes = new Set(
        sig.bitCells.map((cell) => Math.floor(cell / 8))
      );
      const covered: number[] = [];
      const coverageCells: number[] = [];
      for (let b = rule.start_byte!; b <= rule.end_byte!; b++) {
        if (checksumBytes.has(b)) continue;
        if (b < frame.data.length) covered.push(frame.data[b]);
        for (let k = 0; k < 8; k++) coverageCells.push(b * 8 + k);
      }

      if (rule.end_byte! >= frame.data.length) {
        out.push({
          ...base,
          configured: true,
          status: 'unchecked',
          detail: `覆盖范围超出 DLC=${frame.data.length}，未核验`,
          coverageCells,
          expected: null,
          actual: null
        });
        continue;
      }

      const expected =
        rule.algorithm === 'xor'
          ? computeXor(covered, rule.init!, rule.xor_in!, rule.xor_out!)
          : computeCrc8(covered, rule.init!, rule.xor_in!, rule.xor_out!);
      const actual = sig.active ? sig.raw : null;
      const status = actual === null ? 'unchecked' : actual === expected ? 'pass' : 'fail';
      out.push({
        ...base,
        configured: true,
        status,
        detail:
          status === 'pass'
            ? `校验通过：0x${expected.toString(16).padStart(2, '0')}`
            : status === 'fail'
              ? `校验失败：期望 0x${expected.toString(16).padStart(2, '0')}，实际 0x${(actual ?? 0).toString(16).padStart(2, '0')}`
              : '校验信号未解码（多路复用分支未知），未核验',
        coverageCells,
        expected,
        actual
      });
    }
  }

  out.sort((a, b) => a.hwTime - b.hwTime || a.frameId - b.frameId);
  return out;
}
