# 验证收据：P02-ORACLE-TOOLCHAIN

- 节点：P02-04/05
- 日期：2026-08-19
- 结论：pass
- 允许范围：隔离引用程序集与 `PSDBase → PSDClientZero → PSDGamepkg` 最小子集

## 固定工具链

- .NET SDK：9.0.201；MSBuild 17.13.13。
- 引用程序集：`Microsoft.NETFramework.ReferenceAssemblies.net40` 1.0.3。
- NuGet content hash：`3ctXnCpHdoYJNH9ATfXKwckkkdHvHc1Xls12QB9kf1tjh3b+VzxtiwpkZN4GxOawakfH6CJAkqhlDKSiz6Ujbg==`。
- 包缓存：`tools/legacy-oracle/.packages/`，Git 忽略。
- 构建输出：`artifacts/oracle/`，Git 忽略。

## 验证

`npm run oracle:build` 以 locked mode 还原包，在构建前后分别运行参考快照校验，然后依次构建：

| 输出                | 本次 SHA-256                                                       |
| ------------------- | ------------------------------------------------------------------ |
| `Base.dll`          | `a48ce0613e1fd06353593b5e6065a013e0ba895d03bbf88aab4c272357634f48` |
| `PSDClientZero.exe` | `dc694017534ec0406b98eda91b8b1a22f6328ffc7292002b752124f9f3b471b0` |
| `PSDGamepkg.exe`    | `dbe4ddbeba38f4e686e9fe910536f40ceb6d1b0cc3db826a2eac28865cb3ca5e` |

构建前后聚合参考 SHA-256 均为 `c32a3e5e72e2b15da2891b8a04fe6856c030ac61e15345b4b196afc4e8a2df30`。没有构建或修复 WPF、PSDCenter、PSDDorm、PSDRisoLib、`sharpuil` 或 `Wangpengfei`。

PE 输出哈希是本次收据，不作为跨机器可重现构建承诺；真正的闸门是成功编译、固定依赖、输出存在以及旧参考构建前后无漂移。
