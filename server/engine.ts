import { effectiveAt } from '../src/core/dbc.js';
import { decodeFrame, matchMessage } from '../src/core/decoder.js';
import { verifyCrc } from '../src/core/crc.js';
import { checkCounter } from '../src/core/counters.js';
import { getMessages, listDbcs, listFrames, listCrcRules, listCounterRules } from './repo.js';
import type {
  CrcReport,
  CounterReport,
  DecodedFrame,
  MessageDef,
  RawFrame
} from '../src/core/types.js';

export interface ReplayContext {
  dbcs: ReturnType<typeof listDbcs>;
  messagesByDbc: Map<number, MessageDef[]>;
}

export function buildContext(): ReplayContext {
  const dbcs = listDbcs();
  const messagesByDbc = new Map<number, MessageDef[]>();
  for (const v of dbcs) messagesByDbc.set(v.id, getMessages(v.id));
  return { dbcs, messagesByDbc };
}

/** 按采集时点重放一帧：先选生效 DBC，再匹配消息定义 */
export function replayOne(frame: RawFrame, ctx: ReplayContext): DecodedFrame {
  const dbcId = effectiveAt(ctx.dbcs, frame.hwTime);
  if (dbcId === null) return decodeFrame(frame, null, null);
  const dbc = ctx.dbcs.find((v) => v.id === dbcId)!;
  const msg = (ctx.messagesByDbc.get(dbcId) ?? []).find((m) => matchMessage(m, frame)) ?? null;
  return decodeFrame(frame, dbc, msg);
}

export function replayAll(frames?: RawFrame[]): DecodedFrame[] {
  const ctx = buildContext();
  return (frames ?? listFrames()).map((f) => replayOne(f, ctx));
}

/** 冻结回放：快照记录 dbcId 与每个帧的解码结果，后续 DBC 修订不影响它 */
export function frozenReplay(
  frames: RawFrame[],
  forcedDbcId: number | null,
  ctx: ReplayContext
): DecodedFrame[] {
  if (forcedDbcId === null) return frames.map((f) => decodeFrame(f, null, null));
  const dbc = ctx.dbcs.find((v) => v.id === forcedDbcId) ?? null;
  return frames.map((f) => {
    const msg = dbc ? (ctx.messagesByDbc.get(dbc.id) ?? []).find((m) => matchMessage(m, f)) ?? null : null;
    return decodeFrame(f, dbc, msg);
  });
}

export function counterReports(): CounterReport[] {
  const decoded = replayAll();
  return listCounterRules().map((rule) => {
    // 计数器信号在新旧 DBC 中同名：按规则的 node（发送节点）过滤消息，避免取到另一布局
    return checkCounter(decoded, rule);
  });
}

export function crcReports(): CrcReport[] {
  const decoded = replayAll();
  return listCrcRules().map((rule) => {
    const target = decoded.filter(
      (d) => d.message?.name === rule.messageName && d.reason === 'ok'
    );
    if (target.length === 0) {
      return { messageName: rule.messageName, configured: false, missingConfig: ['no-frames'], evidences: [] };
    }
    return verifyCrc(target.map((d) => d.frame), target[0].message!, rule);
  });
}
