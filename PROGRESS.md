# 当前目标检查点

- 分支：`codex/goal-mvp`
- 当前节点：`P07-VERIFICATION`
- 最近验证完成：`P06-TECHNICAL-PROBES`
- P01 证据：`docs/audits/p01-pre-clean-backup.md`、`p01-public-history-scan.md`、`p01-remote-clone-verification.md`
- P02 清单证据：`docs/legacy-evidence/inventory.json`、`docs/legacy-evidence/README.md`、`docs/verification/receipts/p02-legacy-inventory.md`
- P03 目录证据：`catalog/catalog.json`、`catalog/report.md`、`docs/verification/receipts/p03-authoritative-catalog.md`
- P02 轨迹证据：`oracle/golden-traces/`、`docs/legacy-evidence/oracle-degradation.md`、`docs/verification/receipts/p02-golden-traces.md`
- P04 语义证据：`contracts/semantics.contract.json`、`docs/rules-semantics/`、`docs/verification/receipts/p04-semantics-contract.md`
- P05 UX 证据：`contracts/ux-prototype.contract.json`、`docs/ux-prototype/`、`docs/verification/screenshots/`、`docs/verification/receipts/p05-ux-prototype.md`
- P06 探针证据：`contracts/technical-probes.contract.json`、`packages/engine/src/technical-probes.replay.test.ts`、`docs/verification/receipts/p06-technical-probes.md`
- 当前工作：建立单元、重放、Bot、集成和浏览器各层的稳定命令与失败产物规范。
- 下一 ready 节点：`P07-VERIFICATION`，随后冻结 P08 生产架构契约。
- 阻塞：无。
- 临时规则决定：`SEM-001` 至 `SEM-006`，见 `docs/rules-semantics/decisions.md`。

详细历史只查 Git 提交和 `docs/verification/receipts/`；本文件完成节点后覆盖更新。
