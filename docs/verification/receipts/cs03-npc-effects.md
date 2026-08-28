# CS03-03B-01 NPC 具体效果验证收据

日期：2026-08-28

状态：pass；仅适用于本文列出的具体效果，不代表完整 CS03 或 MVP 完成。

## 来源与范围

见 `contracts/npc-effects.contract.json` 和 `docs/content-standard/cs03-npc-effects.md`。七个处理器为 NJ02/03/04/05/06/08 和 NJ09 收为同伴。真实状态、通用命令、领域事件、RNG、超时、玩家投影与伤害/救援/死亡续算已接通。schema 升至 9；v8 添加空运行状态而不重洗或泄露知识。

## 直接场景

- `npc-effects.test.ts`：治疗及 WQ02 加成；实际摸牌；NJ03 自伤等待救援后才摸牌；来源死亡、目标死亡与终局清理；NJ05 被 TP03 防住；NJ06 选交牌者、同队收牌者及交牌者的私密牌；NJ08 种子弃牌；NJ09 实体转移。
- 跨内容链验证 NJ03 致死→JN50203 遗物分配→遗物技能再次自伤→NPC 后续摸牌；每个操作都重放实际事件并序列化恢复。死亡同伴在普通清理和遗物分支均进入遭遇弃牌堆，当前持有 NPC 直到全部子效果结束才归属。
- `npc-effects.replay.test.ts`：60 个可收缩种子的多步选择/超时组合，每步比较正常、JSON 恢复和领域事件重放，断言 56/46 个实体守恒与六份私密视图。另覆盖自动座位即时默认、v8 升级、损坏选择所有者/期限/续算步骤/目标数量/绑定 NPC 的快照拒绝以及篡改事件拒绝。
- `time-recovery-lifecycle.integration.test.ts`：真实 HTTP 建房、六人开局后，仅注入一个已选择 NJ06 的起始快照；后续交牌者/收牌者/私密牌选择全部走真实六 WebSocket、Actor 与 SQLite。私密等待中关闭并重启服务器，原选项和截止不变；非交牌者拒绝；重复命令只转移一次；完成后再次重启归属与 RNG 不变。

## 失败证据与纠正

- `artifacts/cs03-03b-red.txt`：处理模块不存在的初始失败。
- `artifacts/cs03-03b-damage-window-red.txt`：测试最初假定伤害立即扣 HP；核对既有普通伤害响应后，改为先断言 TP03 窗口和未扣血，再提交放弃，不跳过合法响应。
- `artifacts/cs03-03b-victory-red.txt`：真实终局清空 `activePlayerId` 后 NPC 无法清理；修复后终局仍能完成唯一归属，不再奖励摸牌。
- `artifacts/cs03-03b-snapshot-red.txt`：损坏的选择所有者快照未被拒绝；增加关联验证，没有放宽预期。
- `artifacts/cs03-03b-death-privacy-red.txt`：死亡遗留同伴、其他席位不知道当前等谁交牌；按源码补清理，并只添加公开等待摘要。
- `artifacts/cs03-03b-cross-effects.txt`：新增遗物测试误把技能编号当英雄编号；按既有目录确认 JN50203 属于 XJ402，纠正 fixture 后同一嵌套行为预期通过。

SEM-010 明确记录 NJ03 死亡后摸牌的暂行偏离、问题和备选；未声称 C# 黑盒等价。

## 回归与回滚

- 最终 `check:full` 通过，日志 `artifacts/cs03-03b-check-full-final.txt`。单元 142、重放 52、Bot 6、真实网络 20、既有 Playwright 3，以及构建与本地六连接烟测；数字用于定位日志，不替代上述直接行为证据。
- `oracle:inventory`：1558 文件保持不变，聚合值 `c32a3e5e72e2b15da2891b8a04fe6856c030ac61e15345b4b196afc4e8a2df30`。
- `git diff --check`、公开历史扫描及严格类型检查通过。绿色提交后在干净工作树运行 `goal:preflight`，日志 `artifacts/cs03-03b-preflight.txt`。
- 回滚点：本收据对应的 `feat(CS03-03B-01)` 提交；不改写历史，不包含本地 reference 或测试产物。

## 不属于完成证明

NJ01/NJ07、完整 NPC 合法性、怪物/宠物效果、战斗中的同伴消耗、真实遭遇回合入口与整局 UI 仍未完成。既有浏览器用例不是新增 NPC UI 验收，fixture 起点不是生产从行动阶段进入遭遇的证据。55 项 CS03 内容状态未批量提高；聚合节点 CS03-03B/C/D 与最终验收继续保持未完成。
