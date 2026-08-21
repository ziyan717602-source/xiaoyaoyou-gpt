# CS03-01 确定性遭遇牌堆验证收据

日期：2026-08-21
状态：pass

## 证据与决定

- `PSDGamepkg/XI.cs:149-173`：全部 20 怪物与洗牌后的前 10 NPC 组成并再次洗成 30 张主遭遇堆。
- `PSDGamepkg/XI.cs:182-189`、`PSDBase/Utils/Algo.cs:91-108`：旧后备 NPC 从零基索引 11 开始，随机漏掉索引 10；完整最小证据、备选语义和影响记录在 `docs/rules-semantics/cs03-encounter-deck-gap.md`。
- `SEM-009` 临时采用实体守恒修正：随机前 10 NPC 进入主堆，剩余全部 16 NPC 进入后备堆。
- `PSDBase/Board.cs:100-112,378-385`：主堆/弃牌和后备区独立保存；对玩家公开主牌堆/弃牌数量而不公开未揭示身份。

## 已验证边界

- 目录 20 怪物、26 NPC、9 NPC 行动与合同逐项计数一致；主堆固定为 20 怪物 + 10 NPC，后备固定 16 NPC，四区合计 46 个唯一内容实体。
- 同种子完整顺序一致，不同种子分歧；洗牌使用域分离 `sha256-counter-v1`，不改变现有比赛 RNG 游标。
- MatchState schema v7 要求保存主堆、主弃牌、后备 NPC 堆和后备弃牌。v6→v7 迁移按原秘密种子确定性补齐区域，JSON 往返一致。
- 六份视图只公开 `{ deckCount, discardPile }`；主堆顺序、十名随机 NPC 成员和后备身份不出现在任何玩家 JSON。
- 六个真实 WebSocket 在选角中途和进入下一回合后分别经过 SQLite 服务重启，主堆数量保持 30，未揭示的 46 个内容 ID 均不泄漏。
- 本节点不实现揭示、战斗或 NPC 行动，因此 55 个 CS03 内容项仍为 unstarted。

## 验证命令

- `npm run encounter-deck:verify`
- `npm run semantics:verify`
- `npm run time:contract`
- `npm run check:fast`
- `npm run test:replay`
- `npm run test:bots`
- `npm run test:integration`
- `npm run check:full`
- `npm run goal:preflight`

## 完整门禁矩阵

- 单元测试：103/103 通过，其中遭遇牌堆专项 3/3 通过。
- 事件重放：41/41 通过，schema v7 状态保持确定性重放。
- Bot 长程模拟：6/6 通过，包含 1,000 回合长程模拟。
- 六连接真实网络集成：18/18 通过；选角中途与下一回合后的 SQLite 重启均保持遭遇牌堆状态和玩家视图隐私。
- Chromium 端到端：3/3 通过，覆盖 1366×768 与 360×800。
- 本地服务冒烟：6 个客户端连接通过。
