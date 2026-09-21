import type { CrcRule, MessageDef } from './types';
import { extractRaw, signalBitPositions } from './bits';

export type CrcStatus = 'pass' | 'fail' | 'not-verified' | 'truncated';

export interface CrcEvidence {
  status: CrcStatus;
  reason?: string;
  rule: {
    signal: string;
    coverStart: number | null;
    coverEnd: number | null;
    init: number | null;
    xorOut: number | null;
  };
  coveredBytes: number[];
  expected: number | null;
  actual: number | null;
  width: number | null;
}

function isComplete(rule: CrcRule): boolean {
  return (
    rule.coverStart !== null &&
    rule.coverEnd !== null &&
    rule.init !== null &&
    rule.xorOut !== null
  );
}

/** XOR/CRC-8 风格校验：字节逐位异或 + 初值 + 输出异或（测试用确定算法） */
export function xorCrc8(
  data: Uint8Array,
  init: number,
  xorOut: number,
): number {
  let crc = init & 0xff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x80) crc = ((crc << 1) ^ 0x07) & 0xff;
      else crc = (crc << 1) & 0xff;
    }
  }
  return (crc ^ xorOut) & 0xff;
}

export function verifyCrc(
  msg: MessageDef,
  data: Uint8Array,
): CrcEvidence {
  const rule = msg.crc;
  const base = {
    signal: rule?.signal ?? '',
    coverStart: rule?.coverStart ?? null,
    coverEnd: rule?.coverEnd ?? null,
    init: rule?.init ?? null,
    xorOut: rule?.xorOut ?? null,
  };
  if (!rule) {
    return {
      status: 'not-verified',
      reason: '该消息未配置 CRC 规则',
      rule: base,
      coveredBytes: [],
      expected: null,
      actual: null,
      width: null,
    };
  }
  if (!isComplete(rule)) {
    // 配置不完整：只能“未核验”，绝不能报通过
    return {
      status: 'not-verified',
      reason: 'CRC 配置不完整（覆盖范围/初值/异或值缺失）',
      rule: base,
      coveredBytes: [],
      expected: null,
      actual: null,
      width: null,
    };
  }

  const sig = msg.signals.find((s) => s.name === rule.signal);
  const width = sig ? sig.length : null;

  const start = rule.coverStart as number;
  const end = rule.coverEnd as number;
  if (start < 0 || end <= start) {
    return {
      status: 'not-verified',
      reason: 'CRC 覆盖范围非法',
      rule: base,
      coveredBytes: [],
      expected: null,
      actual: null,
      width,
    };
  }
  if (end > data.length) {
    return {
      status: 'truncated',
      reason: `覆盖字节 [${start},${end}) 超出帧 DLC=${data.length}`,
      rule: base,
      coveredBytes: range(start, data.length),
      expected: null,
      actual: null,
      width,
    };
  }

  const covered = data.slice(start, end);
  const expected = xorCrc8(covered, rule.init as number, rule.xorOut as number);

  let actual: number | null = null;
  if (sig) {
    const pos = signalBitPositions(sig.startBit, sig.length, sig.byteOrder);
    if (pos.some((p) => Math.floor(p / 8) >= data.length)) {
      return {
        status: 'truncated',
        reason: 'CRC 信号位超出 DLC',
        rule: base,
        coveredBytes: range(start, end),
        expected,
        actual: null,
        width,
      };
    }
    actual = Number(extractRaw(data, pos, sig.byteOrder).raw);
  }

  return {
    status: actual === expected ? 'pass' : 'fail',
    rule: base,
    coveredBytes: range(start, end),
    expected,
    actual,
    width,
  };
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}
