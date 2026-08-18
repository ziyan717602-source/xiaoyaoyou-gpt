# 当前目标检查点

- 分支：`codex/goal-mvp`
- 当前节点：`M03-TURN-CORE`
- 最近验证完成：`M02-SETUP-AND-TEAMS`
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
- 当前工作：实现正式回合/阶段、摸牌、出牌、目标、装备、弃牌与基本胜负的确定性核心，为复杂响应和濒死节点提供稳定动作管线。
- 下一 ready 节点：`M03-TURN-CORE`。
- 阻塞：无。
- 临时规则决定：`SEM-001` 至 `SEM-007`，见 `docs/rules-semantics/decisions.md`。

详细历史只查 Git 提交和 `docs/verification/receipts/`；本文件完成节点后覆盖更新。
