# xiaoyaoyou-gpt

将旧版 C# 联机桌游「逍遥游」迁移为云端权威服务端与 PC/手机浏览器客户端。

当前仓库处于 **零号里程碑：迁移基线**。目标不是逐行翻译旧代码，而是先建立可测试、可恢复、不会泄露私密信息的确定性规则引擎。

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
  docs/                既有分析资料，迁移时需按新基线复核
  psd48-master/        本地旧版 C# 参考实现；公开 Git 历史将排除此目录
```

## 验证仓库骨架

要求 Node.js 22 及 Git LFS。

```bash
npm install
npm run typecheck
npm test
npm run build
```

分别启动开发服务：

```bash
npm run dev:server
npm run dev:web
```

- 服务端健康检查：`http://localhost:3000/health`
- Web 客户端：`http://localhost:5173`

## 当前边界

- 尚未迁移正式卡牌与技能效果。
- 旧项目是行为参考，不直接作为生产服务端运行。
- 资源、角色、美术、音乐和旧代码的公开发布授权尚待确认，见 [NOTICE.md](NOTICE.md)。
- 基线入口见 [docs/migration-baseline/README.md](docs/migration-baseline/README.md)。
- 正式开发前的唯一总清单见 [PREPARATION_CHECKLIST.md](PREPARATION_CHECKLIST.md)。
- 未来无人值守 `/goal` 的执行边界见 [GOAL_CONTRACT.md](GOAL_CONTRACT.md)。
