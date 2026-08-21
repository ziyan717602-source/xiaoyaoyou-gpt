# 当前目标检查点

- 分支：`codex/goal-mvp`
- 当前节点：`CONTENT-STANDARD / CS02-HERO-SKILLS`
- 最近验证完成：`CS02 / JN30201 追打在实际伤害后、濒死前提供本人私有弃牌选择，并以可递归、可恢复的普通伤害批次续算`
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
- CS01B 行动技牌证据：`contracts/action-tricks.contract.json`、`docs/content-standard/cs01b-action-tricks.md`、`docs/verification/receipts/cs01b-jp01.md`、`docs/verification/receipts/cs01b-jp03.md`、`docs/verification/receipts/cs01b-jp06.md`
- CS01C 防御/战力牌证据：`contracts/defense-buffs.contract.json`、`docs/content-standard/cs01c-defense-buffs.md`、`docs/verification/receipts/cs01c-tp03.md`
- CS01D 装备证据：`contracts/equipment-effects.contract.json`、`docs/content-standard/cs01d-equipment-effects.md`、`docs/verification/receipts/cs01d-wq04.md`、`docs/verification/receipts/cs01d-wq02.md`、`docs/verification/receipts/cs01d-fj03-fj04.md`、`docs/verification/receipts/cs01d-fj01.md`、`docs/verification/receipts/cs01d-fj05.md`、`docs/verification/receipts/cs01d-fj02.md`、`docs/verification/receipts/cs01d-dependency-audit.md`
- CS02 英雄技能证据：`contracts/hero-skills.contract.json`、`docs/content-standard/cs02-hero-skills.md`、`docs/verification/receipts/cs02-jn50401.md`、`docs/verification/receipts/cs02-jn50402.md`、`docs/verification/receipts/cs02-jn50501.md`、`docs/verification/receipts/cs02-jn20202.md`、`docs/verification/receipts/cs02-jn40301.md`、`docs/verification/receipts/cs02-jn40302.md`、`docs/verification/receipts/cs02-jn10501.md`、`docs/verification/receipts/cs02-jn10502.md`、`docs/verification/receipts/cs02-jn20601.md`、`docs/verification/receipts/cs02-jn20602-core.md`、`docs/verification/receipts/cs02-jn20701.md`、`docs/verification/receipts/cs02-jn20702.md`、`docs/verification/receipts/cs02-jn30201.md`、`docs/verification/receipts/cs02-jn20302.md`、`docs/verification/receipts/cs02-jn40401.md`、`docs/verification/receipts/cs02-jn50201.md`、`docs/verification/receipts/cs02-jn50202.md`、`docs/verification/receipts/cs02-jn50203.md`
- 当前工作：从已冻结的 34 英雄、77 条技能归属边继续选择不依赖 CS03 战斗的最高优先级真实技能，按触发、选择、隐藏信息、重放和六连接逐项闭环。
- 下一 ready 节点：`CS02-HERO-SKILLS`。
- 阻塞：无。
- 临时规则决定：`SEM-001` 至 `SEM-008`，见 `docs/rules-semantics/decisions.md`。

详细历史只查 Git 提交和 `docs/verification/receipts/`；本文件完成节点后覆盖更新。
