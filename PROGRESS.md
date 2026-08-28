# 当前目标检查点

- 分支：`codex/goal-mvp`
- 当前节点：`CONTENT-STANDARD / CS03-BATTLE-DECKS`
- 最近验证完成：`CS03-03B-01 / NJ02/03/04/05/06/08 与 NJ09 收为同伴的真实状态效果；伤害/救援/遗物嵌套续算、私密给牌六连接重启、事件重放与 56/46 实体守恒通过。NJ01/NJ07、怪物效果与正式回合仍未闭合，不计为 55 项内容完成。`
- P01 证据：`docs/audits/p01-pre-clean-backup.md`、`p01-public-history-scan.md`、`p01-remote-clone-verification.md`
- P02 清单证据：`docs/legacy-evidence/inventory.json`、`docs/legacy-evidence/README.md`、`docs/verification/receipts/p02-legacy-inventory.md`
- P03 目录证据：`catalog/catalog.json`、`catalog/report.md`、`docs/verification/receipts/p03-authoritative-catalog.md`
- P02 轨迹证据：`oracle/golden-traces/`、`docs/legacy-evidence/oracle-degradation.md`、`docs/verification/receipts/p02-golden-traces.md`
- P04 语义证据：`contracts/semantics.contract.json`、`docs/rules-semantics/`、`docs/verification/receipts/p04-semantics-contract.md`
- P05 UX 证据：`contracts/ux-prototype.contract.json`、`docs/ux-prototype/`、`docs/verification/screenshots/`、`docs/verification/receipts/p05-ux-prototype.md`
- P06 探针证据：`contracts/technical-probes.contract.json`、`packages/engine/src/technical-probes.replay.test.ts`、`docs/verification/receipts/p06-technical-probes.md`
- P07 验证证据：`contracts/verification-system.contract.json`、`docs/verification/p07-system.md`、`docs/verification/receipts/p07-verification-system.md`
- P08 架构证据：`contracts/architecture.contract.json`、`docs/architecture/`、`docs/adr/0004-production-runtime-stack.md`、`docs/verification/receipts/p08-production-architecture.md`
- P10 准备证据：`docs/preparation-report.md`、`docs/verification/receipts/p10-go-no-go.md`、`pre-goal-20260819`
- M01 房间证据：`contracts/room-lifecycle.contract.json`、`docs/room-lifecycle/m01-room-lifecycle.md`、`docs/verification/receipts/m01-room-lifecycle.md`
- M02 开局证据：`contracts/setup.contract.json`、`docs/setup/m02-seeded-setup.md`、`docs/verification/receipts/m02-setup-and-teams.md`
- M03 回合证据：`contracts/turn-core.contract.json`、`docs/turn-core/m03-turn-core.md`、`docs/verification/receipts/m03-turn-core.md`
- M04 响应证据：`contracts/reaction-core.contract.json`、`docs/reaction-core/m04-reaction-core.md`、`docs/verification/receipts/m04-reaction-core.md`
- M05 伤害/濒死证据：`contracts/damage-dying.contract.json`、`docs/damage-dying/m05-damage-dying.md`、`docs/verification/receipts/m05-damage-dying.md`
- M06 时间/恢复证据：`contracts/time-recovery.contract.json`、`docs/time-recovery/m06-time-recovery.md`、`docs/verification/receipts/m06-time-recovery.md`
- CS00 内容图证据：`contracts/content-standard.contract.json`、`content/standard-plan.json`、`docs/content-standard/plan.md`、`docs/verification/receipts/cs00-content-graph.md`
- CS01A 核心四牌证据：`contracts/core-card-audit.contract.json`、`docs/content-standard/cs01a-core-cards.md`、`docs/verification/receipts/cs01a-core-card-audit.md`
- CS01B 行动技牌证据：`contracts/action-tricks.contract.json`、`docs/content-standard/cs01b-action-tricks.md`、`docs/verification/receipts/cs01b-jp01.md`、`docs/verification/receipts/cs01b-jp02.md`、`docs/verification/receipts/cs01b-jp03.md`、`docs/verification/receipts/cs01b-jp06.md`
- CS01C 防御/战力牌证据：`contracts/defense-buffs.contract.json`、`docs/content-standard/cs01c-defense-buffs.md`、`docs/verification/receipts/cs01c-tp03.md`
- CS01D 装备证据：`contracts/equipment-effects.contract.json`、`docs/content-standard/cs01d-equipment-effects.md`、`docs/verification/receipts/cs01d-wq04.md`、`docs/verification/receipts/cs01d-wq02.md`、`docs/verification/receipts/cs01d-fj03-fj04.md`、`docs/verification/receipts/cs01d-fj01.md`、`docs/verification/receipts/cs01d-fj05.md`、`docs/verification/receipts/cs01d-fj02.md`、`docs/verification/receipts/cs01d-dependency-audit.md`
- CS02 英雄技能证据：`contracts/hero-skills.contract.json`、`docs/content-standard/cs02-hero-skills.md`、`docs/verification/receipts/cs02-jn50401.md`、`docs/verification/receipts/cs02-jn50402.md`、`docs/verification/receipts/cs02-jn50501.md`、`docs/verification/receipts/cs02-jn20202.md`、`docs/verification/receipts/cs02-jn40301.md`、`docs/verification/receipts/cs02-jn40302.md`、`docs/verification/receipts/cs02-jn10501.md`、`docs/verification/receipts/cs02-jn10502.md`、`docs/verification/receipts/cs02-jn20601.md`、`docs/verification/receipts/cs02-jn20602-core.md`、`docs/verification/receipts/cs02-jn20701.md`、`docs/verification/receipts/cs02-jn20702.md`、`docs/verification/receipts/cs02-jn30201.md`、`docs/verification/receipts/cs02-jn10401.md`、`docs/verification/receipts/cs02-jn10601.md`、`docs/verification/receipts/cs02-duel-dice.md`、`docs/verification/receipts/cs02-jn20302.md`、`docs/verification/receipts/cs02-jn40401.md`、`docs/verification/receipts/cs02-jn50201.md`、`docs/verification/receipts/cs02-jn50202.md`、`docs/verification/receipts/cs02-jn50203.md`
- CS03 遭遇/战斗基线证据：`contracts/encounter-deck.contract.json`、`contracts/encounter-flow.contract.json`、`docs/content-standard/cs03-encounter-deck.md`、`docs/content-standard/cs03-encounter-flow.md`、`docs/rules-semantics/cs03-encounter-deck-gap.md`、`docs/verification/receipts/cs03-encounter-deck.md`、`docs/verification/receipts/cs03-encounter-flow.md`
- CS03-03A 证据：`contracts/encounter-resolution.contract.json`、`docs/content-standard/cs03-encounter-resolution.md`、`docs/verification/receipts/cs03-encounter-resolution.md`；`check:full` 通过（单元 131、重放 47、Bot 6、集成 19、既有 E2E 3）。
- CS03-03B-01 证据：`contracts/npc-effects.contract.json`、`docs/content-standard/cs03-npc-effects.md`、`docs/verification/receipts/cs03-npc-effects.md`；`check:full` 通过（单元 142、重放 52、Bot 6、集成 20、既有 E2E 3）。
- 当前工作：七个 NPC 基础处理器已接入实际状态和网络命令；继续闭合 NJ01/NJ07 与全量合法性，不得因为缺处理器跳过 NPC。
- 下一 ready 节点：`CS03-03B-02 / NPC 角色加入与宠物交换`，先实现 NJ07 同队宠物转移/同属性强制交换，再实现 NJ01 手牌代价、角色替换/复活、可加入角色约束与 NPC 合法选项。
- 阻塞：无。
- 临时规则决定：`SEM-001` 至 `SEM-010`，见 `docs/rules-semantics/decisions.md`。

详细历史只查 Git 提交和 `docs/verification/receipts/`；本文件完成节点后覆盖更新。
