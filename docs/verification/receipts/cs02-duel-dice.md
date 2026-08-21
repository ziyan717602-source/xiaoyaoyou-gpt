# CS02 / JN20102 不屈不挠、JN30601 决斗、JN30602 手下留情验证收据

日期：2026-08-21
状态：pass

## 规则证据

- SQLite：`JN20102 OCCURS=G0TT`，描述为本人骰点不满意时弃一张手牌重投；`JN30601 OCCURS=R#GR`，描述为递增支付、一至两名目标、逐目标对抗骰与低点三伤/平点双方两伤；`JN30602 OCCURS=!G0OH`，描述为决斗参与者在两点或以上 HP 时至少保留一点。
- `PSDGamepkg/JNS/XJ405.cs:390-414`：只允许当前原生王小虎掷骰者从本人手牌支付一张，支付后再次发出 `G0TT`，所以可在每个新结果后重复选择。
- `PSDGamepkg/JNS/XJ405.cs:881-924`：支付量为此前 `DuelCount + 1`，保留一至两个目标的输入顺序；每名目标均重新执行重楼骰、目标骰，并在该目标的 `Harm` 完成后才处理下一目标。
- `PSDGamepkg/XIG.cs:1352-1363`：普通伤害先封顶到当前 HP；`ALIVE` 在伤害等于当前 HP 时改为 `max(1, HP - 1)`，因此 HP 二或以上保留一，而 HP 一仍承受一并可能死亡。

## 已验证边界

- 只有原生 XJ306 在自己的行动阶段获得 JN30601。第 N 次发动要求恰好 N 张互异的本人当前手牌，并要求一至两名互异、其他、存活目标；本回合次数序列化保存，新回合自动重置。
- 每个自动骰点恰好消费一次 `sha256-counter-v1`。事件核对 d6 选项集合哈希、RNG 游标起止、结果、掷骰者、目标序号与尝试序号；伪造骰点、游标、支付、目标或派生伤害全部被 reducer 拒绝。
- 原生 XJ201 当前掷骰者在有手牌时收到 owner-only 的 JN20102 可选选择。支付一张当前手牌后先弃牌再重投，并可重复；手动空提交、15 秒超时和断联自动决策均接受当前骰点且不支付。
- 六份玩家视图共享公开骰点和等待状态；只有当前王小虎掷骰者看到本人的可支付牌实例、选择与动作。其他五席无法从事件、选择或动作集合推断牌 ID。
- 每个目标严格执行“重楼骰、目标骰、该目标完整伤害/响应/濒死、再到下一目标”。重楼高、目标高和平点分别派生目标三伤、重楼三伤、目标后重楼各二伤；伤害稳定前序列化续算位置不会前进。
- 决斗伤害携带 `TUX_INAVO | ALIVE | RSV_DUEL`。TP03 不会误投影；合法 FJ05 仍可响应。ALIVE 在实际伤害时应用，覆盖 HP 二保留一与 HP 一进入救援、死亡的不同结果。
- JSON 回放跨两个私有选择逐事件得到相同状态和 RNG 游标。六个真实 WebSocket 在第一名与第二名王小虎各自的私有重投等待中重启 SQLite，并验证最终骰点、手牌隐私、HP、次数和续算状态一致。

## 验证命令

- `npm exec vitest run packages/engine/src/duel.test.ts`
- `npm exec vitest run packages/engine/src/duel.replay.test.ts`
- `npm exec vitest run --config vitest.integration.config.ts tests/integration/damage-dying-lifecycle.integration.test.ts -t "restarts both private JN20102"`
- `npm run test:unit`
- `npm run test:replay`
- `npm run test:integration`
- `npm run test:bots`
- `npm run check:fast`
- `npm run check:full`
- `npm run goal:preflight`

## 完整门禁矩阵

- 单元测试：100/100。
- 事件重放：41/41。
- Bot 长程模拟：6/6，其中回合、超时恢复和伤害能力 Bot 各连续完成至少 1,000 回合。
- 六连接真实网络集成：18/18。
- Chromium 端到端：3/3，覆盖六个隔离 BrowserContext、五 Bot 房间旅程和移动端关键控件。
- 本地服务冒烟：6 个客户端，健康检查与根页面均通过。

## 内容状态

- `xyy.skill.jn30601`：verified。
- `xyy.skill.jn30602`：verified。
- `xyy.hero.xj306`：partial；JN30601/JN30602 已验证，战牌阶段 JN30603 等待 CS03。
- `xyy.skill.jn20102`：partial；JN30601 的所有可达骰点已验证，未来 CS03 骰点生产者必须复用同一重投门。
- `xyy.hero.xj201`：partial；JN20102 当前边界已验证，JN20101 与未来骰点生产者仍待迁移。
