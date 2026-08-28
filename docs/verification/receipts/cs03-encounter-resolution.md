# CS03-03A 揭牌路由验证收据

日期：2026-08-28

状态：pass（仅 CS03-03A 定义的路由/数值范围）。

## 来源与变更

对应 `contracts/encounter-resolution.contract.json` 和 `docs/content-standard/cs03-encounter-resolution.md`。实现范围为揭牌、NPC 连续放弃/末牌强制、动作效果持有与完成归属、同属性宠物强制保留、命中/战力/必胜败与宠物终局分数。20 怪物与 26 NPC 的名称、基础数值及 NPC 行动列表已用只读 SQLite 逐项对账。

## 直接行为验证

- `encounter-resolution.test.ts`：15 个场景覆盖路由、奖励时点、NPC 选择权限与截止、末牌强制随机、同伴归属、宠物冲突、旧/新保留、过期/越权/重复拒绝、提前超时拒绝、时间/数值异常拒绝、同属性槽与唯一身份、额外参战者、强制胜败和蓝队平分胜。
- `encounter-resolution.replay.test.ts`：全部 46 张牌逐类路由及内部完成钩子的恢复；60 个可收缩种子的混合牌堆序列，在每个转移处 JSON 往返并断言相同结果、无输入变异、有界终止和主/后备合计 46 身份守恒；五名非行动者投影在不同牌堆/候选世界相同。
- `npm run encounter-resolution:verify` 18/18 通过，严格类型通过。

## 失败留证与检查修正

- 首次失败 `artifacts/cs03-03-red.txt`：新路由模块尚不存在，保留原日志。
- 复查既有 `SEM-002` 时发现宠物强制随机错误地使用“旧/新展示顺序”，而非规范 ID 排序。增加反序宠物场景，先确认失败（`artifacts/cs03-03a-canonical-timeout-red.txt`），再修复实现；未修改或放宽预期。

## 回归与隔离

- `npm run check:full`：通过，包含 `check:fast`、构建、重放、Bot、真实网络、既有浏览器和本地六连接烟测。最终日志 `artifacts/cs03-03a-check-full-final.txt`。
- 单元 131/131，重放 47/47，Bot 6/6，真实网络 19/19，既有 Playwright 3/3。数字只帮助定位日志，行为证明以本收据前述具体场景为准。
- `npm run oracle:inventory`：1558 文件一致，聚合校验值 `c32a3e5e72e2b15da2891b8a04fe6856c030ac61e15345b4b196afc4e8a2df30` 不变。
- `git diff --check` 和公开历史扫描通过；只显式暂存本节点代码/文档，不暂存参考目录或产物。绿色提交后再次执行 `goal:preflight`，日志放在忽略的 `artifacts/cs03-03a-preflight.txt`。

## 不能据此宣称的完成项

本节点未接管生产回合、未新增客户端动作或 SQLite 事件。完成钩子的测试不是具体 NPC/怪物效果完成证据，既有 E2E 通过也不是 CS03 界面验收。CS03-03B/C/D、55 项具体内容、完整对局和最终 GOAL_ACCEPTANCE 仍待完成。

回滚点：本收据对应的 `feat(CS03-03A)` 绿色提交。
