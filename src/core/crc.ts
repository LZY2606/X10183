import type { CrcRule, MessageDef } from './types';

export function crc8(bytes: Uint8Array, polynomial: number, init: number, xor: number): number {
  let crc = init & 0xff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ polynomial) & 0xff : (crc << 1) & 0xff;
    }
  }
  return (crc ^ xor) & 0xff;
}

export interface CrcEvidence {
  signal: string;
  status: 'pass' | 'fail' | 'unverified';
  computed: number | null;
  received: number | null;
  coverage: { start_byte: number; end_byte: number } | null;
  polynomial: number | null;
  init: number | null;
  xor: number | null;
  reason?: string;
}

export function crcRuleComplete(rule: CrcRule | undefined): rule is CrcRule & {
  coverage: { start_byte: number; end_byte: number };
  polynomial: number;
  init: number;
  xor: number;
} {
  return !!(
    rule &&
    rule.coverage &&
    rule.polynomial !== undefined &&
    rule.init !== undefined &&
    rule.xor !== undefined
  );
}

export function verifyCrc(
  msg: MessageDef,
  data: Uint8Array,
  received: number | null,
): CrcEvidence {
  const rule = msg.crc;
  const base: CrcEvidence = {
    signal: rule?.signal ?? '',
    status: 'unverified',
    computed: null,
    received,
    coverage: rule?.coverage ?? null,
    polynomial: rule?.polynomial ?? null,
    init: rule?.init ?? null,
    xor: rule?.xor ?? null,
  };
  if (!rule) {
    return { ...base, reason: 'no_crc_rule' };
  }
  if (!crcRuleComplete(rule)) {
    return { ...base, reason: 'incomplete_crc_config' };
  }
  const { start_byte, end_byte } = rule.coverage;
  if (start_byte < 0 || end_byte < start_byte || end_byte >= data.length) {
    return { ...base, reason: 'coverage_out_of_range' };
  }
  const computed = crc8(
    data.subarray(start_byte, end_byte + 1),
    rule.polynomial,
    rule.init,
    rule.xor,
  );
  return {
    ...base,
    computed,
    status: received !== null && computed === received ? 'pass' : 'fail',
  };
}
