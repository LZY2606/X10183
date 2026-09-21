import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { openMemory, resetDatabase } from '../server/db.js';
import {
  clearFrames,
  getMessages,
  insertDbc,
  insertFrames,
  insertParsedDbc,
  listMigrations,
  updateMigrationStatus
} from '../server/repo.js';
import { handleApi } from '../server/api.js';
import { replayAll } from '../server/engine.js';
import type { ParsedMessage } from '../src/core/dbc.js';

function mockReq(method: string, target: string, body?: unknown) {
  const chunks: Buffer[] = [];
  if (body !== undefined) chunks.push(Buffer.from(JSON.stringify(body)));
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = target;
  queueMicrotask(() => {
    for (const c of chunks) req.emit('data', c);
    req.emit('end');
  });
  return req as import('node:http').IncomingMessage;
}

function call(method: string, target: string, body?: unknown): Promise<{ code: number; json: any }> {
  return new Promise((resolve, reject) => {
    const res: any = {
      writeHead(code: number) {
        this.code = code;
      },
      end(payload: string) {
        resolve({ code: this.code ?? 200, json: JSON.parse(payload) });
      }
    };
    handleApi(mockReq(method, target, body), res).then((handled) => {
      if (!handled) reject(new Error('route not handled: ' + target));
    }, reject);
  });
}

const V1_MSGS: ParsedMessage[] = [
  {
    canId: 0x100, isExtended: false, name: 'MOTOR', dlc: 8, transmitter: 'MCU',
    signals: [
      { name: 'Speed', mux: 'normal', startBit: 0, bitLength: 16, byteOrder: 'intel', sign: '+', factor: 0.25, offset: 0, minimum: 0, maximum: 16000, unit: 'rpm' },
      { name: 'Ctr', mux: 'normal', startBit: 56, bitLength: 4, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: 0, maximum: 15, unit: null }
    ],
    enumMap: {}
  }
];
const V2_MSGS: ParsedMessage[] = [
  {
    canId: 0x100, isExtended: false, name: 'MOTOR', dlc: 8, transmitter: 'MCU',
    signals: [
      { name: 'Speed', mux: 'normal', startBit: 7, bitLength: 16, byteOrder: 'motorola', sign: '+', factor: 0.125, offset: 0, minimum: 0, maximum: 8000, unit: 'rpm' },
      { name: 'Ctr', mux: 'normal', startBit: 56, bitLength: 4, byteOrder: 'intel', sign: '+', factor: 1, offset: 0, minimum: 0, maximum: 15, unit: null }
    ],
    enumMap: {}
  }
];

function frame(hwTime: number, lo: number, hi: number, gen = 1) {
  return { canId: 0x100, isExtended: false, channel: 1, hwTime, dataHex: `${lo.toString(16).padStart(2, '0')}${hi.toString(16).padStart(2, '0')}000000000000`.toUpperCase(), acquisitionGen: gen };
}

beforeEach(() => { openMemory(); resetDatabase(); });
afterEach(() => clearFrames());

describe('端到端 API', () => {
  it('种子数据：标准/扩展帧分离，mux 未知保留 raw', async () => {
    const seed = await call('POST', '/api/seed');
    expect(seed.json.ok).toBe(true);
    const timeline = await call('GET', '/api/timeline');
    const std = timeline.json.find((r: any) => r.canId === 0x100 && !r.isExtended && r.messageName === 'MOTOR_STATUS');
    const ext = timeline.json.find((r: any) => r.canId === 0x100 && r.isExtended);
    expect(std).toBeTruthy();
    expect(ext.messageName).toBe('DIAG_EXT');
    const mux9 = timeline.json.find((r: any) => r.canId === 0x300 && r.muxValue === 9);
    const detail = await call('GET', `/api/frame?id=${mux9.id}`);
    const v = detail.json.signals.find((s: any) => s.signalName === 'Voltage');
    expect(v.muxUnknown).toBe(true);
    expect(v.physical).toBeNull();
    expect(v.rawBits).toMatch(/^[01]{16}$/);
  });

  it('DBC 修订后仅生效区间内解码改变', async () => {
    await call('POST', '/api/seed');
    const before = (await call('GET', '/api/timeline')).json;
    const early = before.find((r: any) => r.canId === 0x100 && !r.isExtended && r.hwTime === 10000);
    const late = before.find((r: any) => r.canId === 0x100 && !r.isExtended && r.hwTime === 140000);
    expect(early.dbcLabel).toBe('DBC-v1.0');
    expect(late.dbcLabel).toBe('DBC-v2.0');
    const de = await call('GET', `/api/frame?id=${early.id}`);
    const dl = await call('GET', `/api/frame?id=${late.id}`);
    expect(de.json.signals.find((s: any) => s.signalName === 'MotorSpeed').byteOrder).toBe('intel');
    expect(dl.json.signals.find((s: any) => s.signalName === 'MotorSpeed').byteOrder).toBe('motorola');
    // v2 新增信号
    expect(dl.json.signals.some((s: any) => s.signalName === 'BattVoltage')).toBe(true);
    expect(de.json.signals.some((s: any) => s.signalName === 'BattVoltage')).toBe(false);
  });

  it('生效端点精确：t=100000 采用 v2', async () => {
    const v1 = insertDbc({ label: 'EP-A', effectiveFrom: null, effectiveTo: 100000, createdAt: 1 });
    const v2 = insertDbc({ label: 'EP-B', effectiveFrom: 100000, effectiveTo: null, createdAt: 2 });
    insertParsedDbc(v1.id, V1_MSGS);
    insertParsedDbc(v2.id, V2_MSGS);
    insertFrames([frame(99999, 0x64, 0), frame(100000, 0x64, 0)]);
    const rows = replayAll();
    expect(rows[0].dbc!.label).toBe('EP-A');
    expect(rows[1].dbc!.label).toBe('EP-B');
  });

  it('不同导入顺序得到相同解码结果', () => {
    const v1 = insertDbc({ label: 'ORD-A', effectiveFrom: null, effectiveTo: 100, createdAt: 1 });
    insertParsedDbc(v1.id, V1_MSGS);
    const frames = [frame(30, 2, 0, 1), frame(10, 1, 0, 2), frame(20, 0, 0, 1), frame(10, 1, 0, 1)];
    insertFrames(frames);
    const a = JSON.stringify(replayAll().map((d) => ({ t: d.frame.hwTime, g: d.frame.acquisitionGen, id: d.frame.id, raw: d.signals.find((s) => s.signalName === 'Speed')?.raw })));
    clearFrames();
    insertFrames([...frames].reverse());
    const b = JSON.stringify(replayAll().map((d) => ({ t: d.frame.hwTime, g: d.frame.acquisitionGen, id: d.frame.id, raw: d.signals.find((s) => s.signalName === 'Speed')?.raw })));
    // 帧 id 自增、值序列一致即顺序无关（排序键是 hw_time + id，不依赖 import_seq）
    const va = JSON.parse(a).map((x: any) => [x.t, x.g, x.raw]);
    const vb = JSON.parse(b).map((x: any) => [x.t, x.g, x.raw]);
    expect(va).toEqual(vb);
    expect(va).toEqual([[10, 1, 1], [10, 2, 1], [20, 1, 0], [30, 1, 2]]);
  });

  it('并发审批基于版本号冲突', async () => {
    const v1 = insertDbc({ label: 'MIG-A', effectiveFrom: null, effectiveTo: null, createdAt: 1 });
    const v2 = insertDbc({ label: 'MIG-B', effectiveFrom: null, effectiveTo: null, createdAt: 2 });
    insertParsedDbc(v1.id, V1_MSGS);
    insertParsedDbc(v2.id, V2_MSGS);
    await call('GET', `/api/compare?from=${v1.id}&to=${v2.id}`);
    const m = listMigrations(v1.id, v2.id)[0];
    expect(updateMigrationStatus(m.id, 'approved', m.lockVersion).ok).toBe(true);
    const stale = updateMigrationStatus(m.id, 'incompatible', m.lockVersion);
    expect(stale.ok).toBe(false);
    expect(stale.currentLock).toBe(m.lockVersion + 1);
    // API 409
    const res = await call('POST', '/api/migration-approve', { id: m.id, status: 'incompatible', lockVersion: m.lockVersion });
    expect(res.code).toBe(409);
    expect(res.json.error).toBe('version-conflict');
  });

  it('快照冻结旧定义，之后修订 DBC 不影响快照', async () => {
    await call('POST', '/api/seed');
    const created = await call('POST', '/api/snapshot', { label: 'freeze' });
    const before: any = (await call('GET', `/api/snapshot?id=${created.json.id}`)).json;
    expect(before.frames.length).toBeGreaterThan(0);
    // 修改 v1 定义（替换其消息）：实时解码变化，快照不变
    const state = await call('GET', '/api/state');
    const v1 = state.json.dbcs[0];
    // 直接更新数据库中的系数
    const { db } = await import('../server/db.js');
    const msg = getMessages(v1.id).find((m) => m.name === 'MOTOR_STATUS')!;
    db().prepare('UPDATE signals SET factor = 99 WHERE message_id = ? AND name = ?').run(msg.id, 'MotorSpeed');
    const after: any = (await call('GET', `/api/snapshot?id=${created.json.id}`)).json;
    expect(after.frames[0]).toEqual(before.frames[0]);
    const live = replayAll()[0];
    const liveSpeed = live.signals.find((s: any) => s.signalName === 'MotorSpeed');
    if (liveSpeed) expect(liveSpeed.factor).toBe(99);
  });

  it('用旧 DBC 重放时仅生效区间外的帧标记为过期', async () => {
    await call('POST', '/api/seed');
    const state = await call('GET', '/api/state');
    const v1 = state.json.dbcs[0].id;
    const rows = await call('GET', `/api/replay-with?dbcId=${v1}`);
    const staleRows = rows.json.filter((r: any) => r.stale);
    expect(staleRows.length).toBeGreaterThan(0);
    expect(staleRows.every((r: any) => r.hwTime >= 100000)).toBe(true);
    expect(rows.json.filter((r: any) => !r.stale && r.hwTime < 100000).length).toBeGreaterThan(0);
  });

  it('CRC 配置不完整时全部未核验', async () => {
    await call('POST', '/api/seed');
    await call('POST', '/api/crc', { messageName: 'MOTOR_STATUS', signalName: 'Crc8', coverage: [], init: 255, xorOut: 0, dbcId: null });
    const reports = await call('GET', '/api/crc');
    const r = reports.json.find((x: any) => x.messageName === 'MOTOR_STATUS');
    expect(r.configured).toBe(false);
    expect(r.evidences.every((e: any) => e.status === 'unchecked')).toBe(true);
  });

  it('计数器按代次检查出重复与缺帧', async () => {
    await call('POST', '/api/seed');
    const reports = await call('GET', '/api/counters');
    const r = reports.json[0];
    expect(r.node).toBe('MCU');
    expect(r.groups.length).toBe(2);
    expect(r.events.some((e: any) => e.kind === 'duplicate')).toBe(true);
    expect(r.events.some((e: any) => e.kind === 'missing')).toBe(true);
  });
});
