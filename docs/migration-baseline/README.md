# 迁移基线

状态：`Baseline 0`

建立日期：2026-08-18

本目录是迁移工作的共同事实来源。它回答五个问题：旧系统是什么、哪些规则算正确、目标系统如何运行、首个版本做什么，以及怎样判断迁移完成。

## 基线结论

- 旧项目已经是六人联网游戏，迁移对象是旧式 TCP/WPF 架构，不是单机规则原型。
- 不把旧 C# 服务端直接暴露到公网，也不逐行翻译阻塞式控制流。
- 不采用 boardgame.io 作为规则内核；自行实现显式、确定性、可序列化的响应栈。
- 生产服务端是唯一权威；浏览器只显示玩家视图并提交命令。
- 从一个包含冰心诀、濒死、救援和重连的纵向切片开始，先验证最困难的系统能力。
- UI 与规则引擎并行验证，但客户端不得包含裁定规则。

## 文档索引

1. [旧系统清单](01-legacy-inventory.md)
2. [规则权威与证据](02-rule-authority.md)
3. [目标架构](03-target-architecture.md)
4. [规则状态机](04-rules-engine.md)
5. [MVP 范围与验收](05-mvp-and-acceptance.md)
6. [UI/UX 基线](06-ui-ux.md)
7. [风险登记册](07-risk-register.md)
8. [开放问题与决策日志](08-open-questions.md)
9. [工程组织方法提案](09-engineering-method.md)
10. [验证与测试策略提案](10-verification-strategy.md)
11. [技术路线复核提案](11-technical-route-review.md)
12. [正式开发前准备闸门](12-pre-development-readiness.md)

可执行验收示例位于 [scenarios](scenarios/)；它们先用 Gherkin 固定语义，后续转换为自动化测试。

跨文档的准备进度不在本索引里分散跟踪；以根目录 [PREPARATION_CHECKLIST.md](../../PREPARATION_CHECKLIST.md) 为唯一总清单，以 [GOAL_CONTRACT.md](../../GOAL_CONTRACT.md) 为未来无人值守开发契约。

## 基线变更规则

- 已接受的架构原则通过 ADR 修改，不能只在代码中悄悄改变。
- 规则行为变化必须更新来源、裁定记录和相应场景。
- MVP 增项必须同时说明推迟什么，防止范围只增不减。
- 每完成一个扩展包，生成迁移覆盖率报告：总数、已迁移、已测试、存在争议。
