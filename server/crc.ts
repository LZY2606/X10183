/** CRC-8 with configurable polynomial, init value, final xor and coverage. */

export interface CrcRule {
  id?: number;
  messageId: number;
  isExtended: boolean;
  /** name of the signal carrying the CRC value */
  signal: string;
  /** CRC-8 polynomial (without implicit x^8), e.g. 0x1D */
  poly: number | null;
  init: number | null;
  xorOut: number | null;
  /** coverage: payload byte range [coverStart, coverEnd) fed into the CRC */
  coverStart: number | null;
  coverEnd: number | null;
}

export function crc8(data: Uint8Array, poly: number, init: number, xorOut: number): number {
  let crc = init & 0xff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
    }
  }
  return (crc ^ xorOut) & 0xff;
}

export type CrcStatus = 'pass' | 'fail' | 'unverified';

export interface CrcEvidence {
  status: CrcStatus;
  reason?: string;
  computed?: number;
  expected?: number;
  coverage?: { start: number; end: number };
  poly?: number;
  init?: number;
  xorOut?: number;
}

/** A rule with any missing parameter can never report a pass — only "unverified". */
export function ruleIsComplete(rule: CrcRule): boolean {
  return (
    rule.poly != null &&
    rule.init != null &&
    rule.xorOut != null &&
    rule.coverStart != null &&
    rule.coverEnd != null &&
    rule.coverEnd > rule.coverStart
  );
}

export function verifyCrc(rule: CrcRule, payload: Uint8Array, signalRaw: number): CrcEvidence {
  if (!ruleIsComplete(rule)) {
    return { status: 'unverified', reason: 'CRC 配置不完整（需要覆盖范围、初值、异或值与多项式）' };
  }
  const start = rule.coverStart!;
  const end = Math.min(rule.coverEnd!, payload.length);
  if (start >= payload.length || start < 0) {
    return { status: 'unverified', reason: '覆盖范围超出报文长度' };
  }
  const computed = crc8(payload.subarray(start, end), rule.poly!, rule.init!, rule.xorOut!);
  return {
    status: computed === (signalRaw & 0xff) ? 'pass' : 'fail',
    computed,
    expected: signalRaw & 0xff,
    coverage: { start, end },
    poly: rule.poly!,
    init: rule.init!,
    xorOut: rule.xorOut!,
  };
}
