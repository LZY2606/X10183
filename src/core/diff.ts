import type { DbcDef, MessageDef, SignalDef } from './types';

export interface SignalChange {
  name: string;
  change: 'added' | 'removed' | 'changed';
  detail?: string;
}

export interface MessageDiff {
  arbitration_id: number;
  extended: boolean;
  name: string;
  change: 'added' | 'removed' | 'layout_changed' | 'identical';
  signal_changes: SignalChange[];
}

function signalSignature(s: SignalDef): string {
  return [
    s.start_bit,
    s.length,
    s.byte_order,
    s.signed,
    s.scale,
    s.offset,
    s.mux_value ?? '',
    s.multiplexer ? 'M' : '',
    s.role ?? '',
    JSON.stringify(s.value_table ?? null),
  ].join('|');
}

function msgKey(m: MessageDef): string {
  return `${m.id}:${m.extended}`;
}

export function diffDbc(a: DbcDef, b: DbcDef): MessageDiff[] {
  const out: MessageDiff[] = [];
  const aMap = new Map(a.messages.map((m) => [msgKey(m), m]));
  const bMap = new Map(b.messages.map((m) => [msgKey(m), m]));
  const keys = [...new Set([...aMap.keys(), ...bMap.keys()])].sort();
  for (const key of keys) {
    const ma = aMap.get(key);
    const mb = bMap.get(key);
    if (ma && !mb) {
      out.push({
        arbitration_id: ma.id,
        extended: ma.extended,
        name: ma.name,
        change: 'removed',
        signal_changes: ma.signals.map((s) => ({ name: s.name, change: 'removed' })),
      });
      continue;
    }
    if (!ma && mb) {
      out.push({
        arbitration_id: mb.id,
        extended: mb.extended,
        name: mb.name,
        change: 'added',
        signal_changes: mb.signals.map((s) => ({ name: s.name, change: 'added' })),
      });
      continue;
    }
    const changes: SignalChange[] = [];
    const sigA = new Map(ma!.signals.map((s) => [s.name, s]));
    const sigB = new Map(mb!.signals.map((s) => [s.name, s]));
    for (const [name, sa] of sigA) {
      const sb = sigB.get(name);
      if (!sb) changes.push({ name, change: 'removed' });
      else if (signalSignature(sa) !== signalSignature(sb)) {
        changes.push({
          name,
          change: 'changed',
          detail: `${signalSignature(sa)} -> ${signalSignature(sb)}`,
        });
      }
    }
    for (const name of sigB.keys()) {
      if (!sigA.has(name)) changes.push({ name, change: 'added' });
    }
    out.push({
      arbitration_id: ma!.id,
      extended: ma!.extended,
      name: ma!.name,
      change: changes.length ? 'layout_changed' : 'identical',
      signal_changes: changes,
    });
  }
  return out;
}
