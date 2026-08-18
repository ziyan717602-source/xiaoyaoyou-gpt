# CS01D / FJ05 踏云靴受伤弃甲验证收据

日期：2026-08-19

状态：pass（目录项保持 partial）

## 规则与交互边界

- 旧 C# `JP06.cs:685-706` 允许持有者在自己的正数伤害项不含 `DECR_INVAO/IMMUNE_INVAO` 时弃甲，删除全部符合项并回复 1；没有排除 `TUX_INAVO`。
- 当前使用独立 `activate-damage-equipment`，只投影给伤害批次中的持有者本人；发动支付唯一实体 `xyy.card.fj05@56`，处理后推进当前响应优先权，超时默认 pass。
- 治疗进入统一计划，因此 WQ02 把基础 1 修正为 2；删除后的伤害批次继续走事件复算、隐蛊、扣 HP 与濒死流程。

## 验证结果

- 单元测试以 `TUX_INAVO` 伤害验证仍可发动、全部可免疫项删除、WQ02 联动、卡区和窗口关闭；`DECR_INVAO/IMMUNE_INVAO` 均绕过且不提供动作。
- JSON 检查点恢复、不中断执行和完整装备事件重放一致。
- 六 WebSocket + SQLite 从真实天雷破进入伤害批次，仅目标获得弃甲动作；发动后防具进入弃牌、治疗生效、伤害/濒死窗口关闭，同一房间继续完成胜负流程。
- FJ05 命中与装备失效状态等待 CS03/CS02，不伪造占位状态。

## 回归计数

- 核心单元：53 passed。
- JSON 回放：19 passed。
- 策略 Bot：6 passed。
- 六连接集成：7 passed。
- Chromium E2E：3 passed。
- 本地 smoke：6 个客户端通过；依赖审计：0 vulnerabilities。

回滚点：提交 `feat(CS01D-5): add FJ05 damage-window burst`。
