import type {
  ByteOrder,
  DbcDoc,
  IdKind,
  MessageDef,
  SignalDef,
} from '../shared/types.js';
import { normalizeIdKind } from '../shared/types.js';

const EXT_FLAG = 0x80000000;

/**
 * 解析 DBC 文本子集：
 *   VERSION "..."
 *   BO_ 256 EngStatus: 8 ECU
 *   SG_ Speed : 0|16@1- (0.1,0) [0|6553.5] "km/h" Vector__XXX
 *   SG_ Mode M : 24|4@1+ (1,0) [0|15] "" Vector__XXX
 *   SG_ Sub m1 : 8|8@1+ ...
 *   VAL_ 256 Mode 0 "Idle" 1 "Run" ;
 * 扩展帧 id 的最高位（0x80000000）由 CANdb 约定标记。
 */
export function parseDbcText(text: string): DbcDoc {
  const lines = text.split(/\r?\n/);
  let docVersion: string | undefined;
  const messages: MessageDef[] = [];
  let current: MessageDef | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    const version = line.match(/^VERSION\s+"(.*)"$/);
    if (version) {
      docVersion = version[1] || undefined;
      continue;
    }

    const bo = line.match(/^BO_\s+(\d+)\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s+([^\s]+)/);
    if (bo) {
      const coded = Number(bo[1]);
      const id = coded & ~EXT_FLAG;
      const extended = (coded & EXT_FLAG) !== 0;
      const idKind: IdKind = extended ? 'extended' : normalizeIdKind(id);
      current = {
        id,
        idKind,
        name: bo[2],
        dlc: Number(bo[3]),
        sender: bo[4] === 'Vector__XXX' ? undefined : bo[4],
        signals: [],
      };
      messages.push(current);
      continue;
    }

    const sg = line.match(
      /^SG_\s+([A-Za-z0-9_]+)\s*(M|m\d+)?\s*:\s*(\d+)\|(\d+)@(0|1)([+-])\s*\(([^,]+),([^)]+)\)\s*(?:\[([^|]*)\|([^\]]*)\])?\s*"([^"]*)"\s*(.*)$/
    );
    if (sg && current) {
      const muxToken = sg[2];
      const byteOrder: ByteOrder = sg[5] === '0' ? 'motorola' : 'intel';
      const sig: SignalDef = {
        name: sg[1],
        startBit: Number(sg[3]),
        length: Number(sg[4]),
        byteOrder,
        signed: sg[6] === '-',
        factor: Number(sg[7]),
        offset: Number(sg[8]),
        unit: sg[12] || undefined,
        sender: current.sender,
      };
      if (sg[9] !== undefined) sig.min = sg[9] === '' ? undefined : Number(sg[9]);
      if (sg[10] !== undefined) sig.max = sg[10] === '' ? undefined : Number(sg[10]);
      if (muxToken === 'M') sig.muxKind = 'm';
      else if (muxToken) sig.muxKind = muxToken;
      current.signals.push(sig);
      continue;
    }

    const val = line.match(/^VAL_\s+(\d+)\s+([A-Za-z0-9_]+)\s+(.*?)\s*;?$/);
    if (val) {
      const coded = Number(val[1]);
      const id = coded & ~EXT_FLAG;
      const sigName = val[2];
      const table = parseValueTable(val[3]);
      const msg = messages.find((m) => m.id === id);
      const sig = msg?.signals.find((s) => s.name === sigName);
      if (sig && Object.keys(table).length) sig.valueTable = table;
      continue;
    }
  }

  return { version: docVersion, messages };
}

function parseValueTable(body: string): Record<string, string> {
  const table: Record<string, string> = {};
  const re = /(-?\d+)\s+"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) table[String(Number(m[1]))] = m[2];
  return table;
}

/** 判定输入是否像 DBC 文本 */
export function looksLikeDbcText(text: string): boolean {
  return /(^|\n)\s*(VERSION|BO_|BS_\s*:|BU_:)\b/.test(text) || /(^|\n)\s*BO_\s+\d+/.test(text);
}
