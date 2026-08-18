# P08 可观测性与脱敏契约

## 结构化日志

Fastify/Pino 输出 JSON。一次请求或连接可使用：`requestId`、`connectionId`、`matchId`、`commandId`、`eventId`、`effectId`、`windowId` 和不含昵称的 `playerRef`。错误记录稳定代码和 stack；不记录整个请求、命令、状态或玩家视图。

绝对禁止：Authorization/reconnect token、原始邀请码、昵称、IP 的长期明文、RNG seed、牌堆顺序、任意手牌 ID、私有选项、`availableActions` 全量和 `player-view`。Pino `redact` 是第二道保护，调用者仍不得把这些对象传给 logger。

日志事件基线：

- `connection-open/authenticated/closed`；
- `command-received/accepted/rejected/duplicate`；
- `actor-queue-delay/command-duration`；
- `snapshot-written/recovery-complete/recovery-refused`；
- `deadline-scheduled/timeout-enqueued`；
- `server-draining`。

## 指标

`prom-client` 采集 Node 默认指标，并定义：

- `xiaoyaoyou_ws_connections{state}`；
- `xiaoyaoyou_actor_queue_depth`；
- `xiaoyaoyou_command_total{type,outcome}`；
- `xiaoyaoyou_command_duration_seconds{type}`；
- `xiaoyaoyou_persistence_transaction_seconds{outcome}`；
- `xiaoyaoyou_recovery_total{outcome}`；
- `xiaoyaoyou_timeout_total{fallback}`；
- `xiaoyaoyou_snapshot_age_seconds`。

指标 label 禁止 `matchId/playerId/commandId/eventId/effectId/cardId` 和昵称，避免隐私泄漏与高基数。生产 `/metrics` 只允许内网/运维认证访问；当前本地开放仅用于开发。

## 诊断关联

日志保留关联 ID，事件库保留 causation ID；二者靠 ID 关联，绝不靠复制私密 payload。用户可见错误只返回随机 `requestId` 供定位，不返回堆栈或数据库信息。
