# P03 权威迁移目录收据

日期：2026-08-19

## 结论

- `catalog/catalog.schema.json` 固定了稳定 `canonicalId`、旧 ID/CODE、物理牌序号、来源、文本哈希、C# 绑定角色、依赖和迁移状态。
- `Card.Level2Pkg(4) = [1,2]` 与 `VALID/COUNT` 用于选择启用范围；旧 UI 的 `GENRE=1/2` 用于标准包/凤鸣玉誓产品归属，二者不再混用。
- 12 张 SQLite 表共映射 233 项：标准包 177、凤鸣玉誓 28、共享核心 28。
- 34 名角色与旧 `reference/docs/scope.md` 的 26 标准 + 8 凤鸣数量及名单一致；“龙葵/龙葵鬼”与数据库“龙葵·蓝/龙葵·红”的名称差异保留为 alias 和 `CAT-004`。
- 24 类手牌对应 56 个标准包物理序号；20 怪物、26 NPC、9 NPC 行动、14 事件均完成逐表对账。
- 233 项拥有 584 个 C# loader/mapper/handler 绑定、254 条范围内内容依赖；完整描述没有复制进公开仓库，只提交表/列定位与 SHA-256。
- 数据库字段与绑定方法正文只在本地用于受控词表分类；公开目录记录 29 类结算原语、隐藏信息边界和 UI 选择需求，不复制分类证据原文。
- 分类结果为 95 项 `mixed` 隐藏信息、138 项 `none`；UI 覆盖自动、响应/放弃、选玩家、选牌、选数值和确认。`catalog/dependency-graph.json` 固定 233 个节点及 254 条内容边。
- 依赖标签用于 P04 生成高风险语义场景，不代表规则已经实现或验证。

## 验证命令

```powershell
npm run catalog:verify
npm run catalog:oracle-verify
npm audit --audit-level=moderate
```

结果：公开目录的严格 JSON Schema、稳定 ID、依赖引用、逐表行数、物理牌序号、人类报告和依赖图一致性通过；本地 C#/SQLite 重建与已提交目录字节一致；npm 审计为 0 个已知漏洞。

## 可复现更新

本机保留只读参考快照时运行：

```powershell
npm run catalog:refresh
```

该命令确定性生成 `catalog/catalog.json`、`catalog/report.md` 与 `catalog/dependency-graph.json`。公开克隆无需参考快照即可运行 `npm run catalog:verify`。
