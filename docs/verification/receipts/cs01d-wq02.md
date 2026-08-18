# CS01D / WQ02 天蛇杖治疗增幅验证收据

日期：2026-08-19

状态：pass（目录项保持 partial）

## 规则与结算边界

- 旧 C# `JP06.cs:572-591` 对持有者的每个正数治疗项增加 1，并跳过 `HPEvoMask.TERMIN_AT`；修正判断目标持有者，不依赖治疗来源。
- TP02 普通模式、TP02 濒死救援和 JP03 队伍治疗统一经过确定性治疗计划。事件保存基础/最终数值、掩码、HP 前后值与生效装备实例，归约时根据当前权威状态完整复算后才修改 HP。
- WQ02 只影响目标自己的正数、非 `TERMIN_AT` 项；0 点、未装备、其他玩家以及终止治疗保持基础值。HP 仍封顶于角色上限。
- WQ02 的战力 +1 等待 CS03 真实战斗计算，因此目录状态保持 partial。

## 验证结果

- 计划器单元测试覆盖普通项、`FROM_JP`、`TERMIN_AT`、0 点、装备归属、卸下装备和同目标多项顺序结算。
- 引擎测试覆盖持杖者使用 TP02 普通治疗、作为 TP02 濒死救援目标，以及作为 JP03 队伍成员；冰心诀抵消仍不会产生治疗。
- JSON 重启/事件重放覆盖持杖者的 TP02 与 JP03，并在濒死优先权中途重启后由另一玩家用 TP02 救援持杖者。
- 两条六 WebSocket + SQLite 集成分别验证 TP02 普通响应链和濒死救援链；私有手牌、优先权、重启与幂等行为保持不变。
- `npm run check:full`：unit 48/48、replay 17/17、bots 6/6、integration 7/7、Playwright 3/3、本地烟测 6 个客户端；构建、类型、格式、公开历史、旧卡牌契约与 56 张行动牌守恒全部通过。
- `npm audit --audit-level=low`：0 个已知漏洞；`git diff --check` 通过。
- 最终 Git 回滚点将在干净提交上运行 `npm run goal:preflight` 后记录。

回滚点：提交 `feat(CS01D-2): add deterministic WQ02 cure modifier`。
