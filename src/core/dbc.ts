/**
 * DBC model types and a subset parser (BO_, SG_ with mux, VAL_ enums).
 * Extended frames: DBC encodes them by setting bit 31 of the message id.
 */

export interface SignalDef {
  name: string;
  startBit: number;
  length: number;
  byteOrder: "intel" | "motorola";
  signed: boolean;
  scale: number;
  offset: number;
  min: number | null;
  max: number | null;
  unit: string;
  muxRole: "multiplexor" | "multiplexed" | "plain";
  muxValue: number | null;
  enums: Record<number, string>;
}

export interface MessageDef {
  arbitrationId: number;
  isExtended: boolean;
  name: string;
  dlc: number;
  sender: string;
  signals: SignalDef[];
}

export interface DbcDefinition {
  messages: MessageDef[];
}

const EXTENDED_FLAG = 0x80000000;

export function parseDbc(text: string): DbcDefinition {
  const messages: MessageDef[] = [];
  let current: MessageDef | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("BO_ ")) {
      const m = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/.exec(line);
      if (!m) continue;
      const rawId = Number(m[1]);
      const isExtended = (rawId & EXTENDED_FLAG) !== 0;
      current = {
        arbitrationId: isExtended ? rawId & ~EXTENDED_FLAG : rawId,
        isExtended,
        name: m[2],
        dlc: Number(m[3]),
        sender: m[4],
        signals: [],
      };
      messages.push(current);
      continue;
    }
    if (line.startsWith("SG_ ") && current) {
      const m =
        /^SG_\s+(\w+)\s*(M|m(\d+))?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)\s*\[\s*([-\d.eE+]+)\s*\|\s*([-\d.eE+]+)\s*\]\s*"([^"]*)"/.exec(
          line,
        );
      if (!m) continue;
      const muxToken = m[2] ?? null;
      current.signals.push({
        name: m[1],
        muxRole: muxToken === "M" ? "multiplexor" : muxToken ? "multiplexed" : "plain",
        muxValue: muxToken && muxToken !== "M" ? Number(m[3]) : null,
        startBit: Number(m[4]),
        length: Number(m[5]),
        byteOrder: m[6] === "1" ? "intel" : "motorola",
        signed: m[7] === "-",
        scale: Number(m[8]),
        offset: Number(m[9]),
        min: Number(m[10]),
        max: Number(m[11]),
        unit: m[12] ?? "",
        enums: {},
      });
      continue;
    }
    if (line.startsWith("VAL_ ")) {
      const m = /^VAL_\s+(\d+)\s+(\w+)\s+(.*?);/.exec(line);
      if (!m) continue;
      const rawId = Number(m[1]);
      const isExtended = (rawId & EXTENDED_FLAG) !== 0;
      const arbId = isExtended ? rawId & ~EXTENDED_FLAG : rawId;
      const msg = messages.find(
        (mm) => mm.arbitrationId === arbId && mm.isExtended === isExtended,
      );
      const sig = msg?.signals.find((s) => s.name === m[2]);
      if (!sig) continue;
      const pairs = m[3].matchAll(/(-?\d+)\s+"([^"]*)"/g);
      for (const p of pairs) sig.enums[Number(p[1])] = p[2];
    }
  }
  return { messages };
}

/** Lookup must never mix standard and extended frames. */
export function findMessage(
  dbc: DbcDefinition,
  arbitrationId: number,
  isExtended: boolean,
): MessageDef | null {
  return (
    dbc.messages.find(
      (m) => m.arbitrationId === arbitrationId && m.isExtended === isExtended,
    ) ?? null
  );
}
