/**
 * Bit-level extraction from CAN payloads.
 *
 * DBC bit numbering:
 * - Intel (little endian, @1): startBit is the LSB position. Bit position p
 *   maps to byte floor(p/8), bit p%8 (bit 0 = LSB of the byte).
 * - Motorola (big endian, @0): startBit is the MSB position in DBC "sawtooth"
 *   numbering, where bit n maps to byte floor(n/8), bit 7-(n%8) (bit 7 = MSB).
 *   Subsequent bits walk toward the LSB of the byte, then continue at the MSB
 *   of the next byte.
 */

export type ByteOrder = "intel" | "motorola";

export interface BitRange {
  /** byte index in the payload */
  byte: number;
  /** bit index inside the byte, 0 = LSB, 7 = MSB */
  bit: number;
}

export interface Extraction {
  /** unsigned raw value */
  raw: bigint;
  /** ordered list of payload bit positions, MSB of the value first */
  bits: BitRange[];
}

function bitAt(data: Uint8Array, byte: number, bit: number): bigint {
  if (byte < 0 || byte >= data.length) return 0n;
  return BigInt((data[byte] >> bit) & 1);
}

export function extractBits(
  data: Uint8Array,
  startBit: number,
  length: number,
  byteOrder: ByteOrder,
): Extraction {
  if (length <= 0) throw new Error(`invalid bit length ${length}`);
  if (startBit < 0) throw new Error(`invalid start bit ${startBit}`);
  const bits: BitRange[] = [];
  let raw = 0n;
  if (byteOrder === "intel") {
    // Collect LSB-first, then reverse so bits[] is MSB-first like Motorola.
    for (let i = 0; i < length; i++) {
      const p = startBit + i;
      const byte = Math.floor(p / 8);
      const bit = p % 8;
      bits.push({ byte, bit });
      raw |= bitAt(data, byte, bit) << BigInt(i);
    }
    bits.reverse();
  } else {
    // Convert DBC sawtooth start bit to sequential big-endian MSB position.
    let pos = Math.floor(startBit / 8) * 8 + (7 - (startBit % 8));
    for (let i = 0; i < length; i++) {
      const byte = Math.floor(pos / 8);
      const bit = 7 - (pos % 8);
      bits.push({ byte, bit });
      raw = (raw << 1n) | bitAt(data, byte, bit);
      pos++;
    }
  }
  return { raw, bits };
}

/** Apply two's-complement sign interpretation to an unsigned raw value. */
export function toSigned(raw: bigint, length: number): bigint {
  if (length <= 0) return raw;
  const signBit = 1n << BigInt(length - 1);
  if ((raw & signBit) === 0n) return raw;
  return raw - (1n << BigInt(length));
}

/** Human readable summary of the covered bit range, e.g. "B2.b7..B3.b0". */
export function describeBits(bits: BitRange[]): string {
  if (bits.length === 0) return "";
  const first = bits[0];
  const last = bits[bits.length - 1];
  return `B${first.byte}.b${first.bit}..B${last.byte}.b${last.bit} (${bits.length}bit)`;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(data: Uint8Array): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}
