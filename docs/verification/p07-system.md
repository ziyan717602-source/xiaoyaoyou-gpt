# P07 分层验证系统

P07 建立八层验证：静态门禁、单元/属性、旧版黄金轨迹、技术探针重放、六类策略 Bot、真实 HTTP/WebSocket/SQLite、Playwright 六上下文和可见浏览器。

- fast-check 固定种子 `20260819`：200 轮随机秘密视图、500 轮可收缩命令序列。
- 六类 Bot：FirstLegal、AlwaysPass、CounterHappy、Rescue、SeededRandom、ProtocolChaos；长局为 10,000 回合。
- 集成层：真实随机端口 HTTP/WebSocket、六连接、临时 SQLite、原子命令收据、断线重连和关闭服务后重建。
- E2E：六个独立 BrowserContext；桌面复杂状态；360×800 断联/重连/过期/濒死；房间创建、入座、准备、选角由一名可见玩家和五 Bot 完成。
- Playwright 非预期结果由自定义 reporter 复制到 `artifacts/failures/p07-e2e/`，避免下一次运行清空；trace、截图、视频、控制台和失败请求同时保留。
- CI：push/PR 先跑 fast，再装 Chromium 跑 full；nightly 独立执行 Bot、集成和浏览器并上传失败产物。

房间旅程标注为 `verification-player-view`，用于证明测试编排和交互，不声称 M01 权威房间已经实现。

可见浏览器截图：

- `p07-desktop-room-ready.jpg`：`52F2A37E6E879F43B0E0AC910B4548DD4FA64E18875F6AA42A1B28D6F8F0A795`
- `p07-mobile-room-ready.jpg`：`0A7ADE138285A9EBB8CD4087BD9930417FC78E25FE0FC24600BC8ED34FCEB4C6`
