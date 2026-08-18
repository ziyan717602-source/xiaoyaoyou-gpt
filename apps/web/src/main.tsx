import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PROTOCOL_VERSION } from "@xiaoyaoyou/protocol";
import "./styles.css";

const boundaries = [
  ["规则内核", "显式效果栈、响应窗口与待选择状态"],
  ["云端服务", "权威房间、重连、版本校验与事件持久化"],
  ["浏览器", "只显示玩家视图并提交合法命令"],
] as const;

function App() {
  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">
          MIGRATION BASELINE · PROTOCOL {PROTOCOL_VERSION}
        </p>
        <h1>逍遥游 Online</h1>
        <p className="summary">
          六人桌游的云端迁移工程，从可恢复的复杂结算开始。
        </p>
        <span className="status">零号里程碑已初始化</span>
      </header>

      <section className="boundary-grid" aria-label="架构边界">
        {boundaries.map(([title, description], index) => (
          <article className="boundary-card" key={title}>
            <span>0{index + 1}</span>
            <h2>{title}</h2>
            <p>{description}</p>
          </article>
        ))}
      </section>

      <section className="next-step">
        <div>
          <p className="eyebrow">FIRST VERTICAL SLICE</p>
          <h2>出牌 → 冰心诀 → 伤害 → 濒死 → 救援 → 重连</h2>
        </div>
        <p>先证明最难的响应链能够测试、暂停和恢复，再扩展完整内容。</p>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Missing #root element.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
