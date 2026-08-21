# CS02 / JN20602 生命献祭当前运行时验证收据

日期：2026-08-21
状态：pass（partial；宠物保留等待 CS03）

## 规则证据

- SQLite：`OCCURS=!G0ZW`、`PRIORS=-10`、`ONCE=1`、`TERMINI=1`；描述为死亡后变为魔尊，装备、手牌、宠物保留。
- `PSDGamepkg/JNS/XJ405.cs:591-612`：从 `G0ZW` 列表删除本人，发送 `G0OY,0` 卸载孔璘、`G0IY,0,...,10207` 装载魔尊，再递归处理剩余死亡列表。
- `PSDGamepkg/XIG.cs:437-535`：英雄卸载不会弃置手牌或基础装备；`XIG.cs:1433-1495` 在新英雄初始化后重新加载基础装备和宠物效果。
- `PSDBase/Player.cs:343-361`：reset 初始化恢复存活和可选中状态，以新英雄满 HP、基础属性及手牌上限覆盖旧值。
- SQLite 英雄表：XJ207 为 HP 5、STR 8、DEX 2、男性，拥有 JN20701/JN20702；`Hero.cs:214-219` 将 XJ207 排除在开局可加入英雄外。

## 已验证边界

- 只有原生 XJ206 在 HP 为零且全部救援机会失败后自动触发；成功使用五彩霞衣等救援会保留 XJ206，且不产生变身事件。
- 变身事件先于普通死亡、卡区清理、JN50203 死亡战利品和胜负判定，把角色设置为存活的 XJ207、HP/maxHP 5、strength 8、dexterity 2、handLimit 3。英雄属性来自权威目录，伪造目标英雄会被 reducer 拒绝。
- 手牌、武器、防具、队伍、座次、连接和当前回合保持；变身者不进入死亡列表或弃牌堆。手牌实体仍只出现在本人投影，装备与公开属性对六席一致。
- 同时濒死时只从批次移除孔璘，其他角色继续救援、死亡与清理。双方最后角色同时归零时，孔璘先变身、对手随后死亡，最终由魔尊所在队获胜而不是错误平局。
- JSON 重启覆盖每次救援命令和完整事件重放；六个真实 WebSocket 覆盖救援中 SQLite 重启、自动变身、变身后再次重启和私密手牌恢复。

## 未完成边界

- 当前 `PlayerState` 尚无宠物实体和宠物效果，无法验证非空宠物在变身前后的实体守恒与效果重载。该项明确依赖 `CS03-BATTLE-DECKS`；在对应测试绿色前，`xyy.skill.jn20602`、`xyy.hero.xj206` 和 `xyy.hero.xj207` 均保持 partial。

## 验证命令

- `npm test -- --run packages/engine/src/damage-dying.test.ts`
- `npm run test:replay -- --run packages/engine/src/damage-dying.replay.test.ts`
- `npm run test:integration -- --run tests/integration/damage-dying-lifecycle.integration.test.ts`
- `npm run check:fast`
- `npm run goal:preflight`

## 完整门禁矩阵

- 单元测试：82/82。
- 事件重放：35/35。
- Bot 长程模拟：6/6，其中伤害能力 Bot 连续完成至少 1,000 回合及一场完整对局。
- 六连接真实网络集成：14/14。
- Chromium 端到端：3/3，覆盖六个隔离 BrowserContext、五 Bot 房间旅程和移动端关键控件。
- 本地服务冒烟：6 个客户端，健康检查与根页面均通过。

## 内容状态

- `xyy.skill.jn20602`：partial；当前运行时变身闭合，宠物保留等待 CS03。
- `xyy.hero.xj206`：partial；JN20601 verified，JN20602 当前边界已验证。
- `xyy.hero.xj207`：partial；变身身份和基础属性已验证，JN20701/JN20702 尚待迁移。
