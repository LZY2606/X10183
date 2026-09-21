export interface EffectiveVersion {
  id: number;
  versionNumber: number;
  validFrom: number;
  validTo: number | null;
}

/**
 * Effective interval semantics: [validFrom, validTo).
 *  - validFrom is inclusive, validTo is exclusive.
 *  - validTo = NULL means "still effective".
 * When several rows overlap (legacy data), the one with the lowest version
 * number wins so resolution is deterministic.
 */
export function resolveVersion(
  versions: EffectiveVersion[],
  hwTime: number
): EffectiveVersion | undefined {
  return versions
    .filter((v) => hwTime >= v.validFrom && (v.validTo === null || hwTime < v.validTo))
    .sort((a, b) => a.versionNumber - b.versionNumber)[0];
}

export type MigrationStatus =
  | 'identical'
  | 'compatible' // layout changed, factor/offset or bit move, mappable
  | 'enum-changed'
  | 'incompatible' // no plausible mapping
  | 'missing-from'
  | 'missing-to';

export interface SignalMigration {
  signal: string;
  fromBits?: string;
  toBits?: string;
  fromType?: string;
  toType?: string;
  transform: string;
  status: MigrationStatus;
  reason?: string;
}

export interface MessageMigration {
  messageId: number;
  isExtended: boolean;
  name: string;
  signals: SignalMigration[];
  status: MigrationStatus;
}

interface SignalLike {
  name: string;
  startBit: number;
  length: number;
  byteOrder: string;
  valueType: string;
  factor: number;
  offset: number;
  enums: { value: number; name: string }[];
}

interface MessageLike {
  messageId: number;
  isExtended: boolean;
  name: string;
  signals: SignalLike[];
}

function describeLocation(sig: SignalLike): string {
  return `${sig.byteOrder === 'motorola' ? '@0' : '@1'} start=${sig.startBit} len=${sig.length}`;
}

function describeType(sig: SignalLike): string {
  return `${sig.valueType} (${sig.factor},${sig.offset})`;
}

export function compareSignal(from: SignalLike | undefined, to: SignalLike | undefined): SignalMigration {
  if (!from && to) {
    return { signal: to.name, toBits: describeLocation(to), toType: describeType(to), transform: 'new signal', status: 'missing-from' };
  }
  if (from && !to) {
    return { signal: from.name, fromBits: describeLocation(from), fromType: describeType(from), transform: 'dropped', status: 'missing-to' };
  }
  if (!from || !to) throw new Error('unreachable');

  const moved = from.startBit !== to.startBit || from.length !== to.length || from.byteOrder !== to.byteOrder;
  const scaled = from.factor !== to.factor || from.offset !== to.offset;
  const typeChanged = from.valueType !== to.valueType || from.length !== to.length;
  const enumsChanged = JSON.stringify(from.enums) !== JSON.stringify(to.enums);

  const reasons: string[] = [];
  if (moved) reasons.push(`bits ${describeLocation(from)} -> ${describeLocation(to)}`);
  if (scaled) reasons.push(`scale (${from.factor},${from.offset}) -> (${to.factor},${to.offset})`);
  if (typeChanged) reasons.push(`type ${from.valueType}/${from.length} -> ${to.valueType}/${to.length}`);

  // Signedness flip without other layout changes is still expressible as a
  // mapping, but a different raw width plus signedness flip is treated as
  // incompatible (raw universes differ).
  if (from.valueType !== to.valueType && from.length === to.length && !moved && !scaled) {
    return {
      signal: from.name,
      fromBits: describeLocation(from),
      toBits: describeLocation(to),
      fromType: describeType(from),
      toType: describeType(to),
      transform: 'reinterpret signedness',
      status: 'compatible',
      reason: reasons.join('; '),
    };
  }

  if (enumsChanged && !moved && !scaled && !typeChanged) {
    return {
      signal: from.name,
      fromBits: describeLocation(from),
      toBits: describeLocation(to),
      fromType: describeType(from),
      toType: describeType(to),
      transform: 'enum table revised',
      status: 'enum-changed',
      reason: reasons.join('; ') || 'enumeration entries changed',
    };
  }

  if (typeChanged && (moved || scaled)) {
    return {
      signal: from.name,
      fromBits: describeLocation(from),
      toBits: describeLocation(to),
      fromType: describeType(from),
      toType: describeType(to),
      transform: 'cannot map automatically',
      status: 'incompatible',
      reason: reasons.join('; '),
    };
  }

  if (!moved && !scaled && !enumsChanged) {
    return {
      signal: from.name,
      fromBits: describeLocation(from),
      toBits: describeLocation(to),
      fromType: describeType(from),
      toType: describeType(to),
      transform: 'identity',
      status: 'identical',
    };
  }

  const transformParts: string[] = [];
  if (moved) transformParts.push('relocate bits');
  if (scaled) {
    transformParts.push(
      from.factor === to.factor && from.offset !== to.offset
        ? `offset ${to.offset - from.offset}`
        : 'rescale physical value'
    );
  }
  return {
    signal: from.name,
    fromBits: describeLocation(from),
    toBits: describeLocation(to),
    fromType: describeType(from),
    toType: describeType(to),
    transform: transformParts.join(' + ') || 'map',
    status: 'compatible',
    reason: reasons.join('; '),
  };
}

const severity: Record<MigrationStatus, number> = {
  identical: 0,
  compatible: 1,
  'enum-changed': 2,
  incompatible: 4,
  'missing-from': 3,
  'missing-to': 3,
};

export function compareMessages(from: MessageLike, to: MessageLike): MessageMigration {
  const toByName = new Map(to.signals.map((s) => [s.name, s]));
  const fromNames = new Set(from.signals.map((s) => s.name));
  const migrations = from.signals.map((sig) => compareSignal(sig, toByName.get(sig.name)));
  for (const sig of to.signals) {
    if (!fromNames.has(sig.name)) migrations.push(compareSignal(undefined, sig));
  }
  migrations.sort((a, b) => a.signal.localeCompare(b.signal));
  const status = migrations.reduce<MigrationStatus>(
    (worst, m) => (severity[m.status] > severity[worst] ? m.status : worst),
    'identical'
  );
  return { messageId: from.messageId, isExtended: from.isExtended, name: from.name, signals: migrations, status };
}

/** Compare every message that exists in either version (extended/standard kept separate). */
export function compareDbcVersions(from: MessageLike[], to: MessageLike[]): MessageMigration[] {
  const key = (m: MessageLike) => `${m.messageId}:${m.isExtended ? 1 : 0}`;
  const toMap = new Map(to.map((m) => [key(m), m]));
  const fromMap = new Map(from.map((m) => [key(m), m]));
  const allKeys = new Set([...fromMap.keys(), ...toMap.keys()]);
  const out: MessageMigration[] = [];
  for (const k of [...allKeys].sort()) {
    const a = fromMap.get(k);
    const b = toMap.get(k);
    if (a && b) {
      out.push(compareMessages(a, b));
    } else if (a) {
      out.push({
        messageId: a.messageId,
        isExtended: a.isExtended,
        name: a.name,
        signals: a.signals.map((s) => compareSignal(s, undefined)),
        status: 'missing-to',
      });
    } else if (b) {
      out.push({
        messageId: b.messageId,
        isExtended: b.isExtended,
        name: b.name,
        signals: b.signals.map((s) => compareSignal(undefined, s)),
        status: 'missing-from',
      });
    }
  }
  return out;
}
