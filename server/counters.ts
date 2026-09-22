import type { DB } from './db.js';
import type { CounterEvent } from '../src/types.js';
import { listFramesOrdered } from './repo.js';
import { decodeFrame } from './decode.js';

interface CounterRuleRow {
  dbc_id: number;
  arb_id: number;
  extended: number;
  signal_name: string;
  width: number;
  node: string;
}

export function analyzeCounters(db: DB): CounterEvent[] {
  const rules = db.prepare('SELECT * FROM rule_counters ORDER BY id').all() as CounterRuleRow[];
  if (!rules.length) return [];

  const frames = listFramesOrdered(db);
  const events: CounterEvent[] = [];

  // 按 节点 + 采集代次 分组
  const groups = new Map<string, { rule: CounterRuleRow; frames: typeof frames }>();

  for (const frame of frames) {
    const decoded = decodeFrame(db, frame.id);
    for (const rule of rules) {
      if (rule.arb_id !== frame.arbId || !!rule.extended !== frame.extended) continue;
      if (decoded.dbcId !== rule.dbc_id) continue;
      const sig = decoded.signals.find((s) => s.name === rule.signal_name);
      if (!sig || !sig.active) continue;
      const key = `${rule.node}|${frame.importGen}|${rule.arb_id}|${frame.extended}|${rule.signal_name}`;
      let group = groups.get(key);
      if (!group) {
        group = { rule, frames: [] };
        groups.set(key, group);
      }
      group.frames.push(frame);
    }
  }

  for (const group of groups.values()) {
    const { rule } = group;
    const modulus = 2 ** rule.width;
    let prevRaw: number | null = null;
    let prevTime: number | null = null;

    for (const frame of group.frames) {
      const decoded = decodeFrame(db, frame.id);
      const sig = decoded.signals.find((s) => s.name === rule.signal_name);
      const raw = sig?.raw ?? null;
      let event: CounterEvent['event'] = 'ok';
      let detail = '连续递增';
      let expected: number | null = null;

      if (prevRaw !== null && raw !== null) {
        const delta = ((raw - prevRaw) % modulus + modulus) % modulus;
        expected = (prevRaw + 1) % modulus;
        if (raw === 0 && prevRaw === modulus - 1) {
          event = 'wrap';
          detail = `环绕：${prevRaw}→${raw}（${rule.width} bit）` + (prevTime === frame.hwTime ? '；同时存在重复时间戳' : '');
        } else if (prevTime === frame.hwTime) {
          event = 'duplicate';
          detail = `重复时间戳 ${frame.hwTime}（计数 ${prevRaw}→${raw}）`;
        } else if (raw === prevRaw) {
          event = 'duplicate';
          detail = `计数值重复（${raw}），期望 ${expected}`;
        } else if (delta === 1) {
          event = 'ok';
          detail = '连续递增';
        } else {
          event = 'gap';
          detail = `缺帧：${prevRaw}→${raw}，期望 ${expected}，跳过 ${delta - 1} 帧`;
        }
      } else {
        detail = '序列起点';
      }

      events.push({
        frameId: frame.id,
        channel: frame.channel,
        arbId: frame.arbId,
        hwTime: frame.hwTime,
        importGen: frame.importGen,
        node: rule.node,
        signalName: rule.signal_name,
        raw,
        expected,
        event,
        detail
      });
      prevRaw = raw;
      prevTime = frame.hwTime;
    }
  }

  events.sort((a, b) => a.hwTime - b.hwTime || a.importGen - b.importGen || a.frameId - b.frameId);
  return events;
}
