// 总线刻度 — 精简 DBC 解析器（BO_ / SG_ / VAL_，支持标准与扩展帧 id）
import type { DbcVersionInput, MessageDef, MuxType, SignalDef } from './types.js';
import { bitCells } from './codec.js';

const EXT_FLAG = 0x80000000;

interface ParseResult {
  messages: MessageDef[];
  warnings: string[];
}

/**
 * 解析 DBC 文本。
 * 示例：
 *   BO_ 100 EngineData: 8 ECU
 *    SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16000] "rpm" Vector__XXX
 *    SG_ S1 M1 : 8|8@1+ ...
 *   BO_ 2907760640 ...   (扩展帧 id，带 0x80000000 标志)
 *   VAL_ 100 EngineSpeed 0 "Off" 1 "On" ;
 */
export function parseDbc(
  text: string,
  versionId: number,
  extras?: Record<string, Record<string, Partial<SignalDef>>>
): ParseResult {
  const warnings: string[] = [];
  const rawById = new Map<number, MessageDef>();
  const valLines: string[] = [];

  const lines = text.split(/\r?\n/);
  let current: MessageDef | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    const bo = line.match(/^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\S+)/);
    if (bo) {
      const coded = Number(bo[1]);
      const ext = (coded & EXT_FLAG) !== 0;
      // DBC 中扩展帧仅置 bit31 作为标志；低 29 位即真实 arbitration id
      const arbId = coded & 0x7fffffff;
      current = {
        versionId,
        arbId,
        idKind: ext ? 'ext' : 'std',
        name: bo[2],
        length: Number(bo[3]),
        sender: bo[4] === 'Vector__XXX' ? '' : bo[4],
        signals: []
      };
      rawById.set(coded, current);
      continue;
    }

    const sg = line.match(
      /^SG_\s+(\w+)(?:\s+(M\d*|m\d+))?\s*:\s*(\d+)\|(\d+)@(0|1)([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"\s*(.+)$/
    );
    if (sg && current) {
      const [, name, muxTok, start, len, order, sign, factor, bias, minS, maxS, unit, receivers] = sg;
      let muxType: MuxType = null;
      let muxValue: number | null = null;
      if (muxTok) {
        if (muxTok === 'M') {
          muxType = 'Mux';
        } else {
          const v = Number(muxTok.replace(/^m?M?/, ''));
          muxType = String(v);
          muxValue = v;
        }
      }
      const signal: SignalDef = {
        versionId,
        name,
        startBit: Number(start),
        length: Number(len),
        byteOrder: Number(order) as 0 | 1,
        signed: sign === '-',
        factor: Number(factor),
        offset: Number(bias),
        unit,
        min: minS.trim() === '' ? null : Number(minS),
        max: maxS.trim() === '' ? null : Number(maxS),
        muxType,
        muxValue,
        role: null,
        crc: null,
        counterModulus: null,
        valTable: []
      };
      void receivers;
      const ex = extras?.[current.name]?.[name];
      if (ex) Object.assign(signal, ex);
      current.signals.push(signal);
      continue;
    }

    if (line.startsWith('VAL_ ')) {
      valLines.push(line);
      continue;
    }

    if (line.startsWith('BA_') || line.startsWith('BS_') || line.startsWith('BU_') ||
        line.startsWith('CM_') || line.startsWith('BA_DEF') || line.startsWith('VAL_TABLE')) {
      // 暂不支持的定义段：忽略（VAL_TABLE 会在 VAL_ 查表时无表可查）
      continue;
    }
  }

  // VAL_ 支持单行与跨行到 ';'
  const joined = valLines.join(' ');
  const statements = joined.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    const m = stmt.match(/^VAL_\s+(\d+)\s+(\w+)\s+(.*)$/s);
    if (!m) {
      warnings.push(`无法解析 VAL_ 语句: ${stmt.slice(0, 60)}`);
      continue;
    }
    const coded = Number(m[1]);
    const msg = rawById.get(coded);
    if (!msg) {
      warnings.push(`VAL_ 引用了未知消息 id ${coded}`);
      continue;
    }
    const sig = msg.signals.find((s) => s.name === m[2]);
    if (!sig) {
      warnings.push(`VAL_ 引用了未知信号 ${msg.name}.${m[2]}`);
      continue;
    }
    const pairs = [...m[3].matchAll(/(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g)];
    sig.valTable = pairs.map((p) => ({ raw: Number(p[1]), label: p[2].replace(/\\"/g, '"') }));
  }

  const messages = [...rawById.values()];
  // 校验：信号位区间不越 DLC
  for (const msg of messages) {
    for (const sig of msg.signals) {
      const maxByte = Math.max(...bitCells(sig).map((c) => c.byteIndex + 1));
      if (maxByte > msg.length) {
        warnings.push(`${msg.name}.${sig.name} 位区间超出 DLC=${msg.length}`);
      }
    }
  }
  return { messages, warnings };
}

/** 组装一个 DBC 版本输入为存储消息（JSON 直建或 DBC 文本） */
export function buildMessages(input: DbcVersionInput, versionId: number): MessageDef[] {
  if (input.dbcText && input.dbcText.trim()) {
    const parsed = parseDbc(input.dbcText, versionId);
    return parsed.messages;
  }
  return (input.messages ?? []).map((m) => ({
    ...m,
    versionId,
    signals: m.signals.map((s) => ({ ...s, versionId, valTable: s.valTable ?? [] }))
  }));
}

export { EXT_FLAG };
