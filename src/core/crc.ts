import type { CrcRule, CrcEvidence, RawFrame, RuleVerdict } from "./types.js";
import { readRawUnsigned, spanFor } from "./bits.js";
import { findSignal } from "./decode.js";

function reflect(value: number, width: number): number {
  let out = 0;
  for (let i = 0; i < width; i++) {
    if ((value >> i) & 1) out |= 1 << (width - 1 - i);
  }
  return out >>> 0;
}

/** 宽度为 8 的可配置 CRC。配置不完整时不允许猜测，直接返回 unchecked。 */
export function computeCrc8(data: Buffer, opts: {
  polynomial: number;
  init: number;
  xorOut: number;
  reflectInput: boolean;
  reflectOutput: boolean;
}): number {
  let crc = opts.init & 0xff;
  for (const byte of data) {
    let b = opts.reflectInput ? reflect(byte, 8) : byte;
    crc ^= (b << 0) & 0xff;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x80) crc = ((crc << 1) ^ opts.polynomial) & 0xff;
      else crc = (crc << 1) & 0xff;
    }
  }
  if (opts.reflectOutput) crc = reflect(crc, 8);
  return (crc ^ opts.xorOut) & 0xff;
}

function isComplete(rule: CrcRule): boolean {
  return (
    rule.startByte !== null &&
    rule.lengthBytes !== null &&
    rule.polynomial !== null &&
    rule.init !== null &&
    rule.xorOut !== null
  );
}

export function missingFields(rule: CrcRule): string[] {
  const missing: string[] = [];
  if (rule.startByte === null) missing.push("起始字节");
  if (rule.lengthBytes === null) missing.push("覆盖长度");
  if (rule.polynomial === null) missing.push("多项式");
  if (rule.init === null) missing.push("初值");
  if (rule.xorOut === null) missing.push("异或值");
  return missing;
}

/**
 * 校验一帧 CRC。覆盖范围为 data[startByte .. startByte+lengthBytes)，
 * CRC 信号自身所在字节自动排除（跨字节信号按所占字节排除）。
 */
export function verifyCrc(
  frame: RawFrame,
  rule: CrcRule,
  messageDef: import("./types.js").MessageDef
): CrcEvidence {
  const base = { frameId: frame.id, hwTimeNs: frame.hwTimeNs, rule };
  if (!isComplete(rule)) {
    return {
      ...base,
      verdict: "unchecked",
      expected: null,
      actual: null,
      coveredBytes: null,
      crcByte: null,
      reason: `配置不完整（缺少：${missingFields(rule).join("、")}），仅标记为“未核验”`
    };
  }

  const sig = findSignal(messageDef, rule.signalName);
  if (!sig) {
    return { ...base, verdict: "unchecked", expected: null, actual: null, coveredBytes: null, crcByte: null, reason: `消息中找不到 CRC 信号 ${rule.signalName}` };
  }
  const span = spanFor(sig.byteOrder, sig.startBit, sig.length);
  const crcBytes = new Set(span.cells.map((c) => c.byte));
  const start = rule.startByte as number;
  const len = rule.lengthBytes as number;
  const covered: number[] = [];
  for (let i = start; i < start + len; i++) {
    if (i < 0 || i >= frame.data.length) {
      return { ...base, verdict: "unchecked", expected: null, actual: null, coveredBytes: null, crcByte: null, reason: `覆盖范围越界：字节 ${i} 超出 DLC=${frame.data.length}` };
    }
    if (!crcBytes.has(i)) covered.push(i);
  }
  const payload = Buffer.from(covered.map((i) => frame.data[i]));
  const expected = computeCrc8(payload, {
    polynomial: rule.polynomial as number,
    init: rule.init as number,
    xorOut: rule.xorOut as number,
    reflectInput: rule.reflectInput,
    reflectOutput: rule.reflectOutput
  });
  const actual = readRawUnsigned(frame.data, span, sig.byteOrder);
  const verdict: RuleVerdict = expected === actual ? "pass" : "fail";
  return {
    ...base,
    verdict,
    expected,
    actual,
    coveredBytes: covered,
    crcByte: [...crcBytes],
    reason:
      verdict === "pass"
        ? `CRC 匹配（覆盖字节 ${covered.join(",") || "（仅含CRC自身字节）"}）`
        : `CRC 不匹配：期望 0x${expected.toString(16).padStart(2, "0")}，实际 0x${actual.toString(16).padStart(2, "0")}`
  };
}
