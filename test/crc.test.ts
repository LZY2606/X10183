import { describe, expect, it } from 'vitest';
import { analyzeChecksums } from '../server/crc.js';
import { createDbcVersion } from '../server/dbcService.js';
import { frame, importGen, memDb } from './helpers.js';

function crc8Table(poly = 0x07): number[] {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ poly) & 0xff : (c << 1) & 0xff;
    t.push(c);
  }
  return t;
}
const T = crc8Table();
function crc8(bytes: number[]): number {
  let c = 0xff;
  for (const b of bytes) c = T[(c ^ b) & 0xff];
  return c & 0xff;
}

const DBC = `BO_ 256 M: 8 ECU
 SG_ Counter : 0|8@1+ (1,0) [0|0] "" ECU
 SG_ Payload : 8|8@1+ (1,0) [0|0] "" ECU
 SG_ CRC : 16|8@1+ (1,0) [0|0] "" ECU
`;

describe('CRC：覆盖边界、通过/失败、配置不完整只能未核验', () => {
  it('通过 / 失败 / 覆盖排除校验字节自身', () => {
    const db = memDb();
    createDbcVersion(db, {
      label: 'crc',
      source: DBC,
      effectiveFrom: null,
      effectiveTo: null,
      checksums: [{ signalName: 'CRC', algorithm: 'crc8', startByte: 0, endByte: 1, init: 0xff, xorIn: 0, xorOut: 0 }]
    });
    const goodPayload = [1, 42];
    const good = crc8(goodPayload);
    importGen(db, 'g1', [
      frame(0, 256, [1, 42, good, 0, 0, 0, 0, 0]),
      frame(1, 256, [1, 42, 0x00, 0, 0, 0, 0, 0])
    ]);
    const evs = analyzeChecksums(db);
    expect(evs[0].status).toBe('pass');
    expect(evs[0].expected).toBe(good);
    expect(evs[1].status).toBe('fail');
    // 覆盖 cell 只包含 byte0..1
    expect(Math.max(...evs[0].coverageCells)).toBe(15);
  });

  it('配置不完整（缺 xorOut / 覆盖越界）→ unchecked，绝不 pass', () => {
    const db = memDb();
    createDbcVersion(db, {
      label: 'crc-incomplete',
      source: DBC,
      effectiveFrom: null,
      effectiveTo: null,
      checksums: [{ signalName: 'CRC', algorithm: 'crc8', startByte: 0, endByte: 1, init: 0xff, xorIn: 0, xorOut: null }]
    });
    importGen(db, 'g1', [frame(0, 256, [1, 42, 99, 0, 0, 0, 0, 0])]);
    const evs = analyzeChecksums(db);
    expect(evs[0].status).toBe('unchecked');
    expect(evs[0].configured).toBe(false);
    expect(evs[0].detail).toContain('未核验');
  });

  it('覆盖范围超出 DLC → unchecked', () => {
    const db = memDb();
    createDbcVersion(db, {
      label: 'crc-oob',
      source: DBC,
      effectiveFrom: null,
      effectiveTo: null,
      checksums: [{ signalName: 'CRC', algorithm: 'xor', startByte: 0, endByte: 6, init: 0, xorIn: 0, xorOut: 0 }]
    });
    importGen(db, 'g1', [frame(0, 256, [1, 42, 0])]);
    const evs = analyzeChecksums(db);
    expect(evs[0].status).toBe('unchecked');
    expect(evs[0].detail).toContain('DLC');
  });

  it('xor 算法：逐字节异或含 init/xorIn/xorOut', () => {
    const db = memDb();
    createDbcVersion(db, {
      label: 'xor',
      source: DBC,
      effectiveFrom: null,
      effectiveTo: null,
      checksums: [{ signalName: 'CRC', algorithm: 'xor', startByte: 0, endByte: 1, init: 0xaa, xorIn: 0xff, xorOut: 0x00 }]
    });
    const expected = 0xaa ^ (1 ^ 0xff) ^ (42 ^ 0xff);
    importGen(db, 'g1', [frame(0, 256, [1, 42, expected, 0, 0, 0, 0, 0])]);
    const evs = analyzeChecksums(db);
    expect(evs[0].status).toBe('pass');
    expect(evs[0].expected).toBe(expected);
  });
});
