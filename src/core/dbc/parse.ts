import type {
  ByteOrder,
  IdKind,
  MessageDef,
  MuxRole,
  SignalDef,
} from "../types";

export interface ParsedDbc {
  messages: MessageDef[];
}

const EXT_FLAG = 0x80000000;

function stripComment(line: string): string {
  return line.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "");
}

/**
 * 解析 DBC 子集：
 *   BO_ <id> <Name>: <dlc> <transmitter>
 *   SG_ <Name> [mux] : <start>|<len>@<order><sign> (<scale>,<offset>) ["unit"] [receivers]
 *   VAL_ <id> <Signal> <raw> "Text" ... ;
 * 扩展帧在 BO_/VAL_ id 上带 0x80000000 标志，解析后剥离；标准与扩展分别建消息。
 */
export function parseDbc(text: string): ParsedDbc {
  const messages = new Map<number, MessageDef>();
  const valTables: { id: number; entries: { signal: string; enums: Record<number, string> } }[] = [];

  const lines = text.split(/\r?\n/);
  // 先合并多行语句（以 ; 结尾的 VAL_ 等可能跨行）。
  const statements: string[] = [];
  let buffer = "";
  for (const raw of lines) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    if (buffer) {
      buffer += " " + line;
      if (line.includes(";")) {
        statements.push(buffer);
        buffer = "";
      }
      continue;
    }
    if (/^(VAL_|BA_)\b/.test(line) && !line.includes(";")) {
      buffer = line;
    } else {
      statements.push(line);
    }
  }
  if (buffer) statements.push(buffer);

  const switchIndexByName = new Map<string, number>();
  let switchCount = 0;

  for (const stmt of statements) {
    const bo = /^BO_\s+(\d+)\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s+(\S+)/.exec(stmt);
    if (bo) {
      const rawId = Number(bo[1]);
      const ext = rawId >= EXT_FLAG;
      const arbId = ext ? rawId - EXT_FLAG : rawId;
      messages.set(rawId, {
        arbId,
        kind: (ext ? "ext" : "std") as IdKind,
        name: bo[2],
        dlc: Number(bo[3]),
        transmitter: bo[4] === "Vector__XXX" ? "" : bo[4],
        signals: [],
      });
      continue;
    }

    const sg =
      /^SG_\s+([A-Za-z0-9_]+)\s*(M\d*|m\d+)?\s*:\s*(\d+)\|(\d+)@(0|1)([+-])\s*\(([^,]+),([^)]+)\)\s*(?:"([^"]*)")?/.exec(
        stmt,
      );
    if (sg) {
      // SG_ 必须挂在最近声明的 BO_ 下；语句保持声明顺序。
      const ownerId = [...messages.keys()].at(-1)!;
      const msg = messages.get(ownerId)!;
      const [, name, muxTok, start, len, orderTok, signTok, scale, offset, unit] = sg;
      let mux: MuxRole = { type: "plain" };
      if (muxTok) {
        if (muxTok.startsWith("M")) {
          const idx = muxTok.length > 1 ? Number(muxTok.slice(1)) : switchCount;
          switchIndexByName.set(name, idx);
          switchCount = Math.max(switchCount, idx + 1);
          mux = { type: "switch" };
        } else {
          const digits = muxTok.slice(1);
          const switches = msg.signals
            .map((s, i) => ({ s, i }))
            .filter((x) => x.s.mux.type === "switch");
          if (switches.length <= 1) {
            mux = {
              type: "case",
              switchName: switches[0]?.s.name ?? "",
              value: Number(digits),
            };
          } else {
            // 扩展多路复用：首位是 switch 序号，其余为分支值。
            const idx = Number(digits[0]);
            const sw = switches.find((x) => switchIndexByName.get(x.s.name) === idx);
            mux = {
              type: "case",
              switchName: sw?.s.name ?? switches[0].s.name,
              value: Number(digits.slice(1)),
            };
          }
        }
      }
      const sig: SignalDef = {
        name,
        startBit: Number(start),
        length: Number(len),
        order: (orderTok === "0" ? "intel" : "motorola") as ByteOrder,
        signed: signTok === "-",
        scale: Number(scale),
        offset: Number(offset),
        unit: unit ?? "",
        mux,
        enums: {},
      };
      msg.signals.push(sig);
      continue;
    }

    const val = /^VAL_\s+(\d+)\s+([A-Za-z0-9_]+)\s+(.*?);?$/.exec(stmt);
    if (val) {
      const id = Number(val[1]);
      const signal = val[2];
      const enums: Record<number, string> = {};
      const re = /(-?\d+)\s+"([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(val[3]))) enums[Number(m[1])] = m[2];
      valTables.push({ id, entries: { signal, enums } });
    }
  }

  for (const table of valTables) {
    const msg = messages.get(table.id);
    const sig = msg?.signals.find((s) => s.name === table.entries.signal);
    if (sig) Object.assign(sig.enums, table.entries.enums);
  }

  return { messages: [...messages.values()] };
}
