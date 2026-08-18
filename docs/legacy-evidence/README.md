# 旧 C# 证据清单

本目录只提交自行生成的相对来源位置、校验值、结构和数量，不复制旧源码、数据库、DLL 或素材。权威机器快照是 `inventory.json`，本机只读参考可用时运行：

```bash
npm run oracle:inventory
```

命令会重新计算全部证据并与快照逐字节比较；漂移时失败，不会自动覆盖旧证据。只有明确调查后才运行 `npm run oracle:refresh-inventory`。

## 快照结论

- 参考快照：1,558 个非生成文件，195,463,130 字节，聚合 SHA-256 为 `c32a3e5e72e2b15da2891b8a04fe6856c030ac61e15345b4b196afc4e8a2df30`。
- 分类：163 个源码/项目文件、1 个 SQLite 数据库、5 个 DLL、1,207 个图片、128 个音频、10 个文档和 44 个其它文件。
- 图片、音频、DLL、数据库和旧源码都只在本机参考目录；公开仓库只有本 JSON 元数据。

## 解决方案与构建边界

旧解决方案为 Visual Studio 2015 格式，声明 9 个项目；本地存在 7 个：

| 项目            | 输出    | Framework          | 直接项目依赖        |
| --------------- | ------- | ------------------ | ------------------- |
| `PSDBase`       | Library | .NET Framework 4.0 | 无                  |
| `PSDCenter`     | Exe     | .NET Framework 4.0 | Base                |
| `PSDClientAo`   | WinExe  | .NET Framework 4.0 | Base、PSDRisoLib    |
| `PSDClientZero` | Exe     | .NET Framework 4.0 | Base                |
| `PSDDorm`       | WinExe  | .NET Framework 4.0 | Base                |
| `PSDGamepkg`    | Exe     | .NET Framework 4.0 | Base、PSDClientZero |
| `PSDRisoLib`    | Library | .NET Framework 4.0 | 无                  |

解决方案声明但本地缺失 `sharpuil/sharpuil.csproj` 与 `Wangpengfei/Wangpengfei.csproj`。项目使用 x86 目标并引用本地 `Mono.Data.Sqlite`、`NAudio`、`NAudio.Vorbis`、`NVorbis` 和原生 `sqlite3`；其逐文件 SHA-256 位于机器快照。

当前主机只有 .NET SDK 9.0.201；`msbuild.exe` 不在 PATH，Visual Studio 安装查询没有返回实例，系统 .NET Framework 4.0 引用目录也只有中文 XML 资源而没有 `mscorlib.dll` 等引用程序集。仓库因此固定使用 NuGet `Microsoft.NETFramework.ReferenceAssemblies.net40` 1.0.3；内容哈希锁定在 `tools/legacy-oracle/packages.lock.json`，缓存与输出均被 Git 忽略。

运行 `npm run oracle:build` 会：

1. 以 locked mode 还原引用程序集；
2. 在构建前验证 1,558 文件参考快照；
3. 用 .NET SDK 附带的 MSBuild 按 `PSDBase → PSDClientZero → PSDGamepkg` 构建最小子集，所有输出和中间文件写入 `artifacts/oracle/`；
4. 构建后再次验证参考快照，证明旧目录没有漂移。

完整 WPF 客户端、资源项目、中心大厅和两个缺失项目均不属于此预言机构建路径。

## SQLite 只读快照

`~ex-lib/psd.db3` 为 206,848 字节。清单脚本使用只读连接并启用 `PRAGMA query_only=ON`，只读取 `sqlite_schema`、`PRAGMA table_info` 和行数：

| 表      | 行数 |
| ------- | ---: |
| Aas     |    8 |
| Eve     |   47 |
| Exsp    |   53 |
| Five    |    7 |
| Hero    |  123 |
| Monster |   67 |
| NJ      |   20 |
| Npc     |   97 |
| Ops     |    5 |
| Rune    |    8 |
| Skill   |  322 |
| Tux     |   68 |

每张表的列、类型、主键位置、默认值和 `CREATE TABLE` SQL 均保存在 `inventory.json`；没有提交任何数据行或描述文本。
