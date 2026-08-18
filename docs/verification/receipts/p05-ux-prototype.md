# P05 桌面/手机交互原型收据

日期：2026-08-19

## 结论

- 用户旅程、信息优先级、桌面/手机布局、情境托盘、隐私边界和可访问性阈值已写入 `contracts/ux-prototype.contract.json`。
- React 原型只消费模拟 `player view + availableActions`，不在客户端推导合法牌或目标。
- 11 个可切换场景覆盖自己回合、单双目标、冰心诀、多人濒死、等待、断联、重连、过期、长内容和结算。
- 选牌/选目标为本地草稿，明确确认后才生成原型命令；Escape 可清空，Tab 焦点可见，可选窗口明确“本次放弃”和超时后果。
- 1366×768 与 360×800 共 22 个状态组合无页面级横向溢出；所有可见控件至少 44px，手机托盘始终可达。
- 三张固定尺寸 JPEG 截图由机器门禁检查格式与尺寸；浏览器操作轨迹和 6 个已关闭问题均已保存。
- 视觉采用 CSS、文字与抽象形状，没有复制旧项目或未核权图片资产。

## 验证命令

```powershell
npm run ux:verify
npm run typecheck
npm run build -w @xiaoyaoyou/web
npm run check:fast
npm audit --audit-level=moderate
```

可见浏览器的完整矩阵、操作轨迹、控制台结果和截图哈希见 [`docs/ux-prototype/browser-verification.md`](../../ux-prototype/browser-verification.md)。

## 边界

这是模拟状态的交互证明，不代表服务端已提供真实 `availableActions`，也不证明规则实现完成。P06 必须用相同窗口和续算合同完成三个可失败技术探针；大厅、选角和真实完整对局属于后续纵向切片。
