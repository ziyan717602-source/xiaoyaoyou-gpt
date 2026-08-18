# 标准包 + 凤鸣玉誓迁移目录报告

> 本文件由 `npm run catalog:refresh` 确定性生成。完整条目、来源哈希与依赖见 `catalog.json`。

- 规则集：`standard+fengmingyushi`
- 来源快照 SHA-256：`c32a3e5e72e2b15da2891b8a04fe6856c030ac61e15345b4b196afc4e8a2df30`
- 范围规则：旧版 level 4 启用包 1, 2；`VALID/COUNT` 决定纳入范围，`GENRE` 决定标准/凤鸣归属。
- 映射条目：233；C# 方法绑定：584；内容依赖：254。

## 按类型与归属统计

| 类型 | 总数 | 标准包 | 凤鸣玉誓 | 共享核心 |
| --- | ---: | ---: | ---: | ---: |
| card | 24 | 24 | 0 | 0 |
| configuration | 8 | 0 | 0 | 8 |
| event | 14 | 14 | 0 | 0 |
| five-element | 7 | 0 | 0 | 7 |
| hero | 34 | 26 | 8 | 0 |
| monster | 20 | 20 | 0 | 0 |
| npc | 26 | 26 | 0 | 0 |
| npc-action | 9 | 9 | 0 | 0 |
| operation | 5 | 0 | 0 | 5 |
| rune | 8 | 0 | 0 | 8 |
| skill | 76 | 57 | 19 | 0 |
| special-card | 2 | 1 | 1 | 0 |
| **合计** | **233** | **177** | **28** | **28** |

## 34 名范围角色（旧 scope.md 对账）

| 归属 | 数量 | 角色 |
| --- | ---: | --- |
| standard | 26 | 南宫煌、温慧、星璇、王蓬絮、李逍遥、赵灵儿、赵灵儿·梦蛇、林月如、阿奴、酒剑仙、拜月教主、王小虎、苏媚、沈欺霜、孔璘、魔尊、唐雪见、紫萱、重楼、云天河、韩菱纱、柳梦璃、慕容紫英、玄霄、龙幽、小蛮 |
| fengmingyushi | 8 | 龙葵·蓝、龙葵·红、姜云凡、唐雨柔、姜世离、魔翳、湮世穹兵、欧阳慧 |

## 12 张 SQLite 表逐表对账

| 表 | 总行数 | 纳入 | 排除 | 选择规则 |
| --- | ---: | ---: | ---: | --- |
| Aas | 8 | 8 | 0 | all rows; shared runtime card-set configuration |
| Hero | 123 | 34 | 89 | first integer in VALID is legacy package 1 or 2 |
| Skill | 322 | 76 | 246 | referenced by selected Hero.SKILL or selected Exsp.SKILL |
| Tux | 68 | 24 | 44 | COUNT triplet package id is 1 or 2; serial range retained |
| Exsp | 53 | 2 | 51 | HERO references a selected standard or fengmingyushi hero |
| Monster | 67 | 20 | 47 | VALID is legacy package 1 or 2 |
| Npc | 97 | 26 | 71 | VALID is legacy package 1 or 2 |
| NJ | 20 | 9 | 11 | referenced by selected Npc.ACTION |
| Eve | 47 | 14 | 33 | VALID is legacy package 1 or 2 |
| Rune | 8 | 8 | 0 | all rows; no package column, provisionally shared core |
| Five | 7 | 7 | 0 | all rows; no package column, provisionally shared core |
| Ops | 5 | 5 | 0 | all rows; no package column, provisionally shared core |

## 差异与临时决定

- **CAT-001 · provisional-autonomous**：Global, training, and out-of-scope-hero Exsp rows have no package column. Include only Exsp rows whose HERO points to a selected package-1 or package-2 hero; keep the remainder excluded until scenario evidence requires one.
- **CAT-002 · provisional-autonomous**：Rune, Five, Ops, and Aas have no legacy package ownership column. Treat these runtime rule/configuration rows as shared core and verify their actual dependencies during P04 semantics work.
- **CAT-003 · resolved**：VALID/COUNT and GENRE encode different package concerns and cannot substitute for each other. Use Card.Level2Pkg plus VALID/COUNT for enabled scope, then GENRE 1/2 for standard/fengmingyushi product ownership as shown by the old package UI.
- **CAT-004 · resolved**：The prior scope.md calls the two fengmingyushi forms 龙葵 and 龙葵鬼, while the database calls them 龙葵·蓝 and 龙葵·红. Use database names as canonical display names and retain the scope.md names as searchable aliases.

## 当前证据边界

- 证据 A（数据库行 + 专用 C# 方法绑定）：151 项；证据 B（数据库行，暂无专用方法）：82 项。
- 结算原语、隐藏信息与 UI 选择仍标记为 `unclassified/unknown`；这是 P03 后续依赖分类工作，不以空白冒充完成。
- 公开仓库只保留描述列 SHA-256、表/列定位和 C# 符号，不复制本地参考包的完整规则文本或二进制资源。
