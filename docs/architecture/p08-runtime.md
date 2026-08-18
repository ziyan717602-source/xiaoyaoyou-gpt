# P08 生产架构冻结

本文件是 `contracts/architecture.contract.json` 的可读说明。P08 冻结基础设施和边界，不声称 M01 房间或真实卡牌已经实现。

## 请求到状态的唯一通路

```text
Fastify HTTP/WS
  -> Ajv 包络校验
  -> 首帧座位认证与限流
  -> MatchActor 单队列
  -> engine.applyCommand / resume
  -> SQLite 单事务：events + receipt + version + optional snapshot
  -> engine.projectPlayerView（逐接收者重新生成）
  -> 私有 player-view
```

客户端输入不能直接调用卡牌处理器。服务端只接受 Schema 已知的包络；Actor 只接受已认证座位；引擎只接受领域命令。客户端界面只渲染投影中的 `availableActions`。

## 错误契约

传输错误类别固定为 `invalid`、`unauthenticated`、`forbidden`、`conflict`、`expired`、`rate-limited`、`unavailable`、`internal`。命令拒绝理由固定为 `invalid`、`forbidden`、`stale-version`、`stale-sequence`、`expired-window`、`not-available`、`match-finished`。

错误只包含类别、稳定代码、是否可重试和公开版本；不能包含候选卡、手牌、响应资格或“哪个秘密条件失败”。对未授权猜测保持相同结构、消息数和近似时序。

## 数据职责

- `packages/protocol`：线路 Schema、稳定 ID、协议版本和公共错误；不含规则。
- `packages/engine`：纯状态、领域事件、`applyCommand/resume/reduceEvent/projectPlayerView`；不含 I/O。
- `apps/server`：Actor、认证、真实时间、定时器、持久化、投影分发、日志和指标。
- `apps/web`：显示玩家投影并发送命令；不预测合法性或结果。

SQLite 是当前本地 MVP 和首次单实例云运行的明确选择，不是“以后自动横向扩容”的承诺。超过单实例前必须按 ADR-0004 迁移所有权与数据库。
