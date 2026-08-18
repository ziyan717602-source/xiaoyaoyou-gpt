# xiaoyaoyou-gpt

将旧版 C# 联机桌游「逍遥游」迁移为云端权威服务端与 PC/手机浏览器客户端。

当前仓库已完成迁移准备基线，正式实现仍按 `PLAN.md` 的可验证节点推进。目标不是逐行翻译旧代码，而是建立可测试、可恢复、不会泄露私密信息的确定性规则引擎。

## 仓库结构

```text
apps/
  server/       云端 HTTP/WebSocket 服务骨架
  web/          React 响应式浏览器客户端骨架
packages/
  engine/       无网络、无 UI 的确定性规则内核
  protocol/     客户端与服务端共享协议
docs/
  migration-baseline/  迁移基线与验收场景
  adr/                 架构决策记录
reference/
  psd48-master/        可选的本地旧版 C# 参考实现；公开 Git 历史永久排除此目录
```

## 全新克隆一条命令验证并启动

要求 Node.js 22 与 npm 10；不需要旧 C# reference、Docker、云资源或 `.env`。从公开仓库全新克隆后运行：

```bash
node scripts/bootstrap-local.mjs
```

该命令依次执行锁文件安装、完整构建与测试、六连接本地烟测，然后在 `127.0.0.1:3000` 启动本地六人架构环境。只做一次可退出的全流程验证时使用：

```bash
node scripts/bootstrap-local.mjs --smoke
```

已安装依赖的日常开发可直接运行 `npm run dev:local`；服务端健康检查为 `http://127.0.0.1:3000/health`。当前本地六人入口是 P08 架构 fixture，不是已经可完整游玩的 M01 房间。

常用分层验证命令：`npm run check:fast`、`npm run check:full`、`npm run test:replay`、`npm run test:bots`、`npm run test:e2e`。

## 当前边界

- 尚未迁移正式卡牌与技能效果。
- 旧项目是行为参考，不直接作为生产服务端运行。
- 资源、角色、美术、音乐和旧代码的公开发布授权尚待确认，见 [NOTICE.md](NOTICE.md)。
- 基线入口见 [docs/migration-baseline/README.md](docs/migration-baseline/README.md)。
- 正式开发前的唯一总清单见 [PREPARATION_CHECKLIST.md](PREPARATION_CHECKLIST.md)。
- 未来无人值守 `/goal` 的执行边界见 [GOAL_CONTRACT.md](GOAL_CONTRACT.md)。
