# ADR-0005：每局 Actor、线路协议与恢复契约

- 状态：P08 接受
- 日期：2026-08-19

## 决策

每个活跃对局由恰好一个进程内 `MatchActor` 拥有。命令进入单 FIFO Promise lane；引擎执行和 SQLite 原子提交完成后才处理下一条。规则层不加锁，也不并行修改同一 `MatchState`。

引擎边界固定为：

```text
applyCommand(state, command) -> accepted(state, events) | rejected(reason, version)
resume(state) -> resolved | pending-choice | reaction-window | game-over
projectPlayerView(state, playerId) -> PlayerView
reduceEvent(state, event) -> state
```

四个操作必须纯确定性；时间只作为系统命令数据进入。Actor 定时器只按持久化的绝对 `deadlineAt` 入队确定的超时命令 ID。重复调度依靠命令收据去重。

## WebSocket

1. 服务端发送 `hello`，包含唯一 `connectionId`、协议版本、心跳和认证时限。
2. 浏览器须在 5 秒内发送 `authenticate`。重连令牌放在首帧正文，禁止 URL/query string。
3. 认证后发送 `authenticated` 和当前私有 `player-view`；不提供观战身份。
4. 命令携带 `commandId`、`clientSequence`、`expectedVersion`。连接座位必须和包络一致。
5. 重复 `matchId + commandId` 返回原收据；不追加事件。版本、序列、窗口和可用动作依次校验。
6. v1 只接受精确协议版本；不假装兼容未知版本。

固定关闭码：`4401` 认证失败、`4406` 协议不支持、`4408` 认证超时、`1012` 服务重启。服务停止先广播 `server-draining`，再关闭连接。

## 持久化与停止

单个已接受命令的领域事件、幂等收据、对局版本和可选快照在一个事务中提交。事件序列逐局严格递增，并以前一事件哈希组成 SHA-256 链。

每 25 条已接受命令保存快照；进入玩家等待点、对局结束和优雅停止时也保存。恢复只接受已知 `persistenceVersion`，加载最新快照后按序 reduce 后续事件。未知新版本拒绝启动并原样保留文件。

停止顺序固定为：拒绝新命令 → 排空 Actor 队列 → 保存最终快照 → 取消定时器 → 关闭 WebSocket/数据库。强制终止仍依赖最近已提交事务恢复。

## 重新评估

- 一旦多实例运行，每局所有权必须改为可证明的租约/分片，不能让两个 Actor 同时拥有一局。
- 一旦协议同时支持多个线上版本，新增显式兼容矩阵和降级测试。
- 若一条规则命令长期阻塞事件循环，先测量并拆分纯计算/worker；不得并行执行同局命令。
