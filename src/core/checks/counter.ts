import { replay } from "../replay";
import type { DatabaseSync } from "node:sqlite";
import type { CounterEvent, CounterRule } from "../types";

/**
 * 计数器检查：按 节点（消息 transmitter）+ 采集代次 分组，
 * 在规范化重放顺序内检查相邻帧的 counter raw 值：
 *   - duplicate：值未递增（重复时间戳也不豁免）
 *   - wrap：到达 width 位最大值后回到 0（正常环绕证据）
 *   - missing：跳号（期望 prev+1 mod 2^width，实际不同且非首帧）
 */
export function checkCounters(db: DatabaseSync, rules: CounterRule[]): CounterEvent[] {
  const decoded = replay(db);
  const events: CounterEvent[] = [];
  const byMessage = new Map(rules.map((r) => [r.messageName, r]));

  type Group = { node: string; gen: string; prev?: { value: number; frameId: number } };
  // 按 节点 + 采集代次（+消息/版本）分组，节点未知时用消息名兜底以避免错误合并。
  const groups = new Map<string, Group>();

  for (const f of decoded) {
    if (!f.messageName) continue;
    const rule = byMessage.get(f.messageName);
    if (!rule) continue;
    const sig = f.signals.find((s) => s.name === rule.signalName && s.status === "active");
    if (!sig) continue;
    const node = f.transmitter || `(未知节点:${f.messageName})`;
    const key = `${f.messageName}|${f.dbcVersionId}|${node}|${f.gen}`;
    let group = groups.get(key);
    if (!group) {
      group = { node, gen: f.gen };
      groups.set(key, group);
    }
    const max = rule.width >= 31 ? 2 ** rule.width - 1 : (1 << rule.width) - 1;
    const mod = 2 ** rule.width;
    const value = sig.raw >>> 0;

    if (group.prev) {
      const expected = (group.prev.value + 1) % mod;
      const base = {
        frameId: f.frameId,
        channel: f.channel,
        hwTime: f.hwTime,
        gen: f.gen,
        arbId: f.arbId,
        kind: f.kind,
        node: group.node,
      };
      if (value === group.prev.value) {
        events.push({
          ...base,
          type: "duplicate",
          expected,
          actual: value,
          detail: `${rule.signalName}=${value} 与上一帧重复（期望 ${expected}）`,
        });
      } else if (group.prev.value === max && value === 0) {
        events.push({
          ...base,
          type: "wrap",
          expected: 0,
          actual: 0,
          detail: `${rule.signalName} 在 ${max} 后环绕到 0（${rule.width} 位）`,
        });
      } else if (value !== expected) {
        events.push({
          ...base,
          type: "missing",
          expected,
          actual: value,
          detail: `${rule.signalName} 从 ${group.prev.value} 跳到 ${value}，缺 ${(value - expected + mod) % mod} 帧`,
        });
      }
    }
    group.prev = { value, frameId: f.frameId };
  }
  return events;
}
