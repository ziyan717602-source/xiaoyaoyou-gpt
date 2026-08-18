# CONTENT-STANDARD 逐项执行图

> 本文件由 `npm run content:plan` 从权威目录与内容合同确定性生成；不能手工把条目标成完成。

- 标准包：177
- 共享核心前置：28
- 总跟踪：205
- 当前 partial：41
- 当前 verified：1
- 当前 deferred：0
- 当前 unstarted：163

## 执行切片

| 切片                      | 条目数 |
| ------------------------- | -----: |
| `CS00-SHARED-CORE`        |     28 |
| `CS01A-CORE-CARD-AUDIT`   |      4 |
| `CS01B-ACTION-TRICKS`     |      4 |
| `CS01C-DEFENSE-AND-BUFFS` |      6 |
| `CS01D-EQUIPMENT-EFFECTS` |     10 |
| `CS02-HERO-SKILLS`        |     83 |
| `CS03-BATTLE-DECKS`       |     55 |
| `CS04-EVENTS`             |     14 |
| `CS05-SPECIAL`            |      1 |

第一可执行切片是 `CS01A-CORE-CARD-AUDIT`：冻结鼠儿果、天雷破、冰心诀、灵葫仙丹的逐模式旧版证据并补齐灵葫仙丹普通自疗。仍依赖事件、技能或特殊牌的条目继续保持 partial，直到相应切片闭合。

## 已验证条目

| ID              | 名称     | 完成边界                                                                          | 证据                                             |
| --------------- | -------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| `xyy.card.jp03` | 五气朝元 | primary living-team heal-one and alternate pawn draw-one modes are fully verified | receipt:docs/verification/receipts/cs01b-jp03.md |

## 已有局部实现（不得误报为完成）

| ID               | 名称        | 已实现边界                                                                                                                                                       | 证据                                    |
| ---------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `xyy.card.fj01`  | 五彩霞衣    | armor slot equip and replacement only; unique healing modifier pending                                                                                           | M03-TURN-CORE                           |
| `xyy.card.fj02`  | 天帝祭服    | armor slot equip and replacement only; unique card-zone effect pending                                                                                           | M03-TURN-CORE                           |
| `xyy.card.fj03`  | 龙魂战铠    | armor slot equip and replacement only; unique damage effect pending                                                                                              | M03-TURN-CORE                           |
| `xyy.card.fj04`  | 乾坤道袍    | armor slot equip and replacement only; unique damage modifier pending                                                                                            | M03-TURN-CORE                           |
| `xyy.card.fj05`  | 踏云靴      | armor slot equip and replacement only; unique healing and damage modifiers pending                                                                               | M03-TURN-CORE                           |
| `xyy.card.jp01`  | 偷盗        | ordinary-hand target selection, opaque slot choice, cancellable authoritative transfer, restart and deterministic timeout; protected-card exclusion pending CS02 | CS01B-JP01-HIDDEN-TRANSFER              |
| `xyy.card.jp04`  | 鼠儿果      | draw-two action and cancellable effect path; full legacy audit pending                                                                                           | M03-TURN-CORE, M04-REACTION-CORE        |
| `xyy.card.jp05`  | 天雷破      | targeted thunder damage-two, cancellation, dying and victory path; full catalog verification pending                                                             | M04-REACTION-CORE, M05-DAMAGE-DYING     |
| `xyy.card.tp01`  | 冰心诀      | counter-chain for current cancellable card effects; all standard response targets pending                                                                        | M04-REACTION-CORE                       |
| `xyy.card.tp02`  | 灵葫仙丹    | normal cancellable self-heal-two and dying rescue-two are implemented; linked cleanse/locust interaction pending                                                 | M05-DAMAGE-DYING, CS01A-CORE-CARD-AUDIT |
| `xyy.card.wq01`  | 无尘剑      | weapon slot equip and replacement only; unique modifier pending                                                                                                  | M03-TURN-CORE                           |
| `xyy.card.wq02`  | 天蛇杖      | weapon slot equip and replacement only; unique response effect pending                                                                                           | M03-TURN-CORE                           |
| `xyy.card.wq03`  | 魔刀天叱    | weapon slot equip and replacement only; unique modifier pending                                                                                                  | M03-TURN-CORE                           |
| `xyy.card.wq04`  | 魔剑        | weapon slot equip and replacement only; unique draw effect pending                                                                                               | M03-TURN-CORE                           |
| `xyy.card.wq05`  | 彩环        | weapon slot equip and replacement only; unique modifier pending                                                                                                  | M03-TURN-CORE                           |
| `xyy.hero.x3w01` | 南宫煌      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.x3w02` | 温慧        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.x3w03` | 星璇        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.x3w04` | 王蓬絮      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj101` | 李逍遥      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj102` | 赵灵儿      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj103` | 赵灵儿·梦蛇 | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj104` | 林月如      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj105` | 阿奴        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj106` | 酒剑仙      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj107` | 拜月教主    | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj201` | 王小虎      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj202` | 苏媚        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj203` | 沈欺霜      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj206` | 孔璘        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj207` | 魔尊        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj302` | 唐雪见      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj305` | 紫萱        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj306` | 重楼        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj401` | 云天河      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj402` | 韩菱纱      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj403` | 柳梦璃      | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj404` | 慕容紫英    | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj405` | 玄霄        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj503` | 龙幽        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |
| `xyy.hero.xj504` | 小蛮        | setup identity, base stats, selectability and private offer only; hero skills are not implemented                                                                | M02-SETUP-AND-TEAMS                     |

完整 205 项状态、依赖原语、隐藏信息与 UI 选择见 `content/standard-plan.json`。
