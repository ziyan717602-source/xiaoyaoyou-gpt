# ADR-0004：生产运行时与持久化栈

- 状态：P08 接受
- 日期：2026-08-19

## 背景

P06/P07 已证明显式等待点、六投影、幂等、重启恢复和真实 WebSocket/SQLite 集成可行。P08 需要把探针用的临时库升级为维护者可以长期执行的生产边界，同时保持本地优先、以后再部署云端。

## 决策

- Node.js 22、Fastify 5、`@fastify/websocket` 11；HTTP 与 WebSocket 共享生命周期和 Pino 日志。
- 跨进程输入使用 JSON Schema Draft 7 子集和 Ajv 8。Schema 位于 `packages/protocol`，输入必须先通过运行时校验。TypeScript 类型不代替运行时校验。
- 当前 MVP 使用精确锁定的 `better-sqlite3` 12.11.1、SQLite WAL 和 `synchronous=FULL`，直接写显式 SQL，不引入 ORM。该官方 release 明确提供 Node ABI v127（Node 22）Windows x64 预编译资产；不使用缺少该资产、会回退到本机 C++ 编译的 v13.0.3。
- 当前只允许运行一个应用实例；一个进程内每局只有一个 Actor。首次云部署也必须是带持久卷的单实例，直到触发重评。
- Prometheus 文本指标使用 `prom-client`，结构化日志使用 Fastify 内置 Pino。

Fastify 5 支持 Node 20+、完整 JSON Schema 和内置 Pino，WebSocket 插件复用其连接前 hooks 与关闭生命周期。Node 22 的 `node:sqlite` 仍标为 Active development/Experimental，所以只保留在历史探针，不作为生产 API。`better-sqlite3` 提供同步事务与 Node LTS 预编译；同步调用与每局串行 Actor 的一致性模型相符。

官方依据：

- [Fastify 首页与 v5 支持范围](https://fastify.dev/)
- [Fastify v5 迁移指南](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/)
- [`@fastify/websocket` 生命周期](https://github.com/fastify/fastify-websocket/blob/master/README.md)
- [Node 22 `node:sqlite` 稳定性](https://nodejs.org/docs/latest-v22.x/api/sqlite.html)
- [`better-sqlite3` 支持与事务](https://github.com/WiseLibs/better-sqlite3/blob/master/README.md)

## 被拒绝的方案

- 原生 `node:http` + `ws`：探针可用，但认证、Schema、日志、关闭和错误生命周期会被拆散。
- Socket.IO：重连便利不足以抵消另一套消息协议和客户端依赖；本项目需要可审计的自有包络。
- NestJS：依赖注入和模块抽象不能降低规则状态机难度，当前增加的间接层超过收益。
- `node:sqlite`：Node 22 中仍为实验 API。
- ORM：事件追加、序列检查、哈希链和原子收据都需要明确 SQL；ORM 不减少关键风险。
- 现在直接用 PostgreSQL：会让本地一条命令依赖额外服务；在单实例六人 MVP 阶段没有证据证明必要。
- Redis/消息队列：没有多实例 Actor 所有权问题前不引入。
- TypeBox 1.x：当前面向 TypeScript 6/7，而仓库仍在 TypeScript 5.8；不为 Schema builder 升级整个编译器。

## 重评触发器

出现任一条件必须写新 ADR，不允许直接换库：

1. 应用将运行两个或更多实例；
2. 云平台无法提供单实例持久卷；
3. 压测证明 SQLite 写竞争或同步调用使服务级目标失败；
4. 要求零停机迁移、跨区域或外部分析读取；
5. TypeScript 升级后准备重新评估 Schema 单源生成。

触发 1 或 2 时，优先评估 PostgreSQL 事件存储和数据库租约；迁移完成前不得横向扩容。
