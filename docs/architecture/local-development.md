# 本地六人架构环境

前置：Node.js 22+、npm 10+。不需要 Docker、云数据库、账号或 `.env`。

```powershell
npm install
npm run dev:local
```

该命令构建工作区并启动：

- `127.0.0.1:3000` Fastify HTTP/WebSocket；
- `.local/xiaoyaoyou.sqlite` WAL/FULL 本地数据库；
- 一个标为 `local-architecture-six` 的六座位架构 fixture；
- 六个独立 WebSocket 验证 Bot，均完成首帧重连认证并收到自己的投影；
- 当前响应式 Web 构建，由同一服务提供。

终端会显示页面 URL 和仅本机可用的 `/dev/local-seats`。这些固定 token 只在 `local.ts` 本地入口生效；普通服务入口没有该端点，也不会接受它们。

自动烟测：

```powershell
npm run architecture:smoke
```

烟测使用内存数据库和随机端口，验证构建、HTTP health、静态页面、六个真实 WebSocket 连接、认证和六份玩家视图，然后优雅退出。

这是 P08 架构 fixture，不是 M01 房间实现，也不代表已能开始真实对局。M01 会把建房、随机 token、座位、准备和持久恢复接入相同端口。
