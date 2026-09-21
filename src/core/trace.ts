import type { RawFrame } from "./types.js";

export interface ParsedFrame {
  channel: string | null;
  arbitrationId: number;
  extended: boolean;
  hwTimeNs: bigint;
  data: Buffer;
}

function parseTimeToNs(token: string): bigint {
  // candump 风格秒.小数（最多纳秒），补齐到 9 位。
  if (/^-?\d+(\.\d+)?$/.test(token)) {
    const neg = token.startsWith("-");
    const body = neg ? token.slice(1) : token;
    const [whole, frac = ""] = body.split(".");
    const fracPadded = (frac + "000000000").slice(0, 9);
    const ns = BigInt(whole) * 1_000_000_000n + BigInt(fracPadded || "0");
    return neg ? -ns : ns;
  }
  // ISO 时间
  const iso = token.includes("Z") || /[+-]\d\d:?\d\d$/.test(token) ? token : token + "Z";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间戳: ${token}`);
  return BigInt(ms) * 1_000_000n;
}

/**
 * 支持：
 *   (1620000000.123) can0  123#AABBCCDD
 *   (1620000000.123) can0  1FFFFFFF##0AABB...
 *   can0 123#AA        （无时间戳，按相对 0）
 * CSV: time,channel,id,ide,data   （ide=1 扩展；data 为无空格 hex）
 */
export function parseTrace(text: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  const lines = text.split(/\r?\n/);
  let autoIndex = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") && !line.includes("#")) continue;

    if (/^time,/i.test(line)) continue; // CSV 表头
    if (line.startsWith("#")) continue;

    // CSV
    if (line.includes(",") && /^\d/.test(line)) {
      const parts = line.split(",").map((p) => p.trim());
      if (parts.length >= 5) {
        const [time, ch, id, ide, data] = parts;
        frames.push({
          channel: ch || null,
          arbitrationId: parseInt(id, id.startsWith("0x") ? 16 : 16),
          extended: ide === "1" || ide.toLowerCase() === "extended" || ide.toLowerCase() === "x",
          hwTimeNs: parseTimeToNs(time),
          data: parseHex(data)
        });
        continue;
      }
    }

    // candump：可选 "(time)"
    const candump = line.match(/^(?:\(([^)]+)\)\s+)?(\S+)\s+([0-9A-Fa-f]+)(#{1,3}[0-9A-Fa-f]*)\s*$/);
    if (candump) {
      const [, timeTok, ch, idTok, rest] = candump;
      const sepMatch = rest.match(/^(#{1,3})([0-9A-Fa-f]*)$/);
      if (!sepMatch) continue;
      const sep = sepMatch[1];
      const payload = sepMatch[2];
      const extended = sep.startsWith("##");
      // 扩展帧 candump 在 ## 后可能带 1 个 hex flag 字节（如 ##0AA...），数据帧 flag 为 0 时剔除。
      let dataHex = payload;
      if (extended && /^0[0-9A-Fa-f]+$/.test(payload) && payload.length >= 3) {
        dataHex = payload.slice(1);
      }
      frames.push({
        channel: ch || null,
        arbitrationId: parseInt(idTok, 16),
        extended,
        hwTimeNs: timeTok !== undefined ? parseTimeToNs(timeTok) : BigInt(autoIndex) * 1_000_000n,
        data: parseHex(dataHex)
      });
      autoIndex++;
      continue;
    }
  }

  return frames;
}

function parseHex(hex: string): Buffer {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  const padded = clean.length % 2 === 1 ? "0" + clean : clean;
  return Buffer.from(padded, "hex");
}

/**
 * 确定性排序：硬件时间 → 仲裁 id → IDE → DLC → 数据 → 导入批次内序号。
 * 保证不同导入顺序合并后结果一致。
 */
export function deterministicOrder(
  frames: Array<RawFrame & { generation?: string }>
): Array<RawFrame & { generation?: string }> {
  return [...frames].sort((a, b) => {
    const ta = BigInt(a.hwTimeNs);
    const tb = BigInt(b.hwTimeNs);
    if (ta !== tb) return ta < tb ? -1 : 1;
    if (a.arbitrationId !== b.arbitrationId) return a.arbitrationId - b.arbitrationId;
    if (a.extended !== b.extended) return a.extended ? 1 : -1;
    if (a.data.length !== b.data.length) return a.data.length - b.data.length;
    const cmp = Buffer.compare(a.data, b.data);
    if (cmp !== 0) return cmp;
    if (a.channel !== b.channel) return (a.channel ?? "").localeCompare(b.channel ?? "");
    return a.seqInImport - b.seqInImport;
  });
}
