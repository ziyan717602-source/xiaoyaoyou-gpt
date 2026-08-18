# 旧 TCP 协议记录基线

## 传输帧

旧客户端和服务端不使用换行分隔。`PSDBase/VW/Helper.cs` 通过 .NET `BinaryWriter.Write(string)` / `BinaryReader.ReadString()` 传输：

1. UTF-8 字节长度，以 .NET 7-bit encoded integer 编码；
2. 紧随对应数量的 UTF-8 字节。

`scripts/legacy/protocol-smoke.mjs` 独立实现该帧，不链接旧 DLL。它启动隔离构建的 `PSDGamepkg.exe`，创建六个真实 TCP 连接，记录每个连接的客户端输入和服务端输出，然后按实际接收者集合区分 `broadcast` 与 `connection-specific`。原始轨迹写入被 Git 忽略的 `artifacts/oracle/protocol-smoke.json`。

运行入口：

```bash
npm run oracle:protocol-smoke
```

## 六连接握手证据

固定输入为六名 `Oracle1..6` 客户端依次发送 `C2CO`，收到 `C2SA` 后发送 `C2ST`。一次成功运行记录 62 个帧：

| 家族   | 方向              | 可见性/作用                |
| ------ | ----------------- | -------------------------- |
| `C2CO` | 客户端→服务端     | 单连接加入输入             |
| `C2CN` | 服务端→客户端     | 连接专属的预分配 UID       |
| `C2NW` | 服务端→已有客户端 | 连接专属的新人通知集合     |
| `C2RM` | 服务端→新客户端   | 连接专属的已有房间成员集合 |
| `C2SA` | 服务端→六连接     | 全员开始                   |
| `C2ST` | 客户端→服务端     | 单连接准备输入             |
| `H0SD` | 服务端→六连接     | 实际座次公开广播           |
| `H0SM` | 服务端→六连接     | 选角模式公开广播           |
| `H0SL` | 服务端→六连接     | 随机选角结果公开广播       |

来源边界：`PSDGamepkg/VW/Aywi.cs` 的 `Send` 只向一个连接，`BCast` 向全部玩家，`Focus` 向目标发送私密消息并向其余连接发送公开替代；`PSDClientZero/VW/Bywi.cs` 构造加入、准备和重连消息。

## 已证实的不确定性

同一进程构建、同一六个加入/准备输入连续运行两次，消息家族与握手语义一致，但：

- `H0SD` 的实际座次排列不同；
- `H0SL` 的随机角色分配不同；
- 调度造成第二次在截取点前多收到一个 `H0SN` 帧。

两份原始轨迹 SHA-256 分别为 `ca541958fcb24df87679bc4be3a682e07933252c9d154d7cdbb5367b696097f1` 与 `52d641c32e7aed9bc020e22d012f910fb4fd17246fe64482706305fa05630bbf`。它们留在本机失败/证据目录，不提交随机输出。

因此握手的帧格式、消息家族和可见性属于 B 级“源码+黑盒一致证据”；具体座次和角色结果不作为可重放 A 级黄金结果。新引擎必须用显式种子替代旧 `Random`/`Shuffle` 的墙钟不确定性。
