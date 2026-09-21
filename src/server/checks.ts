import type {
  CheckVerdict,
  CounterConfig,
  CrcConfig,
} from '../shared/types.js';

export interface OrderedFrame {
  id: number;
  data: number[];
  hwTimeMs: number;
  seq: number; // 完全顺序键（导入后规范顺序）
  generation: string;
  channel: string;
  txNode: string | null;
}

export interface CounterSignalProvider {
  (f: OrderedFrame): number | undefined;
}

export interface CounterEvidence {
  frameSeq: number;
  hwTimeMs: number;
  generation: string;
  channel: string;
  node: string;
  observed: number | null;
  expected: number | null;
  /** wrap=环绕正常, repeat=计数器重复, missing=缺帧跳跃, duplicate-time=重复时间戳 */
  findings: string[];
  pass: boolean;
}

export interface CounterReport {
  verdict: CheckVerdict;
  window: number | null;
  reason?: string;
  perGeneration: Array<{
    generation: string;
    node: string;
    evidence: CounterEvidence[];
    gaps: Array<{ fromSeq: number; toSeq: number; missing: number[] }>;
    pass: boolean;
  }>;
}

/**
 * 计数器检查：按节点 + 采集代次分组。
 * 配置不完整（信号取不到值 / 窗口未知）=> unverified，绝不报通过。
 */
export function checkCounter(
  frames: OrderedFrame[],
  cfg: CounterConfig,
  readCounter: CounterSignalProvider
): CounterReport {
  const window =
    typeof cfg.window === 'number' && Number.isFinite(cfg.window) && cfg.window > 1
      ? Math.floor(cfg.window)
      : null;

  const observed = frames.map((f) => readCounter(f));
  if (observed.some((v) => v === undefined)) {
    return {
      verdict: 'unverified',
      window,
      reason: window === null ? '窗口未配置且无法从信号推导' : '计数器信号无法在部分帧中解码',
      perGeneration: [],
    };
  }
  if (window === null) {
    return { verdict: 'unverified', window: null, reason: '窗口未配置且无法从信号推导', perGeneration: [] };
  }

  const groups = new Map<string, { frames: OrderedFrame[]; values: number[] }>();
  frames.forEach((f, i) => {
    const node = f.txNode || cfg.node;
    const key = `${f.generation}||${node}`;
    if (!groups.has(key)) groups.set(key, { frames: [], values: [] });
    const g = groups.get(key)!;
    g.frames.push({ ...f, txNode: node });
    g.values.push(observed[i] as number);
  });

  const perGeneration = [...groups.entries()].map(([key, group]) => {
    const [generation, node] = key.split('||');
    const order = group.frames
      .map((f, i) => ({ f, v: group.values[i] }))
      .sort((a, b) => a.f.seq - b.f.seq);
    const sorted = order.map((o) => o.f);
    const evidence: CounterEvidence[] = [];
    const gaps: CounterReport['perGeneration'][number]['gaps'] = [];
    let prev: CounterEvidence | undefined;

    for (let i = 0; i < sorted.length; i++) {
      const f = sorted[i];
      const value = readCounter(f) ?? null;
      const findings: string[] = [];
      let expected: number | null = null;
      let pass = true;

      if (prev) {
        expected = (prev.observed! + 1) % window;
        if (value === expected) {
          if (expected < (prev.observed ?? 0)) findings.push('wrap');
        } else if (value === prev.observed) {
          findings.push('repeat');
          pass = false;
        } else {
          const missing = ((value - expected + window) % window) + 1;
          findings.push('missing');
          gaps.push({
            fromSeq: prev.frameSeq,
            toSeq: f.seq,
            missing: Array.from({ length: missing }, (_, k) => (prev.observed! + 1 + k) % window),
          });
          pass = false;
        }
        if (f.hwTimeMs === sorted[i - 1].hwTimeMs) {
          findings.push('duplicate-time');
          pass = false;
        }
      }

      const ev: CounterEvidence = {
        frameSeq: f.seq,
        hwTimeMs: f.hwTimeMs,
        generation,
        channel: f.channel,
        node,
        observed: value,
        expected,
        findings,
        pass,
      };
      evidence.push(ev);
      prev = ev;
    }
    return { generation, node, evidence, gaps, pass: evidence.every((e) => e.pass) };
  });

  perGeneration.sort((a, b) => a.generation.localeCompare(b.generation) || a.node.localeCompare(b.node));
  const pass = perGeneration.length > 0 && perGeneration.every((g) => g.pass);
  return { verdict: pass ? 'pass' : 'fail', window, perGeneration };
}

/** CRC-8/SMBUS: poly 0x07, init 0x00, refin/refout=false, xorout 可配置 */
export function crc8(bytes: number[], init: number, xorOut: number): number {
  let crc = init & 0xff;
  for (const byte of bytes) {
    crc ^= byte & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return (crc ^ xorOut) & 0xff;
}

/** 简单按字节累加取模 256，支持初值/异或值 */
export function sum8(bytes: number[], init: number, xorOut: number): number {
  let sum = init & 0xff;
  for (const b of bytes) sum = (sum + (b & 0xff)) & 0xff;
  return (sum ^ xorOut) & 0xff;
}

export interface CrcEvidenceRow {
  frameSeq: number;
  hwTimeMs: number;
  generation: string;
  observed: number | null;
  computed: number;
  coveredBytes: number[];
  pass: boolean;
}

export interface CrcReport {
  verdict: CheckVerdict;
  reason?: string;
  config: {
    algo: 'crc8' | 'sum8';
    coverStartByte: number | null;
    coverEndByte: number | null;
    init: number;
    xorOut: number;
  };
  evidence: CrcEvidenceRow[];
}

/**
 * CRC 检查：覆盖范围/初值/异或值配置不完整 => unverified。
 */
export function checkCrc(
  frames: OrderedFrame[],
  cfg: CrcConfig,
  readCrc: (f: OrderedFrame) => number | undefined,
  dataLen: number
): CrcReport {
  const start = cfg.coverStartByte;
  const end = cfg.coverEndByte;
  const complete =
    typeof start === 'number' &&
    typeof end === 'number' &&
    start >= 0 &&
    end >= start &&
    typeof cfg.init === 'number' &&
    typeof cfg.xorOut === 'number';

  const resolved = {
    algo: cfg.algo,
    coverStartByte: typeof start === 'number' ? start : null,
    coverEndByte: typeof end === 'number' ? end : null,
    init: typeof cfg.init === 'number' ? cfg.init : 0,
    xorOut: typeof cfg.xorOut === 'number' ? cfg.xorOut : 0,
  };

  if (!complete || end >= dataLen) {
    return {
      verdict: 'unverified',
      reason: !complete
        ? 'CRC 配置不完整（覆盖范围 / 初值 / 异或值缺失）'
        : `覆盖终点 byte ${end} 超出数据长度 ${dataLen}`,
      config: resolved,
      evidence: [],
    };
  }
  if (frames.some((f) => readCrc(f) === undefined)) {
    return { verdict: 'unverified', reason: 'CRC 信号无法在部分帧中解码', config: resolved, evidence: [] };
  }

  const evidence: CrcEvidenceRow[] = frames.map((f) => {
    const covered = f.data.slice(start!, end! + 1);
    const computed =
      cfg.algo === 'sum8'
        ? sum8(covered, cfg.init!, cfg.xorOut!)
        : crc8(covered, cfg.init!, cfg.xorOut!);
    const observed = readCrc(f) ?? null;
    return {
      frameSeq: f.seq,
      hwTimeMs: f.hwTimeMs,
      generation: f.generation,
      observed,
      computed,
      coveredBytes: covered,
      pass: observed === computed,
    };
  });

  return {
    verdict: evidence.every((e) => e.pass) ? 'pass' : 'fail',
    config: resolved,
    evidence,
  };
}
