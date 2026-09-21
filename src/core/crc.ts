export type CrcWidth = 8 | 16 | 32;

export type CrcCoverage =
  | { mode: 'all' }
  | { mode: 'bytes'; first: number; last: number } // inclusive byte indices
  | { mode: 'exclude'; positions: number[] }; // byte indices to exclude (e.g. the crc byte)

export interface CrcConfig {
  width: CrcWidth;
  poly: number;
  init: number | null;
  xorOut: number | null;
  reflectIn: boolean;
  reflectOut: boolean;
  coverage: CrcCoverage;
  crcBytePositions: number[]; // bytes occupied by the CRC field
  expectedSignalName?: string;
}

export interface CrcCompleteness {
  complete: boolean;
  missing: string[];
}

export function checkCrcConfig(cfg: Partial<CrcConfig>): CrcCompleteness {
  const missing: string[] = [];
  if (cfg.width === undefined) missing.push('width');
  if (cfg.poly === undefined) missing.push('poly');
  if (cfg.init === null || cfg.init === undefined) missing.push('init');
  if (cfg.xorOut === null || cfg.xorOut === undefined) missing.push('xorOut');
  if (cfg.coverage === undefined) missing.push('coverage');
  if (!cfg.crcBytePositions || cfg.crcBytePositions.length === 0) missing.push('crcBytePositions');
  return { complete: missing.length === 0, missing };
}

function reverseBits(value: number, width: number): number {
  let out = 0;
  for (let i = 0; i < width; i++) {
    out = (out << 1) | (value & 1);
    value >>>= 1;
  }
  return out >>> 0;
}

function maskFor(width: CrcWidth): number {
  return width === 32 ? 0xffffffff : width === 16 ? 0xffff : 0xff;
}

function selectBytes(data: number[], cfg: CrcConfig): { byte: number; index: number }[] {
  const out: { byte: number; index: number }[] = [];
  const crcSet = new Set(cfg.crcBytePositions);
  if (cfg.coverage.mode === 'all') {
    data.forEach((b, i) => {
      if (!crcSet.has(i)) out.push({ byte: b, index: i });
    });
  } else if (cfg.coverage.mode === 'bytes') {
    for (let i = cfg.coverage.first; i <= cfg.coverage.last; i++) {
      if (i >= 0 && i < data.length && !crcSet.has(i)) out.push({ byte: data[i], index: i });
    }
  } else {
    const skip = new Set([...cfg.coverage.positions, ...cfg.crcBytePositions]);
    data.forEach((b, i) => {
      if (!skip.has(i)) out.push({ byte: b, index: i });
    });
  }
  return out;
}

export function computeCrc(data: number[], cfg: CrcConfig): number {
  const width = cfg.width;
  const mask = maskFor(width);
  const topBit = 1 << (width - 1);
  let crc = (cfg.init ?? 0) & mask;
  const bytes = selectBytes(data, cfg);

  for (const entry of bytes) {
    let byte = entry.byte;
    if (cfg.reflectIn) byte = reverseBits(byte, 8);
    crc ^= byte << (width - 8);
    crc &= mask;
    for (let bit = 0; bit < 8; bit++) {
      if (crc & topBit) crc = ((crc << 1) ^ cfg.poly) & mask;
      else crc = (crc << 1) & mask;
    }
  }

  if (cfg.reflectOut) crc = reverseBits(crc, width);
  crc ^= cfg.xorOut ?? 0;
  return crc & mask;
}

export type CrcVerdict = 'pass' | 'fail' | 'unchecked';

export interface CrcResult {
  verdict: CrcVerdict;
  computed?: number;
  expected?: number;
  coveredBytes: number[];
  reason?: string;
}

export function verifyCrc(data: number[], expected: number | null, cfg: Partial<CrcConfig>): CrcResult {
  const completeness = checkCrcConfig(cfg);
  if (!completeness.complete) {
    return {
      verdict: 'unchecked',
      coveredBytes: [],
      reason: `configuration incomplete, missing: ${completeness.missing.join(', ')}`,
    };
  }
  if (expected === null) {
    return { verdict: 'unchecked', coveredBytes: [], reason: 'frame has no expected CRC value' };
  }
  const full = cfg as CrcConfig;
  const computed = computeCrc(data, full);
  const coveredBytes = selectBytes(data, full).map((x) => x.index);
  return {
    verdict: computed === expected ? 'pass' : 'fail',
    computed,
    expected,
    coveredBytes,
  };
}
