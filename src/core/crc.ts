import type { CrcCoverage, CrcEvidence, CrcReport, CrcRule, MessageDef, RawFrame } from './types.js';
import { extractRaw, hexToBytes, readBit } from './bits.js';

/** 配置是否完整：覆盖范围、初值、异或值缺一不可 */
export function missingCrcConfig(rule: Pick<CrcRule, 'coverage' | 'init' | 'xorOut'>): string[] {
  const missing: string[] = [];
  if (!Array.isArray(rule.coverage) || rule.coverage.length === 0) missing.push('coverage');
  if (rule.init === null || rule.init === undefined) missing.push('init');
  if (rule.xorOut === null || rule.xorOut === undefined) missing.push('xorOut');
  return missing;
}

/** 8-bit 线性反馈 CRC：逐 bit XOR，初值 init，结果再异或 xorOut */
export function computeCrc(data: Uint8Array, coverage: CrcCoverage[], init: number): number {
  let crc = init & 0xff;
  for (const seg of coverage) {
    for (let i = 0; i < seg.bitLength; i++) {
      const bit = readBit(data, seg.startBit + i) as 0 | 1;
      // 线性反馈多项式 x^8 + x^2 + x + 1 (0x07)
      const fb = ((crc >> 7) & 1) ^ bit;
      crc = ((crc << 1) & 0xff) ^ (fb ? 0x07 : 0x00);
    }
  }
  return crc & 0xff;
}

export function coveredBitList(coverage: CrcCoverage[]): number[] {
  const out: number[] = [];
  for (const seg of coverage) for (let i = 0; i < seg.bitLength; i++) out.push(seg.startBit + i);
  return out;
}

export function verifyCrc(
  frames: RawFrame[],
  message: MessageDef,
  rule: CrcRule
): CrcReport {
  const missing = missingCrcConfig(rule);
  const crcSig = rule.signalName ? message.signals.find((s) => s.name === rule.signalName) : null;
  const crcBits = crcSig
    ? Array.from({ length: crcSig.bitLength }, (_, i) => crcSig.startBit + i)
    : [];
  const coveredBits = missing.includes('coverage') ? [] : coveredBitList(rule.coverage);

  const evidences: CrcEvidence[] = frames.map((frame) => {
    const data = hexToBytes(frame.dataHex);
    if (missing.length > 0) {
      // 配置不完整：只能给“未核验”，绝不报通过
      return {
        frameId: frame.id,
        hwTime: frame.hwTime,
        expected: null,
        computed: null,
        status: 'unchecked',
        reason: `crc-config-incomplete: ${missing.join(',')}`,
        coveredBits,
        crcBits
      };
    }
    if (!crcSig) {
      return {
        frameId: frame.id,
        hwTime: frame.hwTime,
        expected: null,
        computed: null,
        status: 'unchecked',
        reason: 'crc-signal-not-found',
        coveredBits,
        crcBits: []
      };
    }
    const computed = computeCrc(data, rule.coverage, rule.init as number) ^ (rule.xorOut as number);
    // 读出帧中 CRC 字段（按信号自身字节序，支持跨字节位序）
    const expected = extractRaw(data, crcSig) & 0xff;
    return {
      frameId: frame.id,
      hwTime: frame.hwTime,
      expected,
      computed,
      status: expected === computed ? 'passed' : 'failed',
      reason: expected === computed ? 'match' : 'mismatch',
      coveredBits,
      crcBits
    };
  });

  return { messageName: message.name, configured: missing.length === 0, missingConfig: missing, evidences };
}
