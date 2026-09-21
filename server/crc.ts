export interface CrcParams {
  width: number;
  polynomial: number;
  initial: number;
  xorOut: number;
}

export function computeCrc(data: Uint8Array, start: number, length: number, params: CrcParams): number {
  const topBit = 1 << (params.width - 1);
  const mask = (1 << params.width) - 1;
  let crc = params.initial & mask;
  for (let i = start; i < start + length; i++) {
    const byte = i < data.length ? data[i] : 0;
    crc ^= byte << (params.width - 8);
    crc &= mask;
    for (let b = 0; b < 8; b++) {
      if (crc & topBit) {
        crc = ((crc << 1) ^ params.polynomial) & mask;
      } else {
        crc = (crc << 1) & mask;
      }
    }
  }
  return (crc ^ params.xorOut) & mask;
}

export interface CrcConfig {
  id: number;
  message: string;
  signal: string | null;
  coverageStart: number | null;
  coverageLength: number | null;
  width: number | null;
  polynomial: number | null;
  initial: number | null;
  xorOut: number | null;
}

export function crcConfigComplete(cfg: CrcConfig): boolean {
  return (
    cfg.signal !== null &&
    cfg.coverageStart !== null &&
    cfg.coverageLength !== null &&
    cfg.width !== null &&
    cfg.polynomial !== null &&
    cfg.initial !== null &&
    cfg.xorOut !== null
  );
}
