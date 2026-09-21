import type { MessageDef, SignalDef } from '../shared/types.js';

export type SignalChange =
  | 'unchanged'
  | 'compatible' // 名称一致，缩放/偏置等可迁移
  | 'relayout' // bit 布局变化
  | 'added'
  | 'removed'
  | 'renamed-candidate';

export interface SignalDiff {
  oldName: string | null;
  newName: string | null;
  change: SignalChange;
  details: string[];
  compatible: boolean; // 是否可自动迁移
  oldDef?: SignalDef;
  newDef?: SignalDef;
}

export interface MessageComparison {
  id: number;
  idKind: MessageDef['idKind'];
  oldName: string | null;
  newName: string | null;
  presentIn: ('old' | 'new')[];
  signalDiffs: SignalDiff[];
  autoMapping: Record<string, string>;
  fullyCompatible: boolean;
}

const COMPARE_KEYS: Array<keyof SignalDef> = [
  'length',
  'byteOrder',
  'signed',
  'factor',
  'offset',
  'muxKind',
];

const LAYOUT_KEYS: Array<keyof SignalDef> = ['startBit', 'length', 'byteOrder', 'signed'];

/**
 * 比较两版 DBC 对同一消息的影响。
 * 同名信号：布局变 => relayout；仅缩放/偏置变 => compatible。
 * 移除/新增的信号按名称尝试唯一候选，给出 renamed-candidate。
 */
export function compareMessage(oldMsg: MessageDef | undefined, newMsg: MessageDef | undefined): MessageComparison {
  const id = (oldMsg ?? newMsg)!.id;
  const idKind = (oldMsg ?? newMsg)!.idKind;
  const presentIn: ('old' | 'new')[] = [];
  if (oldMsg) presentIn.push('old');
  if (newMsg) presentIn.push('new');

  const diffs: SignalDiff[] = [];
  const autoMapping: Record<string, string> = {};

  const oldSignals = new Map((oldMsg?.signals ?? []).map((s) => [s.name, s]));
  const newSignals = new Map((newMsg?.signals ?? []).map((s) => [s.name, s]));
  const usedCandidates = new Set<string>();

  for (const oldSig of oldMsg?.signals ?? []) {
    const newSig = newSignals.get(oldSig.name);
    if (newSig) {
      const details = describeChanges(oldSig, newSig);
      const layoutChanged = LAYOUT_KEYS.some((k) => JSON.stringify(oldSig[k]) !== JSON.stringify(newSig[k]));
      const anyChange = details.length > 0;
      const change: SignalChange = !anyChange ? 'unchanged' : layoutChanged ? 'relayout' : 'compatible';
      diffs.push({
        oldName: oldSig.name,
        newName: newSig.name,
        change,
        details,
        compatible: !layoutChanged,
        oldDef: oldSig,
        newDef: newSig,
      });
      autoMapping[oldSig.name] = newSig.name;
      usedCandidates.add(newSig.name);
    } else {
      const candidate = uniqueCandidate(oldSig, [...(newMsg?.signals ?? [])], usedCandidates);
      if (candidate) {
        usedCandidates.add(candidate.name);
        autoMapping[oldSig.name] = candidate.name;
        diffs.push({
          oldName: oldSig.name,
          newName: candidate.name,
          change: 'renamed-candidate',
          details: ['布局与类型一致，仅名称变化'],
          compatible: true,
          oldDef: oldSig,
          newDef: candidate,
        });
      } else {
        diffs.push({
          oldName: oldSig.name,
          newName: null,
          change: 'removed',
          details: ['新版本中不存在该信号'],
          compatible: false,
          oldDef: oldSig,
        });
      }
    }
  }

  for (const newSig of newMsg?.signals ?? []) {
    if (oldSignals.has(newSig.name) || usedCandidates.has(newSig.name)) continue;
    diffs.push({
      oldName: null,
      newName: newSig.name,
      change: 'added',
      details: ['新增信号'],
      compatible: false,
      newDef: newSig,
    });
  }

  diffs.sort(
    (a, b) =>
      (a.oldName ?? a.newName ?? '').localeCompare(b.oldName ?? b.newName ?? '')
  );

  const fullyCompatible = diffs.every((d) => d.compatible || d.change === 'added');

  return {
    id,
    idKind,
    oldName: oldMsg?.name ?? null,
    newName: newMsg?.name ?? null,
    presentIn,
    signalDiffs: diffs,
    autoMapping,
    fullyCompatible,
  };
}

function describeChanges(a: SignalDef, b: SignalDef): string[] {
  const details: string[] = [];
  for (const key of COMPARE_KEYS) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      details.push(`${String(key)}: ${formatVal(a[key])} -> ${formatVal(b[key])}`);
    }
  }
  if (a.startBit !== b.startBit) details.push(`startBit: ${a.startBit} -> ${b.startBit}`);
  if ((a.unit ?? '') !== (b.unit ?? '')) details.push(`unit: ${a.unit ?? ''} -> ${b.unit ?? ''}`);
  return details;
}

function formatVal(v: unknown): string {
  if (v === undefined) return '—';
  return JSON.stringify(v);
}

/** 找布局/类型完全一致、仅名称不同的唯一候选 */
function uniqueCandidate(
  oldSig: SignalDef,
  newSigs: SignalDef[],
  used: Set<string>
): SignalDef | undefined {
  const matches = newSigs.filter(
    (s) =>
      !used.has(s.name) &&
      s.startBit === oldSig.startBit &&
      s.length === oldSig.length &&
      s.byteOrder === oldSig.byteOrder &&
      s.signed === oldSig.signed &&
      s.factor === oldSig.factor &&
      s.offset === oldSig.offset &&
      s.muxKind === oldSig.muxKind
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function collectComparison(
  oldMessages: MessageDef[],
  newMessages: MessageDef[]
): MessageComparison[] {
  const keys = new Map<string, { old?: MessageDef; new?: MessageDef }>();
  for (const m of oldMessages) {
    const k = `${m.id}:${m.idKind}`;
    keys.set(k, { ...keys.get(k), old: m });
  }
  for (const m of newMessages) {
    const k = `${m.id}:${m.idKind}`;
    keys.set(k, { ...keys.get(k), new: m });
  }
  return [...keys.entries()]
    .map(([, pair]) => compareMessage(pair.old, pair.new))
    .sort((a, b) => a.id - b.id);
}
