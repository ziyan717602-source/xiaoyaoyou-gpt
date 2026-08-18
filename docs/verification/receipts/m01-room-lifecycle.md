# M01 房间生命周期收据

日期：2026-08-19

状态：pass

## 冻结范围

- 匿名建房、八位邀请码和固定六座位；无观战入口。
- `open → started → ended` 单向状态机；六人全准备且仅房主可开始。
- 256-bit 重连 token，明文不落库；HTTP Bearer 与 WebSocket 首帧认证。
- 房间版本并发控制和 `(roomId, commandId)` 持久化幂等收据。
- SQLite schema v2、WAL + FULL；重启保留房间并重置在线呈现。
- Origin allowlist、连接替换、HTTP/WS 限流、64 KiB 边界和停服竞态保护。

## 自动证据

```powershell
npm run rooms:verify
npm run check:fast
npm run check:full
npm audit --audit-level=moderate
```

最终结果：

- M01 契约 8/8；房间存储测试 3/3；真实 HTTP/WebSocket 测试 2/2。
- 正式编译入口使用内存数据库和随机端口实机启动；`/health` 为 `ok`，建房返回 `open`、1 个房主座位、8 位邀请码和 43 字符 token，随后优雅停止。
- 全仓库单元/属性 10/10、确定性重放 7/7、Bot 3/3、真实网络 3/3、Playwright 3/3；六连接架构烟测 6/6。
- 233 项目录、3 条旧版黄金轨迹、语义/UX/探针/验证系统/生产架构契约全部回归通过。
- `npm audit --audit-level=moderate` 为 0 vulnerability；准备审计 10/10。

开发中真实捕获并修复了停服竞态：WebSocket 的迟到 `close` 曾在 SQLite 关闭后写离线状态，Vitest 报告 7 个未处理异常。修复为停服门闩、数据库关闭顺序保护和有日志的异步 hook 错误边界；同一集成测试随后零后台异常通过。另一次契约验证器首次不能识别动态注册的 `start/end` 路由，修正验证逻辑后通过；产品路由和断言未放宽。

## 明确不声称

M01 尚不实现选角/组队、牌局回合、复杂响应、濒死、15 秒/60 秒语义和最终浏览器 UI；后续工作图节点不得因为房间网络已通而跳过这些验收。
