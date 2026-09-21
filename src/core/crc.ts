import type { CrcConfig, CrcEvidence } from './types';
import { bytesToHex } from './bitfield';

function reflect(value: number, width: number): number {
  let out = 0;
  for (let i = 0; i < width; i++) {
    if (value & (1 << i)) out |= 1 << (width - 1 - i);
  }
  return out;
}

export interface CompleteCrcConfig {
  width: number;
  polynomial: number;
  init: number;
  xorOut: number;
  reflectIn: boolean;
  reflectOut: boolean;
}

/** Returns null when the configuration is incomplete (cannot verify). */
export function completeConfig(cfg: CrcConfig | undefined): CompleteCrcConfig | null {
  if (!cfg) return null;
  if (
    cfg.width == null ||
    cfg.polynomial == null ||
    cfg.init == null ||
    cfg.xorOut == null ||
    !cfg.coverage
  ) {
    return null;
  }
  return {
    width: cfg.width,
    polynomial: cfg.polynomial,
    init: cfg.init,
    xorOut: cfg.xorOut,
    reflectIn: cfg.reflectIn ?? false,
    reflectOut: cfg.reflectOut ?? false,
  };
}

export function crcCompute(bytes: number[] | Uint8Array, cfg: CompleteCrcConfig): number {
  const { width, polynomial, init, xorOut, reflectIn, reflectOut } = cfg;
  const topBit = 2 ** (width - 1);
  const mask = 2 ** width - 1;
  let crc = init & mask;
  for (const rawByte of bytes) {
    const byte = reflectIn ? reflect(rawByte, 8) : rawByte;
    crc ^= (byte * 2 ** (width - 8)) & mask;
    for (let i = 0; i < 8; i++) {
      crc = crc & topBit ? ((crc << 1) ^ polynomial) & mask : (crc << 1) & mask;
    }
  }
  if (reflectOut) crc = reflect(crc, width);
  return (crc ^ xorOut) & mask;
}

/**
 * Build CRC evidence for one crc-role signal. Incomplete configuration always
 * yields `unverified` — never a pass.
 */
export function crcEvidence(
  signalName: string,
  cfg: CrcConfig | undefined,
  data: Uint8Array,
  actualRaw: number | null,
): CrcEvidence {
  const complete = completeConfig(cfg);
  if (!complete) {
    return {
      signal: signalName,
      status: 'unverified',
      reason: 'CRC 配置不完整（需要 width/polynomial/init/xorOut/coverage）',
      actual: actualRaw ?? undefined,
    };
  }
  const { startByte, endByte } = cfg!.coverage!;
  if (startByte < 0 || endByte < startByte || endByte >= data.length) {
    return {
      signal: signalName,
      status: 'unverified',
      reason: `覆盖范围 [${startByte}, ${endByte}] 超出帧数据长度 ${data.length}`,
      actual: actualRaw ?? undefined,
    };
  }
  const covered = [...data.slice(startByte, endByte + 1)];
  const expected = crcCompute(covered, complete);
  const status = actualRaw != null && expected === actualRaw ? 'pass' : 'fail';
  return {
    signal: signalName,
    status,
    expected,
    actual: actualRaw ?? undefined,
    coverage: { startByte, endByte },
    coveredBytesHex: bytesToHex(covered),
    config: complete,
  };
}
