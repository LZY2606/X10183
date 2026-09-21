// 总线刻度 — CRC8 校验：覆盖范围 / 初值 / 异或值可配置
import type { CrcConfig } from './types.js';

export type CrcCompleteness =
  | { ok: true; config: NormalizedCrc }
  | { ok: false; reason: string };

export interface NormalizedCrc {
  startByte: number;
  endByte: number;
  polynomial: number;
  init: number;
  xorOut: number;
  reflect: boolean;
}

/** 配置不完整 => 不能报通过，只能“未核验” */
export function checkCrcConfig(config: CrcConfig | null | undefined): CrcCompleteness {
  if (!config) return { ok: false, reason: '未配置 CRC 规则' };
  const { startByte, endByte, polynomial, init, xorOut } = config;
  if (init === null || init === undefined) return { ok: false, reason: '缺少初值（init）' };
  if (xorOut === null || xorOut === undefined) return { ok: false, reason: '缺少异或值（xorOut）' };
  if (!Number.isInteger(startByte) || !Number.isInteger(endByte)) {
    return { ok: false, reason: '覆盖范围不是整数字节' };
  }
  if (startByte < 0 || endByte <= startByte) {
    return { ok: false, reason: '覆盖范围非法（需 0 <= start < end）' };
  }
  if (endByte > 8) {
    return { ok: false, reason: '覆盖范围超出 CAN 帧最大 8 字节' };
  }
  const poly = polynomial ?? 0x07;
  if (poly < 0 || poly > 0xff || init < 0 || init > 0xff || xorOut < 0 || xorOut > 0xff) {
    return { ok: false, reason: '多项式/初值/异或值超出 0..255' };
  }
  return {
    ok: true,
    config: { startByte, endByte, polynomial: poly, init, xorOut, reflect: config.reflect ?? false }
  };
}

const rev8 = (x: number): number => {
  let r = 0;
  for (let i = 0; i < 8; i++) {
    r = (r << 1) | ((x >> i) & 1);
  }
  return r & 0xff;
};

/** 对 data[startByte,endByte) 计算 CRC8 */
export function crc8(data: Uint8Array, c: NormalizedCrc): number {
  let crc = c.init;
  const poly = c.reflect ? rev8(c.polynomial) : c.polynomial;
  for (let i = c.startByte; i < c.endByte; i++) {
    let b = data[i];
    if (c.reflect) b = rev8(b);
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ poly) & 0xff : (crc << 1) & 0xff;
    }
  }
  if (c.reflect) crc = rev8(crc);
  return (crc ^ c.xorOut) & 0xff;
}
