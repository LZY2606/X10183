import type { ByteOrder, DbcVersion, MessageDef, MuxType, SignalDef, ValueDesc } from '../src/types.js';

export interface ParsedDbc {
  messages: Array<{
    arbId: number;
    extended: boolean;
    name: string;
    dlc: number;
    transmitter: string;
    signals: Array<{
      name: string;
      startBit: number;
      length: number;
      byteOrder: ByteOrder;
      signed: boolean;
      scale: number;
      offset: number;
      minimum: number | null;
      maximum: number | null;
      unit: string;
      muxType: MuxType;
      muxSwitch: number | null;
      enums: ValueDesc[];
    }>;
  }>;
}

// BO_ 100 EngineData: 8 Vector__XXX
const BO_RE = /^BO_\s+(\d+)\s+([^:\s]+)\s*:\s*(\d+)\s+(.+)$/;
// SG_ EngineSpeed : 0|16@1- (0.25,0) [0|16383.75] "rpm" Vector__XXX
const SG_RE =
  /^SG_\s+(\w+)\s*(M|\d+m)?\s*:\s*(\d+)\|(\d+)@(0|1)([+-])\s*\(([^,]*),([^)]*)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"\s*(.*)$/;
// VAL_ 100 RunningStatus 0 "Off" 1 "On" ;
const VAL_RE = /^VAL_\s+(\d+)\s+(\w+)\s+(.*)$/;

export function parseDbc(text: string): ParsedDbc {
  const lines = text.split(/\r?\n/);
  const messages: ParsedDbc['messages'] = [];
  let current: ParsedDbc['messages'][number] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    const bo = line.match(BO_RE);
    if (bo) {
      const rawId = parseInt(bo[1], 10);
      const extended = rawId >= 0x80000000;
      current = {
        arbId: extended ? rawId - 0x80000000 : rawId,
        extended,
        name: bo[2],
        dlc: parseInt(bo[3], 10),
        transmitter: bo[4].trim(),
        signals: []
      };
      messages.push(current);
      continue;
    }

    const sg = line.match(SG_RE);
    if (sg && current) {
      const muxTok = sg[2]?.trim();
      let muxType: MuxType = 'none';
      let muxSwitch: number | null = null;
      if (muxTok === 'M') {
        muxType = 'multiplexor';
      } else if (muxTok && /^\d+m$/.test(muxTok)) {
        muxType = 'multiplexed';
        muxSwitch = parseInt(muxTok.slice(0, -1), 10);
      }
      current.signals.push({
        name: sg[1],
        startBit: parseInt(sg[3], 10),
        length: parseInt(sg[4], 10),
        byteOrder: sg[5] === '0' ? 'motorola' : 'intel',
        signed: sg[6] === '-',
        scale: parseFloat(sg[7]),
        offset: parseFloat(sg[8]),
        minimum: sg[9].trim() === '' ? null : parseFloat(sg[9]),
        maximum: sg[10].trim() === '' ? null : parseFloat(sg[10]),
        unit: sg[11],
        muxType,
        muxSwitch,
        enums: []
      });
      continue;
    }

    const val = line.match(VAL_RE);
    if (val && current) {
      const target = current.signals.find((s) => s.name === val[2]);
      if (target) {
        const re = /(-?\d+)\s+"([^"]*)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(val[3]))) {
          target.enums.push({ raw: parseInt(m[1], 10), label: m[2] });
        }
      }
    }
  }

  return { messages };
}

export function serializeDbc(version: Pick<DbcVersion, 'label'> & { messages: MessageDef[] }): string {
  const out: string[] = [`VERSION "${version.label}"`, ''];
  for (const msg of version.messages) {
    const id = msg.extended ? msg.arbId + 0x80000000 : msg.arbId;
    out.push(`BO_ ${id} ${msg.name}: ${msg.dlc} ${msg.transmitter || 'Vector__XXX'}`);
    for (const sig of msg.signals) {
      const mux =
        sig.muxType === 'multiplexor' ? ' M ' : sig.muxType === 'multiplexed' ? ` ${sig.muxSwitch ?? 0}m ` : ' ';
      out.push(
        ` SG_ ${sig.name}${mux}: ${sig.startBit}|${sig.length}@${sig.byteOrder === 'intel' ? 1 : 0}${sig.signed ? '-' : '+'} ` +
          `(${sig.scale},${sig.offset}) [0|0] "${sig.unit}" Vector__XXX`
      );
      if (sig.enums.length) {
        const vals = sig.enums.map((e) => `${e.raw} "${e.label}"`).join(' ');
        out.push(` VAL_ ${id} ${sig.name} ${vals} ;`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

export function emptyParsed(): ParsedDbc {
  return { messages: [] };
}

export function typeOnly(_sig: SignalDef): void {
  void _sig;
}
