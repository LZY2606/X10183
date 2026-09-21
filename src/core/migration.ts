import type { MessageDef, MigrationMapping } from "./types.js";

export interface SignalChange {
  fromSignal: string | null;
  toSignal: string | null;
  kind: "unchanged" | "modified" | "added" | "removed";
  fields: string[];
}

export interface MessageComparison {
  key: string;
  fromMessageName: string;
  toMessageName: string | null;
  presentInFrom: boolean;
  presentInTo: boolean;
  changes: SignalChange[];
  compatible: boolean;
}

export function messageKey(m: Pick<MessageDef, "arbitrationId" | "extended" | "channel">): string {
  return `${m.arbitrationId.toString(16).padStart(8, "0")}:${m.extended ? "x" : "s"}:${m.channel ?? "*"}`;
}

function signalSignature(m: MessageDef, sigName: string): string | null {
  const s = m.signals.find((x) => x.name === sigName);
  if (!s) return null;
  return JSON.stringify({
    start: s.startBit,
    len: s.length,
    order: s.byteOrder,
    signed: s.signed,
    scale: s.scale,
    offset: s.offset,
    mux: s.muxKind,
    muxValue: s.muxValue
  });
}

/**
 * 比较两版 DBC。同名信号按名对齐；布局/缩放变化标记 modified；
 * 新版出现的信号为 added，仅旧版有的为 removed。
 */
export function compareMessages(from: MessageDef[], to: MessageDef[]): MessageComparison[] {
  const keyedFrom = new Map(from.map((m) => [messageKey(m), m]));
  const keyedTo = new Map(to.map((m) => [messageKey(m), m]));
  const allKeys = new Set([...keyedFrom.keys(), ...keyedTo.keys()]);
  const out: MessageComparison[] = [];

  for (const key of [...allKeys].sort()) {
    const a = keyedFrom.get(key) ?? null;
    const b = keyedTo.get(key) ?? null;
    const changes: SignalChange[] = [];

    if (a && b) {
      const names = new Set([...a.signals.map((s) => s.name), ...b.signals.map((s) => s.name)]);
      for (const name of [...names].sort()) {
        const sa = a.signals.find((s) => s.name === name);
        const sb = b.signals.find((s) => s.name === name);
        if (sa && sb) {
          const fields: string[] = [];
          if (sa.startBit !== sb.startBit) fields.push("起始位");
          if (sa.length !== sb.length) fields.push("长度");
          if (sa.byteOrder !== sb.byteOrder) fields.push("字节序");
          if (sa.signed !== sb.signed) fields.push("有符号");
          if (sa.scale !== sb.scale) fields.push("缩放");
          if (sa.offset !== sb.offset) fields.push("偏置");
          if (sa.muxKind !== sb.muxKind || sa.muxValue !== sb.muxValue) fields.push("多路复用");
          changes.push({ fromSignal: name, toSignal: name, kind: fields.length ? "modified" : "unchanged", fields });
        } else if (sa) {
          changes.push({ fromSignal: name, toSignal: null, kind: "removed", fields: [] });
        } else {
          changes.push({ fromSignal: null, toSignal: name, kind: "added", fields: [] });
        }
      }
      // 消息整体不兼容：移除了信号或字节序/起始位变化（破坏性）。
      const breaking = changes.some(
        (c) => c.kind === "removed" || (c.kind === "modified" && (c.fields.includes("字节序") || c.fields.includes("起始位") || c.fields.includes("长度")))
      );
      out.push({
        key,
        fromMessageName: a.name,
        toMessageName: b.name,
        presentInFrom: true,
        presentInTo: true,
        changes,
        compatible: !breaking
      });
    } else if (a) {
      out.push({
        key,
        fromMessageName: a.name,
        toMessageName: null,
        presentInFrom: true,
        presentInTo: false,
        changes: a.signals.map((s) => ({ fromSignal: s.name, toSignal: null, kind: "removed" as const, fields: [] })),
        compatible: false
      });
    } else if (b) {
      out.push({
        key,
        fromMessageName: b.name,
        toMessageName: b.name,
        presentInFrom: false,
        presentInTo: true,
        changes: b.signals.map((s) => ({ fromSignal: null, toSignal: s.name, kind: "added" as const, fields: [] })),
        compatible: true
      });
    }
  }
  return out;
}

/** 生成默认迁移映射 JSON。 */
export function defaultSignalMappings(cmp: MessageComparison): Record<string, { toSignal: string | null; kind: string }> {
  const map: Record<string, { toSignal: string | null; kind: string }> = {};
  for (const c of cmp.changes) {
    if (c.fromSignal) map[c.fromSignal] = { toSignal: c.toSignal, kind: c.kind };
  }
  return map;
}

export function isMappingCompatible(mapping: Pick<MigrationMapping, "signalMappings">): boolean {
  const parsed = JSON.parse(mapping.signalMappings) as Record<string, { kind: string }>;
  return Object.values(parsed).every((v) => v.kind !== "removed");
}

export { signalSignature };
