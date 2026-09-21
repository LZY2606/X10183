import type { DatabaseSync } from "node:sqlite";
import { computeCrc8 } from "../core/crc.js";
import { importDbc, importTrace } from "./service.js";

/** 生成 v1 DBC：标准帧 0x100（发动机状态，Intel）、0x200（mux）；扩展帧 0x18FEF100。 */
export const DBC_V1 = `VERSION "powertrain-v1"
// @busscale name "powertrain-v1"
// @busscale version 1
// @busscale effective 2024-01-01T00:00:00Z .. 2024-07-01T00:00:00Z

BO_ 256 EngineData: 8 EMS
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" EMS
 SG_ EngineTemp : 16|16@1- (0.1,-40) [-40|215.5] "degC" EMS
 SG_ EngineState : 32|2@1+ (1,0) [0|3] "" EMS
 SG_ Counter : 34|4@1+ (1,0) [0|15] "" EMS
 SG_ Crc8 : 56|8@1+ (1,0) [0|255] "" EMS

BO_ 512 BodyMux: 8 BCM
 SG_ SvcId M : 0|4@1+ (1,0) [0|15] "" BCM
 SG_ WindowPos m0 : 8|8@1+ (1,0) [0|100] "%" BCM
 SG_ DoorCount m1 : 8|4@1+ (1,0) [0|15] "" BCM

BO_ 419358464x ExtDiag: 8 GATEWAY
 SG_ DiagRpm : 7|16@0+ (0.25,0) [0|16383.75] "rpm" GATEWAY

VAL_ 256 EngineState 0 "Off" 1 "Idle" 2 "Run" 3 "Fault" ;
`;

export const DBC_V2 = `VERSION "powertrain-v2"
// @busscale name "powertrain-v2"
// @busscale version 2
// @busscale effective 2024-07-01T00:00:00Z ..
// 修订：EngineSpeed 起始位移到字节 2（破坏性布局变更）；新增 Torque；Crc8 移到字节 7 旧位
// 标准/扩展仍然分立

BO_ 256 EngineData: 8 EMS
 SG_ EngineSpeed : 16|16@1+ (0.25,0) [0|16383.75] "rpm" EMS
 SG_ EngineTemp : 0|16@1- (0.1,-40) [-40|215.5] "degC" EMS
 SG_ EngineState : 32|2@1+ (1,0) [0|3] "" EMS
 SG_ Counter : 34|4@1+ (1,0) [0|15] "" EMS
 SG_ Torque : 40|8@1+ (0.5,0) [0|127.5] "Nm" EMS
 SG_ Crc8 : 56|8@1+ (1,0) [0|255] "" EMS

BO_ 512 BodyMux: 8 BCM
 SG_ SvcId M : 0|4@1+ (1,0) [0|15] "" BCM
 SG_ WindowPos m0 : 8|8@1+ (1,0) [0|100] "%" BCM
 SG_ DoorCount m1 : 8|4@1+ (1,0) [0|15] "" BCM
 SG_ LightLevel m2 : 8|4@1+ (1,0) [0|15] "" BCM

BO_ 419358464x ExtDiag: 8 GATEWAY
 SG_ DiagRpm : 7|16@0+ (0.25,0) [0|16383.75] "rpm" GATEWAY

VAL_ 256 EngineState 0 "Off" 1 "Idle" 2 "Run" 3 "Fault" ;
`;

function ns(iso: string): bigint {
  return BigInt(Date.parse(iso)) * 1_000_000n;
}

function buildEngineFrame(counter: number, rpmRaw: number, tempRaw: number, state: number, torqueRaw: number | null, ts: string): string {
  const data = Buffer.alloc(8);
  if (torqueRaw === null) {
    // v1 布局
    data.writeUInt16LE(rpmRaw, 0);
    data.writeInt16LE(tempRaw, 2);
  } else {
    // v2 布局
    data.writeInt16LE(tempRaw, 0);
    data.writeUInt16LE(rpmRaw, 2);
    data.writeUInt8(torqueRaw, 5);
  }
  data[4] = (state & 0x3) | ((counter & 0xf) << 2);
  const covered = Buffer.concat([data.subarray(0, 7)]);
  const crc = computeCrc8(covered, { polynomial: 0x07, init: 0x00, xorOut: 0x00, reflectInput: false, reflectOutput: false });
  data.writeUInt8(crc, 7);
  const sec = Number(ns(ts) / 1_000_000_000n);
  return `(${sec}.000000000) can0  100#${data.toString("hex").toUpperCase()}`;
}

function buildMuxFrame(svc: number, payload: number, ts: string): string {
  const data = Buffer.alloc(8);
  data[0] = svc & 0xf;
  data[1] = payload;
  const sec = Number(ns(ts) / 1_000_000_000n);
  return `(${sec}.000000000) can0  200#${data.toString("hex").toUpperCase()}`;
}

function buildExtFrame(rpmRaw: number, ts: string): string {
  // Motorola @0 start 7 len16: bits dbc 7..0,15..8 → MSB=byte0 bit7
  const msb = rpmRaw >> 8;
  const lsb = rpmRaw & 0xff;
  const data = Buffer.alloc(8);
  data[0] = msb;
  data[1] = lsb;
  const sec = Number(ns(ts) / 1_000_000_000n);
  return `(${sec}.000000000) can0  18FEF100##0${data.toString("hex").toUpperCase()}`;
}

export function seedDatabase(db: DatabaseSync): void {
  importDbc(db, DBC_V1, {});
  importDbc(db, DBC_V2, {});

  // 两个采集代次：gen-a 在 v1 区间
  const lines: string[] = [];
  // 计数器序列：0,1,2,3,4,6(缺帧),14,15,0(环绕)；另加一条重复时间戳
  const counterSeq = [0, 1, 2, 3, 4, 6, 14, 15, 0];
  counterSeq.forEach((c, i) => {
    const iso = `2024-03-01T00:00:0${i}Z`;
    const rpmRaw = 2400 + i * 40;
    const tempRaw = 500 + i * 10; // 0.1/-40 → 10.0+i degC
    lines.push(buildEngineFrame(c, rpmRaw, tempRaw, i % 4, null, iso));
  });
  // 重复时间戳：与序列最后一帧同一硬件时间（计数器值也重复 → 同时产生重复计数事件）
  lines.push(buildEngineFrame(0, 3000, 600, 2, null, "2024-03-01T00:00:08Z"));
  // mux：已知分支 0、1，未知分支 9
  lines.push(buildMuxFrame(0, 75, "2024-03-02T00:00:00Z"));
  lines.push(buildMuxFrame(1, 4, "2024-03-02T00:00:01Z"));
  lines.push(buildMuxFrame(9, 0xab, "2024-03-02T00:00:02Z"));
  // 扩展帧
  lines.push(buildExtFrame(0x1234, "2024-03-02T00:00:03Z"));
  // 标准帧 0x7FF 在任何版本都无定义
  lines.push(`(${Number(ns("2024-03-02T00:00:04Z")) / 1e9}.000000000) can0  7FF#DEADBEEF`);

  importTrace(db, lines.join("\n"), { label: "路试代次 A（2024-03）", generation: "gen-a" });

  // gen-b：v2 区间
  const linesB: string[] = [];
  for (let i = 0; i < 6; i++) {
    const iso = `2024-08-01T00:00:0${i}Z`;
    const c = i & 0xf;
    linesB.push(buildEngineFrame(c, 2600 + i * 40, 520 + i * 10, 2, 40 + i, iso));
  }
  // 一条重复计数（i=5 后再发 c=5）
  linesB.push(buildEngineFrame(5, 2600, 520, 2, 45, "2024-08-01T00:00:06Z"));
  linesB.push(buildMuxFrame(2, 7, "2024-08-02T00:00:00Z"));
  linesB.push(buildExtFrame(0x2000, "2024-08-02T00:00:01Z"));
  importTrace(db, linesB.join("\n"), { label: "路试代次 B（2024-08）", generation: "gen-b" });

  // 规则：计数器
  db.prepare(
    `INSERT INTO counter_rule(channel, arbitration_id, extended, signal_name, bits, factor, increment, node_name)
     VALUES (NULL, 256, 0, 'Counter', 4, 1, 1, 'EMS')`
  ).run();

  // CRC 规则：完整配置
  db.prepare(
    `INSERT INTO crc_rule(channel, arbitration_id, extended, signal_name, width_bits,
       start_byte, length_bytes, polynomial, init_value, xor_out, reflect_input, reflect_output)
     VALUES (NULL, 256, 0, 'Crc8', 8, 0, 7, 7, 0, 0, 0, 0)`
  ).run();
  // 不完整 CRC 规则（扩展帧）：缺初值/异或 → 只能未核验
  db.prepare(
    `INSERT INTO crc_rule(channel, arbitration_id, extended, signal_name, width_bits,
       start_byte, length_bytes, polynomial, init_value, xor_out, reflect_input, reflect_output)
     VALUES (NULL, 419358464, 1, 'DiagRpm', 8, 0, 2, 7, NULL, NULL, 0, 0)`
  ).run();
}
