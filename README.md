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

M01 无界面房间服务使用 `npm run dev:rooms` 启动，默认监听 `127.0.0.1:3001` 并写入 `.local/rooms.sqlite`。可通过 `PORT`、`HOST`、`DATABASE_PATH` 和逗号分隔的 `ALLOWED_ORIGINS` 覆盖；接口和状态语义见 [M01 房间生命周期](docs/room-lifecycle/m01-room-lifecycle.md)。它是后续 Web 客户端的真实房间 API，目前不代表完整牌局可玩。

同一服务已接入 M02 的真实六人选角与确定性开局，以及 M03 的确定性回合核心：全员准备开始后，客户端通过 WebSocket 的 `availableActions` 选角、出牌、结束行动和按上限弃牌，支持中途服务重启恢复。开局规则见 [M02 确定性选角与开局](docs/setup/m02-seeded-setup.md)，回合/卡区/鼠儿果/武器防具/基础胜负见 [M03 确定性回合核心](docs/turn-core/m03-turn-core.md)。

常用分层验证命令：`npm run check:fast`、`npm run check:full`、`npm run test:replay`、`npm run test:bots`、`npm run test:e2e`。

## 当前边界

- 已迁移鼠儿果与标准武器/防具的基础动作；其余卡牌、角色技能、响应、伤害、濒死和超时仍按后续节点迁移，未完成内容不会伪装成无效果卡。
- 旧项目是行为参考，不直接作为生产服务端运行。
- 资源、角色、美术、音乐和旧代码的公开发布授权尚待确认，见 [NOTICE.md](NOTICE.md)。
- 基线入口见 [docs/migration-baseline/README.md](docs/migration-baseline/README.md)。
- 正式开发前的唯一总清单见 [PREPARATION_CHECKLIST.md](PREPARATION_CHECKLIST.md)。
- 未来无人值守 `/goal` 的执行边界见 [GOAL_CONTRACT.md](GOAL_CONTRACT.md)。
