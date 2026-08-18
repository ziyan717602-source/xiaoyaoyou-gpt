# P07 分层验证系统收据

日期：2026-08-19

## 完成内容

- 六条既有稳定命令加 `test:integration` 均有真实测试目标；`check:full` 串联构建、重放、Bot、集成和 E2E。
- fast-check 隐私属性与命令模型固定种子，失败信息写入忽略目录。
- 六类 Bot 共用 server-provided `availableActions` 形状，10,000 回合相同种子逐条一致。
- 六条真实 WebSocket 连接、临时 SQLite、命令幂等、越权同形拒绝、重连和服务重建通过。
- Playwright 六 BrowserContext、房间旅程、冰心诀、多人濒死、断联、重连、过期和手机操作通过。
- 可见浏览器以一名玩家加五 Bot 完成桌面/手机房间准备和选角；截图固定尺寸并纳入机器检查。
- 首次 E2E 定位器失败及附件保留缺陷均有记录，后续失败由持久 reporter 保存。
- push/PR 与 nightly GitHub Actions 已建立。

## 验证命令

```powershell
npm run verification:verify
npm run check:fast
npm run check:full
npm audit --audit-level=moderate
```

本节点证明验证基础设施可以发现并保存失败，不证明正式房间或完整规则已经实现。
