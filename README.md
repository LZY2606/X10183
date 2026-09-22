# 总线刻度 · CAN trace × 版本化 DBC 重放

按采集时点重放 CAN trace，并用带生效区间的 DBC 版本解释每个信号。解码值可追溯到确切 bit
区间；支持计数器缺口检查、CRC 证据、多路复用未知分支保留 raw bits、DBC 版本比较与迁移审批。
不连接车辆或任何外部消息系统。

## 技术栈

- TypeScript + Node.js
- SQLite（`better-sqlite3`，同步事务，WAL）
- Vite 6（开发服务器中间件挂载同源 `/api`，前端为零框架 TypeScript SPA）
- Vitest（27 个测试）

## 安装与运行

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5243 --strictPort
```

打开 http://127.0.0.1:5243 ，页面标题为“总线刻度”。首次使用可在“导入”页点击
“载入演示数据”，一键获得两版 DBC（Intel v1 / Motorola v2，`[0,10)` 与 `[10,+∞)`）、
两个采集代次、计数器环绕/重复/缺帧、CRC 通过/失败、未知 mux 分支与扩展帧。

## 数据模型

- `frames`：原始帧（通道、arbitration id、标准/扩展标记、硬件时间、data）、`import_gen` 采集代次。
- `dbc_versions`：不可变版本 + 半开生效区间 `[effective_from, effective_to)` + 乐观版本号。
- `message_defs / signal_defs / value_descs`：消息、信号（起点位/长度/字节序/有符号/缩放/偏置/单位/mux）与枚举。
- `rule_counters / rule_checksums`：计数器与 CRC 规则，绑定到具体 DBC 版本。
- `decode_cache`：解码缓存，DBC 区间修订后仅受影响帧被置 `stale`。
- `snapshots`：冻结调查快照，保存逐帧完整解码，修订后仍指向旧定义。
- `migrations`：版本间迁移映射，`version` 字段实现并发审批冲突检测。

## 关键语义

- **确定性重放**：按 `(hw_time, channel, arb_id, extended, data, id)` 排序，导入顺序不影响结果。
- **标准/扩展帧分开**：同一 arbitration id 的 11bit 与 29bit 帧是不同消息。
- **bit 定位**：统一线性网格（byte b 的 MSB=`8b` … LSB=`8b+7`，与 cantools 基准一致），
  Intel/Motorola 均生成 MSB→LSB 的绝对 bit 单元序列，`raw bits` 与该区间一一对应。
- **多路复用**：开关值无任何已知分支时，从属信号 `active=false、reason=unknown-mux`，
  只保留 raw bits 与物理位置，不产出物理值。
- **CRC**：覆盖 byte 范围（含端点、排除校验字节自身）、初值、xorIn/xorOut 可配；
  配置缺失、越界或信号未解码时一律 `unchecked`，绝不报通过。
- **生效端点**：区间半开，`t==to` 归属下一版；多版本同时生效时跨版本查找消息定义。
- **并发审批**：提交须携带 `expectedVersion`，不匹配返回 409 `VERSION_CONFLICT`。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/trace/import` | 导入 JSON/CSV/ASC trace |
| POST | `/api/dbc` / PATCH `/api/dbc/:id` | 创建版本 / 修订生效区间（带 expectedVersion） |
| GET | `/api/timeline` / `/api/frames/:id/decode` | 按时点重放 / 单帧解码 |
| GET | `/api/decode-with/:dbcId` | 用指定版本解码全部帧 |
| GET | `/api/counters` / `/api/checksums` | 计数器事件 / CRC 证据 |
| GET | `/api/compare?from&to` | 两版 DBC 逐消息逐信号差异 |
| POST | `/api/migrations` / `.../:id/decision` | 迁移映射 / 批准或标记不兼容 |
| POST/GET | `/api/snapshots` | 冻结/查看调查快照 |
| POST | `/api/seed` | 空仓库载入演示数据 |

## 测试覆盖

`npm test -- --run` 覆盖：Intel/Motorola 排列（cantools 基准）、跨字节有符号值、
计数器环绕/重复/缺帧/重复时间戳、标准与扩展 ID、mux 未知分支保留 raw bits、
CRC 覆盖边界与“不完整即未核验”、DBC 生效半开端点、快照冻结旧定义、迁移审批版本号冲突、
以及不同导入顺序下结果一致。
