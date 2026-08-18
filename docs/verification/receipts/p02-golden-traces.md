# P02 三条黄金轨迹收据

日期：2026-08-19

## 产物

- `oracle/golden-traces/trace.schema.json`
- `oracle/golden-traces/basic-turn.trace.json`
- `oracle/golden-traces/bingxin-response.trace.json`
- `oracle/golden-traces/dying-rescue.trace.json`
- `scripts/legacy/replay-golden-traces.mjs`
- `docs/legacy-evidence/golden-traces.md`
- `docs/legacy-evidence/oracle-degradation.md`

## 验证

```powershell
npm run oracle:golden-traces
```

结果：基本回合 13 步、冰心诀响应 4 步、同时濒死/救援 14 步全部重放到逐字节一致的最终状态。目录内容 ID、证据索引、六人状态不变量和本地 C# 文件哈希均通过。

证据等级均为 B（源码派生归一化），原因和降级边界见 `oracle-degradation.md`。这完成 P02-07；P02-09 以正式降级报告关闭，不再修复无关 WPF 客户端。
