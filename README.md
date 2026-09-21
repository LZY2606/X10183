# 总线刻度（Bus Scale）

按采集时点重放 CAN trace、并以版本化 DBC 定义解释信号的全栈工具。纯 TypeScript + Node.js + SQLite（Node 24 内置 `node:sqlite`）+ Vite，不连接车辆或任何外部消息系统。

## 安装与运行

```bash
npm install
npm test -- --run
npm run dev -- --host 127.0.0.1 --port 5243 --strictPort
```

打开 http://127.0.0.1:5243 ，页面标题与顶部均显示“总线刻度”。首次启动会自动写入演示数据（两版 DBC、跨版本帧、mux、扩展帧、计数器与 CRC 场景）。

## 领域模型

- **原始帧** `frames`：arbitration id、标准/扩展标志、通道、硬件时间、数据负载、采集代次、导入序号。帧按 `(hw_time, acquisition_gen, channel, id)` 稳定排序——解码结果与导入顺序无关。
- **DBC 版本** `dbc_versions` + `messages` + `signals`：带半开生效区间 `[effectiveFrom, effectiveTo)`；同一时刻按创建时间取最新覆盖版本。同一 arbitration id 的标准帧与扩展帧是不同消息。
- **规则**：`counter_rules`（节点+信号，可选最大值）、`crc_rules`（覆盖位段、初值、异或值）。
- **快照** `snapshots`：冻结调查时的完整解码 JSON，之后 DBC 修订不影响它。
- **迁移映射** `migrations`：两版 DBC 对同一 id 的布局差异与审批状态，`lock_version` 实现乐观并发。

## 解码与证据

- 支持 **Intel（@1，小端，LSB 起始）** 与 **Motorola（@0，DBC 锯齿位序，MSB 起始）**，跨字节有符号值做符号扩展。
- 每个解码信号都带：字节序、DBC 起始位号、位长度、确切 bit 区间（如 `0.0-0.7`、`2.7-2.0`）、MSB→LSB 位串、无符号/有符号 raw、`raw×factor+offset` 的物理值、单位与枚举。
- **多路复用**：先解 switch，仅匹配 mux 值的分支被解释；分支未知时保留 raw bits 与位区间，不产生数字。
- **过期**：`/api/replay-with?dbcId=` 用旧版本重放，凡当前生效版本已不同的帧标记 `stale`；实时时间轴始终采用当前生效定义，冻结快照继续指向旧定义。

## 计数器与 CRC

- 计数器按**节点 + 采集代次**分组，报告重复（含重复时间戳）、缺帧（含丢失数）与环绕（15→0 仅提示，不算错误）。
- CRC 为 8-bit 逐位反馈（多项式 0x07）+ 末尾 XOR，覆盖范围按线性位号段配置。覆盖、初值、异或值任一缺失时，每一帧都返回 `unchecked`（“未核验”），绝不报通过。

## 页面

帧时间轴（SVG 泳道 + 帧表）→ 点击帧查看定义来源与可交互 bit 布局/证据链；信号曲线（raw/物理值、枚举）；计数器缺口；CRC 证据；DBC 版本比较（差异、批准映射/标记不兼容、乐观锁冲突 409、过期重放）；trace 与 DBC 导入；调查快照。

## API 摘要

`GET /api/state` · `POST /api/seed` · `POST /api/trace-import` · `POST /api/frames` ·
`GET /api/timeline` · `GET /api/frame?id=` · `GET /api/signal-series` ·
`GET|POST /api/counters` · `GET|POST /api/crc` · `POST /api/dbc` · `GET /api/dbc-messages` ·
`GET /api/compare?from=&to=` · `POST /api/migration-approve` ·
`GET /api/replay-with?dbcId=` · `GET|POST /api/snapshot`

## 测试

`npm test -- --run`（32 个用例）覆盖 Intel/Motorola 排列、跨字节有符号值、计数器环绕/重复/缺帧/重复时间戳、标准与扩展 id、mux 未知保留 raw、CRC 覆盖边界与不完整配置“未核验”、DBC 生效端点、导入顺序无关性、快照冻结与并发审批版本冲突。
