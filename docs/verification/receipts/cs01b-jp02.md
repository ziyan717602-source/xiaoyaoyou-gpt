# CS01B-JP02 窥测天机验证收据

日期：2026-08-28

状态：pass。

## 来源与实现

- 只读 C# `PSDGamepkg/JNS/JP06.cs:318-327`、`PSDGamepkg/XIG.cs:1645-1724`、`PSDBase/Utils/Rueue.cs:53-64`：主遭遇牌堆（怪物和 NPC）顶部最多两张；空堆不可用；两张可换序/放弃，单张直接发送查看结果并结束。
- 通过正式 `applyCommand`、响应链、领域事件和 `MatchService` 接入；不是独立模拟器。牌顶身份只存在权威事件日志和施放者私密历史中；公共效果帧不携带牌顶 ID。
- 两张选择 15 秒超时保持顺序；单张不新增确认等待。最后查看历史不实时追踪牌堆。schema v7→v8 不洗牌且不赋予任何玩家知识；旧版迁移保留牌堆及 RNG 语义。

## 直接行为证据

- `inspection.test.ts`：实际命令入口、空堆/错目标拒绝且不支付、怪物/NPC 混合查看、精确交换两张、单张不阻塞、五名非施放者无牌顶或选择、两个隐藏世界的非本人视图完全一致、历史知识不实时追踪牌堆、断联不延长 15 秒窗口、重连不重开已超时选择、超时/自动模式不消耗随机、越权/过期/伪造选择拒绝、冰心诀取消及反制恢复、56 张行动牌与 46 张遭遇牌守恒。
- `inspection.replay.test.ts`：40 组固定种子可收缩属性场景；每个响应/选择等待点 JSON 往返，逐命令结果及事件重放一致；保留/换序/超时终态一致；v7 升级及伪造事件拒绝。
- `reaction-lifecycle.integration.test.ts` 的独立 JP02 用例：真实 HTTP 建房、六连接选角，夹具仅安排初始手牌；真正出牌、逐席放弃、私密查看、越权拒绝、选择中 SQLite 服务重启、期限保持、六视图隔离、一次性换序、重复请求幂等及过期选择拒绝，最后直接核对持久化牌堆顺序。

## 失败与修正

- 首次红测 `artifacts/jp02-red.txt`：5 个新测试均失败，原因是 JP02 未开放正式动作；保留日志，不提交生成物。
- 专项首次迭代纠正测试超时命令遗漏的 matchId/expectedVersion；精确投影断言增加 `lastInspection: null`，未放宽隐私或守恒断言。

## 回归命令

- `npm run check:full`：格式、严格类型、历史隔离、合同、单元、构建、重放、Bot、真实网络、既有 Playwright 和六连接烟测全部通过。日志：`artifacts/jp02-check-full.txt`。
- `inspection.test.ts` 专项 7/7；`inspection.replay.test.ts` 3/3；真实网络 JP02 专项通过。完整重放 44/44、Bot 6/6、集成 19/19、既有浏览器场景 3/3。
- `npm run oracle:inventory`：1558 个只读参考文件与原清单一致，聚合校验值保持 `c32a3e5e72e2b15da2891b8a04fe6856c030ac61e15345b4b196afc4e8a2df30`。
- `git diff --check`：通过。提交后再执行 `goal:preflight`；其准备闸门通过也不等于最终 MVP 完成。

## 边界

JP02 规则完整不等于战斗或 M07 Web 完整。CS03 主战斗仍待接管真实回合，最终 GOAL_ACCEPTANCE 继续保持未通过。

回滚点：绿色提交 `feat(CS01B-JP02): add private encounter inspection and reorder`。
