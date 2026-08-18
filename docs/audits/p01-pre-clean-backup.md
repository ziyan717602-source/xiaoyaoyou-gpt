# P01 历史清理前恢复点

- 创建时间：2026-08-18
- 旧公开候选分支：`main` @ `eb0cea597e5a82b8b62f320301e486fae5d1dd96`
- 旧基线标签：`baseline-0` @ `2f704d6b77c09d124e970fa505d6263544e40c48`
- 本地备份目录名：`pre-clean-20260818-234233`（位于仓库外的同级备份根目录）
- Git bundle：`xiaoyaoyou-before-public-clean.bundle`
- Bundle SHA-256：`7ffe2757b83b14e1fa56a540e6594d8340bfc76f39f475adadd695bba74f4bfb`
- Bundle 验证：`git bundle verify` 通过，记录完整历史。
- 提交清单 SHA-256：`30c6972bdbf9e39679f4f1ae5f17f0052a50c87c01bdb338d46a0e0acad628f8`
- 旧 LFS 清单：1,084 项；清单 SHA-256：`975757e32593f161beba2c4baf6f8ed9080d379cacf645c00047413d663f8f21`
- 本地参考目录：1,558 个文件；逐文件 SHA-256 清单摘要：`bac7716b30015a819e37d5fda0db8ea4060e890bdd2ae33338f3f2a1dde5d256`

恢复旧历史时必须从仓库外 bundle 创建独立克隆，不能覆盖当前干净公开历史。旧 LFS 对象和完整参考目录仅留在本机，不推送到公开远程。
