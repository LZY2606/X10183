export interface CrcParams {
  width: number;
  polynomial: number;
  initial: number;
  xorOut: number;
  reflectIn: boolean;
  reflectOut: boolean;
}

function reflect(value: number, width: number): number {
  let r = 0;
  for (let i = 0; i < width; i++) if (value & (1 << i)) r |= 1 << (width - 1 - i);
  return r;
}

/** Generic bitwise CRC (width <= 30). */
export function crcCompute(bytes: Uint8Array, p: CrcParams): number {
  const topBit = 1 << (p.width - 1);
  const mask = (1 << p.width) - 1;
  let crc = p.initial & mask;
  for (const byte of bytes) {
    const b = p.reflectIn ? reflect(byte, 8) : byte;
    crc ^= b << (p.width - 8);
    for (let i = 0; i < 8; i++) {
      crc = crc & topBit ? ((crc << 1) ^ p.polynomial) & mask : (crc << 1) & mask;
    }
  }
  if (p.reflectOut) crc = reflect(crc, p.width);
  return (crc ^ p.xorOut) & mask;
}

export interface CrcRuleConfig {
  coverage?: { startByte: number; endByte: number } | null;
  polynomial?: number | null;
  initial?: number | null;
  xorOut?: number | null;
  reflectIn?: boolean;
  reflectOut?: boolean;
  width?: number;
}

export interface CrcEvaluation {
  status: 'pass' | 'fail' | 'unverified';
  reason?: string;
  computed?: number;
  expected?: number;
  coverage?: { startByte: number; endByte: number };
  params?: CrcParams;
}

/**
 * Verify a CRC signal. An incomplete rule (missing coverage, polynomial,
 * initial or xorOut) can only yield "unverified" — never a pass.
 */
export function evaluateCrc(data: Uint8Array, expectedValue: number, rule: CrcRuleConfig): CrcEvaluation {
  const missing: string[] = [];
  if (!rule.coverage) missing.push('coverage');
  if (rule.polynomial == null) missing.push('polynomial');
  if (rule.initial == null) missing.push('initial');
  if (rule.xorOut == null) missing.push('xorOut');
  if (missing.length) return { status: 'unverified', reason: `配置不完整: 缺少 ${missing.join(', ')}` };

  const { startByte, endByte } = rule.coverage!;
  const params: CrcParams = {
    width: rule.width ?? 8,
    polynomial: rule.polynomial!,
    initial: rule.initial!,
    xorOut: rule.xorOut!,
    reflectIn: rule.reflectIn ?? false,
    reflectOut: rule.reflectOut ?? false
  };
  const computed = crcCompute(data.slice(startByte, endByte + 1), params);
  return {
    status: computed === expectedValue ? 'pass' : 'fail',
    computed,
    expected: expectedValue,
    coverage: rule.coverage!,
    params
  };
}
