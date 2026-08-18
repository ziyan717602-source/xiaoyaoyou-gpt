# CS00 标准内容执行图验证收据

日期：2026-08-19

状态：pass

## 结果

- `content/standard-plan.json` 逐项覆盖权威目录中的 177 个标准包条目和 28 个共享核心前置，共 205 项；凤鸣玉誓的 28 项明确留给 `CONTENT-FMYSH`，没有混入标准包完成率。
- 每项都有稳定 ID、内容类型、所属切片、依赖内容/原语、隐藏信息、UI 选择、迁移状态和证据边界。生成器验证条目不重不漏，并与 `catalog/catalog.json` 的来源快照绑定。
- 当前基线诚实记录为 40 项 `partial`、165 项 `unstarted`、0 项 `verified`、0 项 `deferred`。40 项 partial 是 26 名标准角色的选将/基础属性，以及 14 张已有局部动作或装备槽行为的卡牌；均明确列出尚未实现的边界。
- `verified` 必须引用版本化收据，`deferred` 必须写明原因，`partial` 必须列出已实现边界和证据。目录生成器的默认 `unplanned` 不再被误用为实际完成度。
- 执行图固定为共享核心、四个标准牌切片、角色/技能、战斗牌堆、事件和特殊牌。第一可执行切片是 `CS01A-CORE-CARD-AUDIT`，先补齐灵葫仙丹普通自疗，并逐模式审计鼠儿果、天雷破、冰心诀和灵葫仙丹。

## 验证

- `npm run content:plan`：确定性生成 205 项执行图与报告。
- `npm run content:verify`：205/205，40 partial，0 verified。
- `npm run check:fast`：格式、类型、公开历史、目录、内容图、既有合同、11 replay 与 38 unit 全部通过。

回滚点：提交 `chore(CS00): freeze standard content execution graph`。
