import type { IdKind, RawFrame } from "../types";

export interface TraceParseResult {
  frames: RawFrame[];
  errors: { line: number; text: string }[];
}

/**
 * 支持两种文本 trace，均不依赖车辆/外部消息系统：
 *
 * 1) 带表头 CSV（大小写/下划线不敏感），可识别列：
 *    channel, arb_id/id, kind/ide/extended, data, hw_time/time/timestamp, gen/generation
 *    data 接受 "A1 B2 0F" 或 "A1B20F"；kind 取 std/ext/standard/extended/0/1。
 * 2) 空白分隔行： <index?> <id(hex, 后缀 X=扩展)> <Rx/Tx 等可省> <dlc> <b0 b1 ...>  <时间戳秒> [gen]
 *    行内若显式以 K:V（如 channel:can0 gen:g1）给出，优先采用。
 */
export function parseTrace(text: string, source: string): TraceParseResult {
  const frames: RawFrame[] = [];
  const errors: TraceParseResult["errors"] = [];
  let seq = 0;

  const lines = text.split(/\r?\n/);
  let header: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i].trim();
    if (!rawLine || rawLine.startsWith("#") || rawLine.startsWith(";")) continue;

    try {
      if (rawLine.includes(",")) {
        const cells = splitCsv(rawLine);
        if (!header && looksLikeHeader(cells)) {
          header = cells.map(normalizeHeader);
          continue;
        }
        if (header) {
          const rec = recordFromHeader(header, cells);
          const f = buildFrame(rec, source, seq + 1, lineNo);
          if (f) {
            frames.push(f);
            seq++;
          }
          continue;
        }
        // 无表头 CSV： channel,id,kind,data,time[,gen]
        const [channel, idTok, kindTok, dataTok, timeTok, genTok] = cells;
        const f = buildFrame(
          {
            channel: channel ?? "can0",
            id: idTok ?? "",
            kind: kindTok ?? "std",
            data: dataTok ?? "",
            time: timeTok ?? "0",
            gen: genTok ?? "gen1",
          },
          source,
          seq + 1,
          lineNo,
        );
        if (f) {
          frames.push(f);
          seq++;
        }
      } else {
        const f = parseWhitespaceLine(rawLine, source, seq + 1);
        if (f) {
          frames.push(f);
          seq++;
        }
      }
    } catch (e) {
      errors.push({ line: lineNo, text: (e as Error).message });
    }
  }
  return { frames, errors };
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]/g, "_").replace(/_+/g, "_");
}

function looksLikeHeader(cells: string[]): boolean {
  const joined = cells.map(normalizeHeader).join(",");
  return /arb_id|(^|,)id(,|$)|hw_time|timestamp|(^|,)time(,|$)|data/.test(joined) &&
    !/^[0-9a-fx]+$/i.test(cells[0] ?? "");
}

function recordFromHeader(header: string[], cells: string[]): Record<string, string> {
  const rec: Record<string, string> = {};
  header.forEach((h, i) => {
    rec[h] = cells[i] ?? "";
  });
  return {
    channel: rec.channel ?? rec.bus ?? "can0",
    id: rec.arb_id ?? rec.id ?? rec.can_id ?? "0",
    kind: rec.kind ?? rec.ide ?? rec.extended ?? rec.frame_type ?? "std",
    data: rec.data ?? rec.bytes ?? "",
    time: rec.hw_time ?? rec.time ?? rec.timestamp ?? "0",
    gen: rec.gen ?? rec.generation ?? rec.batch ?? "gen1",
  };
}

function buildFrame(
  rec: { channel: string; id: string; kind: string; data: string; time: string; gen: string },
  source: string,
  seq: number,
  line: number,
): RawFrame | null {
  const kv = extractKv(rec.data);
  const dataStr = kv.data ?? rec.data;
  const idTok = (extractKv(rec.id).id ?? rec.id).trim();
  if (!idTok) throw new Error(`第 ${line} 行缺少 arbitration id`);

  const { arbId, kind: flagKind } = parseId(idTok);
  const kind = flagKind ?? parseKind(rec.kind);
  const data = parseData(dataStr);
  const hwTime = parseTime(rec.time);
  const channel = (extractKv(rec.channel).channel ?? rec.channel).trim() || "can0";
  const gen = (extractKv(rec.gen).gen ?? rec.gen).trim() || "gen1";

  return {
    id: 0,
    channel,
    arbId,
    kind,
    data,
    hwTime,
    gen,
    source,
    seq,
  };
}

/** 从 "a:b k:v" 式字符串里抽取结构化字段，返回剩余 data。 */
function extractKv(s: string): Partial<Record<"channel" | "id" | "data" | "time" | "gen", string>> {
  const out: Record<string, string> = {};
  let rest = s;
  const patterns: [string, RegExp][] = [
    ["channel", /channel:([A-Za-z0-9_-]+)/i],
    ["gen", /gen(?:eration)?:([A-Za-z0-9_.-]+)/i],
  ];
  for (const [key, re] of patterns) {
    const m = re.exec(s);
    if (m) {
      out[key] = m[1];
      rest = rest.replace(m[0], "");
    }
  }
  out.data = rest;
  return out;
}

function parseId(tok: string, defaultRadix: 10 | 16 = 10): { arbId: number; kind: IdKind | null } {
  let kind: IdKind | null = null;
  let t = tok.trim();
  if (/x$/i.test(t) && !/^0x/i.test(t)) {
    kind = "ext";
    t = t.slice(0, -1);
  }
  const arbId = t.toLowerCase().startsWith("0x")
    ? parseInt(t, 16)
    : parseInt(t, defaultRadix);
  if (!Number.isFinite(arbId)) throw new Error(`无法解析 id：${tok}`);
  return { arbId, kind };
}

function parseKind(tok: string): IdKind {
  const t = tok.trim().toLowerCase();
  if (t === "ext" || t === "extended" || t === "1" || t === "x" || t === "true") return "ext";
  return "std";
}

function parseData(tok: string): number[] {
  const cleaned = tok
    .replace(/0x/gi, "")
    .replace(/[.,;]/g, " ")
    .trim();
  if (!cleaned) return [];
  const parts = cleaned.includes(" ") ? cleaned.split(/\s+/) : cleaned.match(/.{1,2}/g) ?? [];
  const bytes = parts.map((p) => {
    const v = parseInt(p, 16);
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`非法字节「${p}」`);
    return v;
  });
  if (bytes.length > 8) throw new Error("CAN 经典帧数据长度不能超过 8 字节");
  return bytes;
}

function parseTime(tok: string): number {
  const t = Number(tok.trim());
  if (!Number.isFinite(t) || t < 0) throw new Error(`非法时间戳：${tok}`);
  return t;
}

function parseWhitespaceLine(line: string, source: string, seq: number): RawFrame | null {
  let channel = "can0";
  let gen = "gen1";
  let kindOverride: IdKind | null = null;
  let work = line;
  for (const [key, re] of [
    ["channel", /channel:([A-Za-z0-9_-]+)/i],
    ["gen", /gen(?:eration)?:([A-Za-z0-9_.-]+)/i],
    ["kind", /kind:(std|ext|standard|extended)/i],
  ] as const) {
    const m = re.exec(work);
    if (m) {
      work = work.replace(m[0], "");
      if (key === "channel") channel = m[1];
      if (key === "gen") gen = m[1];
      if (key === "kind") kindOverride = parseKind(m[1]);
    }
  }

  const toks = work.split(/\s+/).filter(Boolean).filter((t) => !/^(rx|tx)$/i.test(t));

  const isIdTok = (t: string) => /^(0x[0-9a-f]+|[0-9a-f]{1,8})x?$/i.test(t);
  const isByteTok = (t: string) => /^(0x)?[0-9a-f]{1,2}$/i.test(t) && parseInt(t, 16) <= 255;

  let parsed: { idTok: string; dlc: number; bytes: number[]; time: string } | null = null;

  const dIdx = toks.findIndex((t, i) => /^d$/i.test(t) && i >= 1 && i + 1 < toks.length);
  if (dIdx >= 0) {
    const idTok = toks[dIdx - 1];
    const dlc = Number(toks[dIdx + 1]);
    const bytes = toks.slice(dIdx + 2, dIdx + 2 + dlc).map((b) => parseInt(b, 16));
    parsed = { idTok, dlc, bytes, time: toks[dIdx + 2 + dlc] ?? "0" };
  } else {
    // 无 d 标记：枚举 id 候选位置，后随 dlc(0-8)、dlc 个字节、时间戳。
    for (let i = 0; i < toks.length && !parsed; i++) {
      if (!isIdTok(toks[i])) continue;
      const dlc = Number(toks[i + 1]);
      if (!Number.isInteger(dlc) || dlc < 0 || dlc > 8) continue;
      const byteToks = toks.slice(i + 2, i + 2 + dlc);
      if (byteToks.length !== dlc || !byteToks.every(isByteTok)) continue;
      const timeTok = toks[i + 2 + dlc];
      if (timeTok === undefined || !Number.isFinite(Number(timeTok))) continue;
      parsed = { idTok: toks[i], dlc, bytes: byteToks.map((b) => parseInt(b, 16)), time: timeTok };
    }
  }

  if (!parsed) throw new Error(`无法解析 trace 行：${line}`);
  const { arbId, kind: flagKind } = parseId(parsed.idTok, 16);
  return {
    id: 0,
    channel,
    arbId,
    kind: kindOverride ?? flagKind ?? "std",
    data: parsed.bytes,
    hwTime: parseTime(parsed.time),
    gen,
    source,
    seq,
  };
}
