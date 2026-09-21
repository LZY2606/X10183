// 总线刻度 — 计数器（环绕/重复/缺帧）与 CRC 证据
import type Database from 'better-sqlite3';
import { bitCells, extractRaw } from '../shared/codec.js';
import { checkCrcConfig, crc8 } from '../shared/crc.js';
import type {
  CounterEvent, CounterReport, CrcReport, CrcResult, MessageDef, SignalDef
} from '../shared/types.js';
import { FRAME_ORDER_CLAUSE } from './db.js';
import { rowToFrame, getAllMessagesByVersion, type FrameRow } from './repo.js';
import { listVersions, pickAt } from './versions.js';

interface CounterTarget {
  message: MessageDef;
  signal: SignalDef;
  modulus: number;
}

/** 显式 role=counter 优先；其次按信号名约定兜底识别 */
function counterTargets(messages: MessageDef[]): CounterTarget[] {
  const out: CounterTarget[] = [];
  for (const message of messages) {
    for (const signal of message.signals) {
      const named = signal.role === null && /counter|cnt|ctr|alive|live|tick/i.test(signal.name);
      if (signal.role === 'counter' || named) {
        const modulus = signal.counterModulus ?? 2 ** signal.length;
        if (modulus > 1 && modulus <= 2 ** signal.length) {
          out.push({ message, signal, modulus });
        }
      }
    }
  }
  return out;
}

/**
 * 按“节点 + 采集代次”检查计数器。
 * 同代次内按确定性帧序（重复时间戳保持稳定次序）遍历：
 * wrap=环绕，repeat=重复，missing=缺帧，init=首帧基线。
 */
export function counterReports(
  db: Database.Database,
  opts: { generation?: number } = {}
): CounterReport[] {
  const byVersion = getAllMessagesByVersion(db);
  const versions = listVersions(db);
  const targetsByKey = new Map<string, { target: CounterTarget; versionId: number }>();
  for (const version of versions) {
    for (const target of counterTargets(byVersion.get(version.id) ?? [])) {
      const key = `${target.message.arbId}:${target.message.idKind}:${target.signal.name}`;
      if (!targetsByKey.has(key)) targetsByKey.set(key, { target, versionId: version.id });
    }
  }

  const reports: CounterReport[] = [];
  for (const { target } of targetsByKey.values()) {
    const { message, signal, modulus } = target;
    const params: unknown[] = [message.arbId, message.idKind];
    if (opts.generation !== undefined) params.push(opts.generation);
    const rows = db
      .prepare(
        `SELECT f.* FROM frames f
         WHERE f.arb_id = ? AND f.id_kind = ?
         ${opts.generation !== undefined ? 'AND f.generation = ?' : ''}
         ${FRAME_ORDER_CLAUSE}`
      )
      .all(...params) as FrameRow[];

    const events: CounterEvent[] = [];
    let prev: { value: number; frame: FrameRow } | null = null;
    let checked = 0;

    for (const row of rows) {
      // 仅统计该帧在其时间点仍由此消息定义承载的情况
      const version = pickAt(versions, row.hw_time_ns);
      const liveMsg = version
        ? (byVersion.get(version.id) ?? []).find(
            (m) => m.arbId === message.arbId && m.idKind === message.idKind
          )
        : null;
      const liveSig = liveMsg?.signals.find((s) => s.name === signal.name);
      if (!liveSig) continue;

      const value = readSignalUnsigned(liveSig, new Uint8Array(row.data));
      if (value === null) continue;
      checked += 1;

      if (!prev) {
        events.push({
          frameId: row.id,
          hwTimeNs: row.hw_time_ns,
          generation: row.generation,
          kind: 'init',
          expected: null,
          actual: value,
          gapCount: 0,
          detail: `首帧基线 ${value}`
        });
      } else {
        const expected = (prev.value + 1) % modulus;
        const forward = (value - prev.value + modulus) % modulus;
        if (forward === 0) {
          events.push({
            frameId: row.id,
            hwTimeNs: row.hw_time_ns,
            generation: row.generation,
            kind: 'repeat',
            expected,
            actual: value,
            gapCount: 0,
            detail: `计数器重复：保持 ${value}，期望 ${expected}`
          });
        } else if (forward === 1) {
          if (prev.value === modulus - 1 && value === 0) {
            events.push({
              frameId: row.id,
              hwTimeNs: row.hw_time_ns,
              generation: row.generation,
              kind: 'wrap',
              expected,
              actual: value,
              gapCount: 0,
              detail: `计数器环绕：${modulus - 1} -> 0（模 ${modulus}）`
            });
          }
        } else {
          const gap = forward - 1;
          events.push({
            frameId: row.id,
            hwTimeNs: row.hw_time_ns,
            generation: row.generation,
            kind: 'missing',
            expected,
            actual: value,
            gapCount: gap,
            detail: `缺帧 ${gap} 个：${prev.value} -> ${value}，期望 ${expected}`
          });
        }
      }
      prev = { value, frame: row };
    }

    reports.push({
      key: `${message.arbId}:${message.idKind}:${signal.name}`,
      node: message.sender || '未知节点',
      messageName: message.name,
      signalName: signal.name,
      modulus,
      events,
      checked
    });
  }

  return reports.sort((a, b) => a.key.localeCompare(b.key));
}

interface CrcTarget {
  message: MessageDef;
  signal: SignalDef;
}

function crcTargets(messages: MessageDef[]): CrcTarget[] {
  const out: CrcTarget[] = [];
  for (const message of messages) {
    for (const signal of message.signals) {
      const named = signal.role === null && /^crc|checksum|crc8/i.test(signal.name);
      if (signal.role === 'crc' || named) out.push({ message, signal });
    }
  }
  return out;
}

/** CRC 证据：配置不完整 => unchecked（不能报通过）；覆盖越 DLC => invalid */
export function crcReports(
  db: Database.Database,
  opts: { generation?: number } = {}
): CrcReport[] {
  const byVersion = getAllMessagesByVersion(db);
  const versions = listVersions(db);
  const targetsByKey = new Map<string, CrcTarget>();
  for (const version of versions) {
    for (const target of crcTargets(byVersion.get(version.id) ?? [])) {
      const key = `${target.message.arbId}:${target.message.idKind}:${target.signal.name}`;
      if (!targetsByKey.has(key)) targetsByKey.set(key, target);
    }
  }

  const reports: CrcReport[] = [];
  for (const target of targetsByKey.values()) {
    const { message, signal } = target;
    const completeness = checkCrcConfig(signal.crc);
    const params: unknown[] = [message.arbId, message.idKind];
    if (opts.generation !== undefined) params.push(opts.generation);
    const rows = db
      .prepare(
        `SELECT f.* FROM frames f
         WHERE f.arb_id = ? AND f.id_kind = ?
         ${opts.generation !== undefined ? 'AND f.generation = ?' : ''}
         ${FRAME_ORDER_CLAUSE}`
      )
      .all(...params) as FrameRow[];

    const results: CrcResult[] = [];
    for (const row of rows) {
      const version = pickAt(versions, row.hw_time_ns);
      const liveMsg = version
        ? (byVersion.get(version.id) ?? []).find(
            (m) => m.arbId === message.arbId && m.idKind === message.idKind
          )
        : null;
      const liveSig = liveMsg?.signals.find((s) => s.name === signal.name);
      const data = new Uint8Array(row.data);

      const base = {
        frameId: row.id,
        hwTimeNs: row.hw_time_ns,
        generation: row.generation
      };

      if (!liveSig) continue;

      if (!completeness.ok) {
        results.push({
          ...base,
          status: 'unchecked',
          expected: null,
          actual: null,
          coveredBytes: [],
          reason: `未核验：${completeness.reason}`
        });
        continue;
      }
      const c = completeness.config;
      const coveredBytes = range(c.startByte, c.endByte);
      if (c.endByte > row.dlc || signal.startBit >= row.dlc * 8) {
        results.push({
          ...base,
          status: 'invalid',
          expected: null,
          actual: null,
          coveredBytes,
          reason: `覆盖范围 [B${c.startByte},B${c.endByte}) 超出 DLC=${row.dlc}`
        });
        continue;
      }
      const actual = crc8(data, c);
      const expected = readSignalUnsigned(liveSig, data);
      results.push({
        ...base,
        status: expected === actual ? 'pass' : 'fail',
        expected,
        actual,
        coveredBytes,
        reason:
          expected === actual
            ? `CRC 一致：0x${actual.toString(16).padStart(2, '0')}（覆盖 B${c.startByte}..B${c.endByte - 1}）`
            : `CRC 不一致：帧内 0x${(expected ?? 0).toString(16).padStart(2, '0')}，计算 0x${actual.toString(16).padStart(2, '0')}`
      });
    }

    reports.push({
      key: `${message.arbId}:${message.idKind}:${signal.name}`,
      node: message.sender || '未知节点',
      messageName: message.name,
      signalName: signal.name,
      config: signal.crc ?? null,
      complete: completeness.ok,
      results
    });
  }
  return reports.sort((a, b) => a.key.localeCompare(b.key));
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

function readSignalUnsigned(signal: SignalDef, data: Uint8Array): number | null {
  return extractRaw(bitCells(signal), data);
}
