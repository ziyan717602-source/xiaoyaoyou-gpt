# P07 首次 E2E 失败记录

日期：2026-08-19

首次增加“一个可见玩家 + 五个策略 Bot”房间旅程后，`npm run test:e2e` 的第二个用例失败：

- 断言：文本包含“策略 Bot”的元素数量应为 5；
- 实际：6；
- 原因：定位器同时匹配五个 Bot 座位和页头“一名可见玩家 · 五名策略 Bot”；
- 修复：断言收紧为 `.journey-seat.is-bot`，仍严格要求五个 Bot 座位；准备状态同样收紧为六个 `.journey-seat.is-ready`。

Playwright 当次生成了 screenshot、video、trace 和 error-context，但下一次运行按默认行为清空了 `outputDir`，因此二进制原件没有保留下来。这暴露了验证设施自身的缺陷。现已加入 `persistent-failure-reporter.ts`：所有非预期结果会在测试结束时复制到独立的 `artifacts/failures/p07-e2e/`，后续运行不会清除该目录。

第二次运行 3 个 Chromium 用例全部通过。此记录不把丢失的附件伪装为仍存在，明确保留了失败断言、实际值、根因和验证设施修复。
