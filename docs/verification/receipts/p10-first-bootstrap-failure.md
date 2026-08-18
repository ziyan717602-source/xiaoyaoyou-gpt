# P10 首次新鲜克隆失败

日期：2026-08-19

提交：`ef726aae9330d1a9c125a8b5b42529863f54f8da`

环境：从 GitHub HTTPS 使用 `--no-tags --branch codex/goal-mvp --single-branch` 克隆到新的 Windows 临时目录；克隆中没有 `reference/psd48-master`。

命令：

```powershell
node scripts/bootstrap-local.mjs --smoke
```

原始失败核心：

```text
Error: spawnSync npm.cmd EINVAL
errno: -4071
code: 'EINVAL'
syscall: 'spawnSync npm.cmd'
spawnargs: [ 'ci' ]
Node.js v22.14.0
```

分类：启动编排失败，尚未进入 `npm ci`，不是产品代码或测试断言失败。

原因：Windows Node `spawnSync` 不能按当前参数以 `shell:false` 直接启动 `npm.cmd`。

修复：统一调用 `npm`，仅在 Windows 设置 `shell:true`；仍严格依次执行 `npm ci`、`npm run check:full`，smoke 成功才退出 0。不得改成跳过安装/完整检查。
