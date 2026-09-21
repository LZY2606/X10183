/**
 * Configurable CRC-8 evidence for CAN frames.
 * Coverage (byte range), init value and xor-out are all configurable; when any
 * part of the configuration is incomplete the result is "unverified" — never
 * a pass.
 */

export interface CrcConfig {
  /** CRC-8 polynomial (e.g. 0x1d), null when not configured */
  polynomial: number | null;
  /** initial register value */
  init: number | null;
  /** final xor value */
  xorOut: number | null;
  /** first payload byte covered, inclusive */
  coverStart: number | null;
  /** last payload byte covered, inclusive */
  coverEnd: number | null;
  /** reflected input/output (default false = MSB-first) */
  refin?: boolean;
  refout?: boolean;
}

export type CrcStatus = "pass" | "fail" | "unverified";

export interface CrcEvidence {
  status: CrcStatus;
  /** why the CRC could not be verified */
  reason: string | null;
  computed: number | null;
  expected: number | null;
  coveredBytes: string | null; // hex of the covered range
  config: CrcConfig;
}

export function crc8(
  data: Uint8Array,
  polynomial: number,
  init: number,
  xorOut: number,
  refin = false,
  refout = false,
): number {
  let crc = init & 0xff;
  for (const byte of data) {
    const b = refin ? reflect8(byte) : byte;
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ polynomial) & 0xff : (crc << 1) & 0xff;
    }
  }
  if (refout !== refin) crc = reflect8(crc);
  return (crc ^ xorOut) & 0xff;
}

function reflect8(v: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) r = (r << 1) | ((v >> i) & 1);
  return r;
}

export function verifyCrc(
  data: Uint8Array,
  expected: number | null,
  config: CrcConfig,
): CrcEvidence {
  const missing: string[] = [];
  if (config.polynomial === null) missing.push("polynomial");
  if (config.init === null) missing.push("init");
  if (config.xorOut === null) missing.push("xorOut");
  if (config.coverStart === null || config.coverEnd === null) missing.push("coverage");
  if (expected === null) missing.push("expectedSignal");
  if (
    config.coverStart !== null &&
    config.coverEnd !== null &&
    (config.coverStart < 0 || config.coverEnd >= data.length || config.coverStart > config.coverEnd)
  ) {
    missing.push("coverageOutOfRange");
  }
  if (missing.length > 0) {
    return {
      status: "unverified",
      reason: `incomplete config: ${missing.join(", ")}`,
      computed: null,
      expected,
      coveredBytes: null,
      config,
    };
  }
  const covered = data.slice(config.coverStart!, config.coverEnd! + 1);
  const computed = crc8(
    covered,
    config.polynomial!,
    config.init!,
    config.xorOut!,
    config.refin ?? false,
    config.refout ?? false,
  );
  return {
    status: computed === expected ? "pass" : "fail",
    reason: null,
    computed,
    expected,
    coveredBytes: Array.from(covered, (b) => b.toString(16).padStart(2, "0")).join(""),
    config,
  };
}
