# P10 第二次新鲜克隆失败

日期：2026-08-19

提交：`afb72c4ecb57f79b140b46a19507a8460df719e8`

第一处 Windows spawn 问题修复后，README 命令成功进入 `npm ci`，随后失败：

```text
npm error path ...\node_modules\better-sqlite3
npm error command ... node-gyp rebuild
npm error gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use
npm error gyp ERR! cwd ...\node_modules\better-sqlite3
npm error gyp ERR! node -v v22.14.0
```

分类：生产依赖的新鲜安装失败；未进入构建/测试，P10 保持红色。

调查：`better-sqlite3` v13.0.3 声明 Node ≥22，但官方 GitHub release 没有预编译资产，安装会回退到 node-gyp。本机没有 Visual Studio C++ workload。官方 v12.11.1 同时声明支持 Node 22，并发布 `better-sqlite3-v12.11.1-node-v127-win32-x64.tar.gz`，覆盖本机 Node 22.14 ABI 127。

修复：精确锁定 12.11.1，防止 caret 自动升级到没有预编译资产的 v13；不要求维护者额外安装 Visual Studio。架构事务 API 不变，并重新运行架构测试、完整检查和无 reference 新鲜克隆。
