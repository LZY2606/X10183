import type { DbcDocument, MessageDef, MuxKind, SignalDef } from './types.js';

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Supported (subset of) DBC lines:
 *   BO_ 123 NAME: 8 NODE
 *   BO_ 2147483987 NAME: 8 NODE          (id with extended flag 0x80000000)
 *   SG_ Sig : 0|16@1+ (1,0) [0|100] "unit" NODES
 *   SG_ Sw M : 24|4@1+ ...
 *   SG_ Br m0 : 8|8@1- ...
 *   VAL_ 123 Sig 0 "Off" 1 "On" ;
 */
export function parseDbc(text: string, name = 'imported.dbc'): DbcDocument {
  const lines = stripComments(text).split(/\r?\n/);
  const messages: MessageDef[] = [];
  let current: MessageDef | null = null;

  const enumByKey = new Map<string, { value: number; name: string }[]>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const bo = line.match(/^BO_\s+(\d+)\s+(\S+):\s+(\d+)\s+(\S+)/);
    if (bo) {
      const rawId = Number(bo[1]);
      const isExtended = (rawId & 0x80000000) !== 0;
      current = {
        messageId: rawId & 0x1fffffff,
        isExtended,
        name: bo[2],
        dlc: Number(bo[3]),
        transmitter: bo[4] === 'Vector__XXX' ? '' : bo[4],
        signals: [],
      };
      messages.push(current);
      continue;
    }

    const sg = line.match(
      /^SG_\s+(\w+)\s*(?:(m|M)(\d+)?\s*)?:\s*(\d+)\|(\d+)@(0|1)([+-])\s+\(([^,]+),([^)]+)\)\s+\[([^|]*)\|([^\]]*)\]\s+"([^"]*)"\s*(.*)$/
    );
    if (sg) {
      if (!current) throw new Error(`SG_ without BO_: ${line}`);
      const muxMarker = sg[2] as 'm' | 'M' | undefined;
      let muxKind: MuxKind = 'plain';
      let muxSwitchName: string | undefined;
      let muxValue: number | undefined;
      if (muxMarker === 'M') muxKind = 'switch';
      else if (muxMarker === 'm') {
        muxKind = 'branch';
        muxValue = Number(sg[3]);
      }
      const sig: SignalDef = {
        name: sg[1],
        startBit: Number(sg[4]),
        length: Number(sg[5]),
        byteOrder: sg[6] === '0' ? 'motorola' : 'intel',
        valueType: sg[7] === '-' ? 'signed' : 'unsigned',
        factor: Number(sg[8]),
        offset: Number(sg[9]),
        unit: sg[12],
        muxKind,
        muxSwitchName,
        muxValue,
        enums: [],
      };
      current.signals.push(sig);
      continue;
    }

    const val = line.match(/^VAL_\s+(\d+)\s+(\w+)\s+([\s\S]*?);$/);
    if (val) {
      const rawId = Number(val[1]) & 0x1fffffff;
      const sigName = val[2];
      const pairs = [...val[3].matchAll(/(-?\d+)\s+"([^"]*)"/g)].map((m) => ({
        value: Number(m[1]),
        name: m[2],
      }));
      enumByKey.set(`${rawId}.${sigName}`, pairs);
      continue;
    }
  }

  for (const msg of messages) {
    const switchNames = new Set(msg.signals.filter((s) => s.muxKind === 'switch').map((s) => s.name));
    const switchName = [...switchNames][0];
    for (const sig of msg.signals) {
      if (sig.muxKind === 'branch') sig.muxSwitchName = switchName;
      sig.enums = enumByKey.get(`${msg.messageId}.${sig.name}`) ?? [];
    }
  }

  return { name, messages };
}

export function findMessage(doc: DbcDocument, id: number, isExtended: boolean): MessageDef | undefined {
  return doc.messages.find((m) => m.messageId === id && m.isExtended === isExtended);
}
