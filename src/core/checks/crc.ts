import { replay } from "../replay";
import type { DatabaseSync } from "node:sqlite";
import type { BitRange, CrcEvidence, CrcRule, DecodedFrame } from "../types";

function crc8Bytes(bytes: number[], poly: number, init: number, xorOut: number): number {
  let crc = init & 0xff;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? (((crc << 1) ^ poly) & 0xff) : ((crc << 1) & 0xff);
    }
  }
  return (crc ^ xorOut) & 0xff;
}

/** 把若干不重叠/可重叠的 MSB-first 位区间（linear 坐标）紧凑为字节序列，高位先行。 */
function bitsToBytes(
  data: number[],
  spans: BitRange[],
): { bytes: number[]; covered: BitRange[] } {
  const set = new Set<number>();
  for (const s of spans) for (let b = s.first; b <= s.last; b++) set.add(b);
  const bits = [...set].sort((a, b) => a - b);
  const bytes: number[] = [];
  let cur = 0;
  let n = 0;
  for (const linear of bits) {
    const byte = data[Math.floor(linear / 8)] ?? 0;
    const v = (byte >> (linear % 8)) & 1;
    cur = (cur << 1) | v;
    n++;
    if (n === 8) {
      bytes.push(cur);
      cur = 0;
      n = 0;
    }
  }
  if (n > 0) bytes.push(cur << (8 - n));
  return { bytes, covered: spans };
}

/**
 * CRC 证据。任何关键配置缺失（规则不存在、找不到 crc 信号、覆盖信号无法全部解析）
 * 都只能给“未核验”，绝不允许报通过。
 */
export function checkCrcs(db: DatabaseSync, rules: CrcRule[]): CrcEvidence[] {
  const decoded = replay(db);
  const byMessage = new Map(rules.map((r) => [r.messageName, r]));
  const out: CrcEvidence[] = [];

  for (const f of decoded) {
    if (!f.messageName) continue;
    const rule = byMessage.get(f.messageName);
    if (!rule) continue;

    const base = (partial: Partial<CrcEvidence>): CrcEvidence => ({
      frameId: f.frameId,
      channel: f.channel,
      hwTime: f.hwTime,
      gen: f.gen,
      verdict: "unverified",
      expected: null,
      actual: null,
      poly: rule?.poly ?? 0,
      init: rule?.init ?? 0,
      xorOut: rule?.xorOut ?? 0,
      coveredBits: [],
      crcBits: null,
      detail: "",
      ...partial,
    });

    const crcSig = f.signals.find((s) => s.name === rule.crcSignal && s.status === "active");
    if (!crcSig) {
      out.push(base({ detail: `未核验：找不到活跃 CRC 信号 ${rule.crcSignal}` }));
      continue;
    }
    if (crcSig.length > 8) {
      out.push(base({ detail: `未核验：CRC 信号 ${rule.crcSignal} 宽度 ${crcSig.length} 超出 CRC-8` }));
      continue;
    }

    // 覆盖范围：显式列表（按顺序紧凑）或“除 crc 外全部 active 信号”。
    let coverNames: string[];
    if (rule.coverSignals === null) {
      coverNames = f.signals
        .filter((s) => s.status === "active" && s.name !== rule.crcSignal)
        .map((s) => s.name);
    } else {
      coverNames = rule.coverSignals;
    }

    const coverSigs = coverNames.map((name) =>
      f.signals.find((s) => s.name === name && s.status === "active"),
    );
    const missing = coverSigs
      .map((s, i) => (s ? null : coverNames[i]))
      .filter((x): x is string => x !== null);
    if (missing.length > 0) {
      out.push(
        base({
          crcBits: crcSig.bits,
          detail: `未核验：覆盖信号在当前帧无法解析（${missing.join(", ")}）`,
        }),
      );
      continue;
    }

    // 覆盖边界必须显式可见：按声明顺序给出每个信号的 bit 区间。
    const spans = coverSigs.map((s) => s!.bits);
    const { bytes } = bitsToBytes(f.data, spans);
    const expected = crc8Bytes(bytes, rule.poly, rule.init, rule.xorOut);
    const actual = crcSig.raw >>> 0;
    const pass = expected === actual;

    out.push({
      frameId: f.frameId,
      channel: f.channel,
      hwTime: f.hwTime,
      gen: f.gen,
      verdict: pass ? "pass" : "fail",
      expected,
      actual,
      poly: rule.poly,
      init: rule.init,
      xorOut: rule.xorOut,
      coveredBits: spans,
      crcBits: crcSig.bits,
      detail: pass
        ? `CRC 匹配：poly=0x${hex(rule.poly)} init=0x${hex(rule.init)} xor=0x${hex(rule.xorOut)}，覆盖 ${coverNames.length} 个信号`
        : `CRC 不匹配：期望 0x${hex(expected)}，帧内 0x${hex(actual)}`,
    });
  }
  return out;
}

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, "0");
}
