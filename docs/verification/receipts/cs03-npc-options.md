# CS03-03B-02-OPTIONS 验证收据

日期：2026-08-28

状态：pass。证明实际 NPC 行动窗口、合法选择/放弃/强制超时、九个处理器衔接与网络恢复；不代表怪物战斗、正式遭遇回合或完整 MVP。

## 行为证据

规则证据与明确边界见 `contracts/npc-options.contract.json` 和 `docs/content-standard/cs03-npc-options.md`。

- `npc-options.test.ts`：行动者独占根级通用动作，其他五人只有等待摘要；可放弃超时不消费 RNG；末张强制选择；连续无合法项 NPC 弃置后继续揭牌或交接即时计分；后继窗口有新身份和截止，旧命令不再有效。
- 九种 NPC 行动逐一从未选择窗口进入真实处理器，子选择/伤害响应继续使用实际命令并重放，最终结束 NPC 持有状态。处理器的具体费用、牌区、角色、宠物与伤害结果由既有专项测试继续约束。
- `npc-options.replay.test.ts`：100 组可收缩种子，手动、超时、自动模式与连续 NPC；每次等待点恢复、重放、六视图一致，保留 15 秒期限和 56 张手牌类实体、46 张遭遇实体、34 个角色身份分区；越权、重复、提前超时、损坏绑定和伪造事件结果被拒绝。
- 同样手牌数量但不同私密身份的两个世界，其余五份视图和可操作项完全一致。`PlayerView.encounter.resolution` 不再包含第二套嵌套动作 API。
- 真实 HTTP 建房/六座准备/选角后，只注入初始未选行动 NPC 场景。六 WebSocket 在行动窗口重启后选择 NJ01/NJ06/NJ07，再在角色接收/私密给牌/宠物选择中重启；原窗口与 RNG 保留，越权拒绝，重复命令不重复支付或转移。
- 从 SQLite 读取真实选择事件：`npc-options.operation` 与 `npc.operation` 连续落盘、同一命令版本，重放到实际快照。不是只比较测试自行构造的结果。
- 可放弃和强制末张分别恢复完整但已过期的 15 秒窗口，由服务定时器执行；前者无 RNG，后者消耗一次行动 RNG 并进入处理器。落盘含唯一 `system.timeout-resolved`，第二次重启仍不重复执行；含连接事件的完整日志重放与服务器最新快照完全相等。

## 失败与反向复核

1. 初始新增测试先有 helper 缺括号语法错误，修正后以缺少 NPC 选择模块得到有效红测；原始日志均保留，语法失败不计为规则失败证据。
2. 专项首次完整通过后，全仓回归在既有死亡终局网络测试出现空 `dyingBatch`。检查发现该终局 fixture 继承随机/前序角色，错误假设全放弃必然死亡。前六次随机诊断未复现，不能据此忽略失败。
3. 显式把继承角色设为孔璘后，稳定复现同型失败：正确的 JN20602 把角色变为魔尊、HP 5、仍存活，救援结束而对局不结束。修复仅限终局 fixture：固定六个唯一角色及其基础属性，不继承变身/伤害后技能；保留故意传入孔璘的回归前提、窗口非空断言和原死亡/胜负断言。未修改生产变身规则，独立 JN20602 网络场景仍通过。首个偶发失败未保留角色快照，不声称已证明它的具体角色就是孔璘。
4. 复核选择和处理器不能分别增长命令版本；新增持久化事件重放及版本/序号断言。恢复只校验，不生成缺失窗口或重开期限。
5. NPC 无选项与未实现内容严格区分；选定处理器完成后只交接奖励，未偷接不完整怪物或提前将 55 项目录标为完成。

## 命令与产物

- `npm run npc-options:verify`：通过，115 项相关单元/重放、严格类型及 6 项时间/NPC 网络测试。
- `npm run check:full`：修复测试前提后通过，含 `check:fast`、构建、197 项单元、65 项重放、6 项 Bot、28 项网络集成、3 项既有 E2E 与本地六连接烟测。数字只用于定位证据，不等于行为完成度。
- `npm run oracle:inventory`：通过，1558 文件摘要 `c32a3e5e72e2b15da2891b8a04fe6856c030ac61e15345b4b196afc4e8a2df30` 不变。
- `npm run goal:preflight`：绿色提交后的干净工作区另行执行，结果见本地 `artifacts/cs03-options-preflight-green.txt`。
- 忽略产物：`artifacts/cs03-options-red.txt`、`cs03-options-red-valid.txt`、`cs03-options-tests.txt`、`cs03-options-network-timeout.txt`、`cs03-options-specialty.txt`、`cs03-options-check-full.txt`（首次失败）、`cs03-options-dying-diagnostic-1.txt` 至 `6.txt`、`cs03-options-dying-inherited-role-red.txt`、`cs03-options-dying-fixture-fixed.txt`、`cs03-options-check-full-green.txt`、`cs03-options-inventory.txt`。可公开最小复现为提交的测试，无 C#/SQLite 原件。

## 后继与回滚

下一节点 CS03-03C：怪物登场、战牌响应、胜败及宠物/同伴消耗；之后 CS03-03D 接管正式回合和奖励/计分。当前 E2E 仅回归既有界面，不能替代后续完整浏览器流程或干净克隆最终审计。

回滚起点：`b496891`。schema 仍为 11，但旧代码不识别新的 NPC 行动续算标识；回滚服务须使用该提交之前的数据库备份，不将新等待点交给旧代码。
