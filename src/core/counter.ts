import type {
  CounterEvent,
  CounterReport,
  CounterRule,
  DecodeResult,
  MessageDef,
  RawFrame
} from "./types.js";
import { readRawUnsigned, spanFor } from "./bits.js";

export interface CounterInput {
  frame: RawFrame;
  message: MessageDef | null;
  decode: DecodeResult;
  generation: string;
}

function modDelta(actual: number, expected: number, modulus: number): number {
  return (actual - expected + modulus) % modulus;
}

/**
 * 按 (节点, 采集代次) 检查计数器。
 * 输入假定已按确定性顺序排序（hwTimeNs, seqInImport），且同规则帧来自同一发送节点。
 */
export function checkCounters(inputs: CounterInput[], rules: CounterRule[]): CounterReport[] {
  const reports: CounterReport[] = [];

  for (const rule of rules) {
    const matched = inputs.filter(
      (i) =>
        i.frame.arbitrationId === rule.arbitrationId &&
        i.frame.extended === rule.extended &&
        (rule.channel === null || i.frame.channel === rule.channel)
    );

    const groups = new Map<string, CounterInput[]>();
    for (const item of matched) {
      const key = `${rule.nodeName}|${item.generation}`;
      const arr = groups.get(key) ?? [];
      arr.push(item);
      groups.set(key, arr);
    }

    for (const [key, frames] of groups) {
      const events: CounterEvent[] = [];
      const modulus = 2 ** rule.bits;
      let prev: CounterInput | null = null;
      let prevValue: number | null = null;

      for (const item of frames) {
        const ev = (
          type: CounterEvent["type"],
          detail: string,
          expected: number | null,
          actual: number | null
        ): CounterEvent => ({
          type,
          frameId: item.frame.id,
          hwTimeNs: item.frame.hwTimeNs,
          generation: item.generation,
          nodeName: rule.nodeName,
          expected,
          actual,
          detail
        });

        if (prev && item.frame.hwTimeNs === prev.frame.hwTimeNs) {
          events.push(ev("duplicate-timestamp", `与上一帧硬件时间戳完全相同（${item.frame.hwTimeNs} ns）`, null, null));
        }

        const sig = item.message?.signals.find((s) => s.name === rule.signalName);
        if (!sig) {
          events.push(ev("missing-signal", `生效定义中找不到计数器信号 ${rule.signalName}`, null, null));
          prev = item;
          continue;
        }
        const span = spanFor(sig.byteOrder, sig.startBit, sig.length);
        const value = readRawUnsigned(item.frame.data, span, sig.byteOrder);

        if (prevValue !== null) {
          const expected = (prevValue + rule.increment) % modulus;
          if (value === prevValue) {
            events.push(ev("duplicate", `计数器重复：${prevValue} -> ${value}`, expected, value));
          } else {
            const delta = modDelta(value, prevValue, modulus);
            if (delta === rule.increment % modulus) {
              if (value < prevValue) {
                events.push(ev("wrap", `计数器环绕：${prevValue} -> ${value}（模 ${modulus}）`, expected, value));
              }
            } else if (delta > rule.increment) {
              events.push(ev("gap", `计数器缺帧：${prevValue} -> ${value}，跳过 ${delta - rule.increment} 个计数`, expected, value));
            } else {
              events.push(ev("jump", `计数器异常回退/跳变：${prevValue} -> ${value}`, expected, value));
            }
          }
        }

        prevValue = value;
        prev = item;
      }

      const hasHardFail = events.some(
        (e) => e.type !== "wrap" && e.type !== "duplicate-timestamp"
      );
      reports.push({
        key,
        nodeName: rule.nodeName,
        generation: frames[0]?.generation ?? "",
        verdict: events.length === 0 ? "pass" : hasHardFail ? "fail" : "pass",
        events
      });
    }
  }

  reports.sort((a, b) => a.key.localeCompare(b.key));
  return reports;
}
