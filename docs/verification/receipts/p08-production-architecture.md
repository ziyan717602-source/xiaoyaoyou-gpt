# P08 生产架构冻结收据

日期：2026-08-19

状态：pass

## 冻结结果

- 接入层：Fastify 5 + `@fastify/websocket` 11；64 KiB 帧上限、禁压缩、5 秒首帧认证和优雅关闭。
- Schema：`packages/protocol` 拥有 JSON Schema + Ajv 8 运行时校验；协议 v1 精确协商。
- 引擎：`applyCommand`、`resume`、`projectPlayerView`、`reduceEvent` 纯确定性端口已固定。
- 并发：每局一个 `MatchActor`、单 FIFO Promise lane；绝对期限只入队幂等系统命令。
- 持久化：`better-sqlite3` 13，WAL + FULL；事件、收据、版本和可选快照同一事务；事件哈希链与快照双锚校验。
- 恢复：每 25 条已接受命令、玩家等待点、结束和优雅停止保存快照；显式向前迁移，拒绝未知新版本。
- 安全：威胁模型覆盖座位冒用、越权/重放、隐私窥探、CSWSH、DoS、日志和事件篡改；无观战入口。
- 可观测性：Pino 关联 ID/脱敏红线和 Prometheus 低基数指标已定义。
- 本地环境：`npm run dev:local` 构建并启动 Fastify、SQLite、当前 Web 页面和六个真实 WebSocket 验证 Bot，无云资源或手工秘密。

## 选型证据

Fastify v5 官方要求 Node 20+ 并以完整 JSON Schema/Ajv 与 Pino 为核心能力；官方 WebSocket 插件复用连接前 hooks 和关闭生命周期。Node 22 官方仍把 `node:sqlite` 标为 Active development/Experimental，因此生产驱动选择支持 Node 22 预编译和同步事务的 `better-sqlite3`。具体依据和被拒绝方案见 ADR-0004/0005。

## 自动证据

```powershell
npm run architecture:verify
npm run architecture:smoke
npm run check:fast
npm run check:full
npm audit --audit-level=moderate
```

最终结果：

- 架构契约 9/9；架构单元/事务测试 9/9；
- 本地烟测 6/6 WebSocket 认证并收到相互隔离的私有投影，HTTP health 和 Web 入口为 200；
- 旧轨迹、属性、10,000 回合 Bot、真实网络、3 条 Playwright、构建全部通过；
- npm audit 0 vulnerability。

一次非产品失败已留痕：准备回归时把 `--log-level warn` 错传给 `npm run format`，Prettier 将 `warn` 当作文件模式并退出；随后使用正式 `format:check` 命令通过，未修改测试或放宽断言。

## 明确不声称

P08 本地六人是标明用途的架构 fixture，不是 M01 建房/入座实现，也不能进行真实整局。Origin allowlist、连接/消息限流、随机 token 哈希存储和队列上限已被冻结为 M01 开放入口前的硬控制。P07 的旧集成测试仍使用实验性 `node:sqlite` 作为独立测试夹具；产品代码只使用 `better-sqlite3`。
