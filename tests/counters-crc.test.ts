import { describe, expect, it } from 'vitest';
import { analyzeCounter, summarizeReports, type CounterFrame } from '../src/core/counters.js';
import { checkCrcConfig, computeCrc, verifyCrc, type CrcConfig } from '../src/core/crc.js';
import { parseTrace } from '../src/core/trace.js';

function cf(id: number, generation: number, time: number, counterRaw: number): CounterFrame {
  return {
    frameId: id,
    id: 100,
    isExtended: false,
    channel: 1,
    direction: 'rx',
    hwTime: time,
    dlc: 8,
    data: [],
    generation,
    counterRaw,
  };
}

const cfg = { id: 1, messageId: 100, isExtended: false, node: 'ECU', signalName: 'C', modulus: 16, increment: 1 };

describe('counter checks', () => {
  it('detects clean boundary wrap', () => {
    const frames = [cf(1, 1, 0, 14), cf(2, 1, 1, 15), cf(3, 1, 2, 0)];
    const reports = analyzeCounter(frames, cfg);
    expect(reports[0].events.map((e) => e.kind)).toEqual(['ok', 'ok', 'wrap']);
    expect(summarizeReports(reports).wraps).toBe(1);
  });

  it('detects repeat and missing gap', () => {
    const frames = [cf(1, 1, 0, 3), cf(2, 1, 1, 3), cf(3, 1, 2, 7)];
    const reports = analyzeCounter(frames, cfg);
    expect(reports[0].events.slice(1).map((e) => e.kind)).toEqual(['repeat', 'missing']);
    const missingEvent = reports[0].events.find((e) => e.kind === 'missing')!;
    expect(missingEvent.missingCount).toBe(3); // 4,5,6
  });

  it('marks duplicate timestamps independently', () => {
    const frames = [cf(1, 1, 5, 1), cf(2, 1, 5, 2)];
    const reports = analyzeCounter(frames, cfg);
    expect(reports[0].events[1].duplicateTimestamp).toBe(true);
    expect(reports[0].duplicateTimestamps).toBe(1);
  });

  it('checks per node and per generation, never across groups', () => {
    const frames = [
      cf(1, 1, 0, 10), cf(2, 2, 1, 0), // different generation -> two groups, both ok
      cf(3, 1, 2, 11),
    ];
    const reports = analyzeCounter(frames, cfg);
    expect(reports).toHaveLength(2);
    expect(reports.flatMap((r) => r.events).filter((e) => e.kind !== 'ok')).toHaveLength(0);
  });

  it('is independent of import order', () => {
    const ordered = [cf(1, 1, 0, 0), cf(2, 1, 1, 1), cf(3, 1, 2, 2), cf(4, 1, 2, 3)];
    const shuffled = [ordered[3], ordered[1], ordered[0], ordered[2]];
    const a = JSON.stringify(analyzeCounter(ordered, cfg));
    const b = JSON.stringify(analyzeCounter(shuffled, cfg));
    expect(a).toBe(b);
  });
});

describe('trace parser', () => {
  it('parses CSV with standard/extended markers and jsonl', () => {
    const text = [
      'generation,channel,id,fmt,dir,hwtime,dlc,data',
      '1,1,100,S,rx,10,8,00 01 02 03 04 05 06 07',
      '1,1,293,X,rx,11,8,aabbccdd00000000',
      '{"generation":2,"channel":1,"id":100,"isExtended":false,"hwTime":12,"data":[1,2,3,4,5,6,7,8]}',
    ].join('\n');
    const { frames, errors } = parseTrace(text);
    expect(errors).toEqual([]);
    expect(frames).toHaveLength(3);
    expect(frames[0].data).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(frames[1].isExtended).toBe(true);
    expect(frames[2].generation).toBe(2);
  });
});

describe('CRC engine', () => {
  const base: CrcConfig = {
    width: 8,
    poly: 0x07,
    init: 0x00,
    xorOut: 0x00,
    reflectIn: false,
    reflectOut: false,
    coverage: { mode: 'all' },
    crcBytePositions: [7],
  };

  it('computes CRC-8/SAE-J1850 zero vector as 0', () => {
    expect(computeCrc(new Array(8).fill(0), base)).toBe(0);
  });

  it('detects a tampered byte (coverage boundary respected)', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 0];
    const crc = computeCrc(data, base);
    data[7] = crc;
    expect(verifyCrc(data, crc, base).verdict).toBe('pass');
    data[0] ^= 0xff;
    expect(verifyCrc(data, crc, base).verdict).toBe('fail');
  });

  it('excludes configured bytes from coverage', () => {
    const data = [9, 1, 2, 3, 4, 5, 6, 0];
    const cfgNo9: CrcConfig = { ...base, coverage: { mode: 'bytes', first: 1, last: 6 } };
    const crc = computeCrc(data, cfgNo9);
    const tamperedOutside = data.slice();
    tamperedOutside[0] = 99;
    expect(computeCrc(tamperedOutside, cfgNo9)).toBe(crc);
    const tamperedInside = data.slice();
    tamperedInside[1] = 99;
    expect(computeCrc(tamperedInside, cfgNo9)).not.toBe(crc);
    expect(verifyCrc(data, crc, cfgNo9).coveredBytes).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('returns unchecked (never pass) when configuration is incomplete', () => {
    const incomplete = { width: 8, coverage: { mode: 'all' }, crcBytePositions: [7] };
    expect(checkCrcConfig(incomplete as never).complete).toBe(false);
    const result = verifyCrc([1, 2, 3, 4, 5, 6, 7, 0], 42, incomplete as never);
    expect(result.verdict).toBe('unchecked');
  });

  it('supports init and xorOut variants', () => {
    const cfg: CrcConfig = { ...base, init: 0xff, xorOut: 0x55 };
    expect(verifyCrc([0, 0, 0, 0, 0, 0, 0, 0], computeCrc([0, 0, 0, 0, 0, 0, 0, 0], cfg), cfg).verdict).toBe('pass');
  });
});
