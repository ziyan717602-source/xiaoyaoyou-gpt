import { useState } from "react";

type JourneyPhase = "create" | "seat" | "ready" | "hero" | "started";
interface JourneyAction {
  readonly id: string;
  readonly label: string;
  readonly next: JourneyPhase;
}

const actionsByPhase: Readonly<Record<JourneyPhase, readonly JourneyAction[]>> =
  {
    create: [{ id: "create-room", label: "创建六人房间", next: "seat" }],
    seat: [{ id: "take-seat", label: "坐入 1 席", next: "ready" }],
    ready: [{ id: "ready", label: "准备", next: "hero" }],
    hero: [{ id: "choose-hero", label: "选择李逍遥并开始", next: "started" }],
    started: [],
  };
const botNames = [
  "FirstLegalBot",
  "AlwaysPassBot",
  "CounterHappyBot",
  "RescueBot",
  "SeededRandomBot",
];

export function RoomJourney() {
  const [phase, setPhase] = useState<JourneyPhase>("create");
  const created = phase !== "create";
  const seated = phase !== "create" && phase !== "seat";
  const ready = phase === "hero" || phase === "started";
  const started = phase === "started";
  const availableActions = actionsByPhase[phase];
  return (
    <main className="journey-shell" data-source="verification-player-view">
      <header className="journey-header">
        <div>
          <span className="brand-seal" aria-hidden="true">
            逍
          </span>
          <div>
            <strong>六人房间验证</strong>
            <p>一名可见玩家 · 五名策略 Bot</p>
          </div>
        </div>
        <span className="journey-badge">标准包 + 凤鸣玉誓</span>
      </header>
      <section className="journey-focus" aria-live="polite">
        <p className="overline">房间旅程 · {phase}</p>
        <h1>
          {started
            ? "六人已准备，可以进入对局"
            : created
              ? "房间 XYY-TEST 已创建"
              : "创建一个本地六人房间"}
        </h1>
        <p>
          {started
            ? "浏览器流程已到达对局入口；真实房间状态将在 M01 由权威服务端提供。"
            : "此页面只消费 verification player-view 中的 availableActions，用于验证大厅交互和五 Bot 编排。"}
        </p>
      </section>
      {created ? (
        <section className="journey-seats" aria-label="六个座位">
          <article className={`journey-seat${seated ? " is-ready" : ""}`}>
            <strong>1 席 · 你</strong>
            <span>
              {!seated
                ? "等待入座"
                : ready
                  ? "已准备 · 李逍遥"
                  : "已入座 · 未准备"}
            </span>
          </article>
          {botNames.map((name, index) => (
            <article
              className={`journey-seat is-bot${ready ? " is-ready" : ""}`}
              key={name}
            >
              <strong>{index + 2} 席 · 策略 Bot</strong>
              <span>{ready ? `已准备 · ${name}` : `已入座 · ${name}`}</span>
            </article>
          ))}
        </section>
      ) : null}
      <section className="journey-actions" aria-label="可用房间操作">
        <div>
          <span>availableActions</span>
          <strong>
            {availableActions.length ? "请选择下一步" : "房间旅程完成"}
          </strong>
        </div>
        {availableActions.map((action) => (
          <button
            type="button"
            key={action.id}
            onClick={() => setPhase(action.next)}
          >
            {action.label}
          </button>
        ))}
      </section>
    </main>
  );
}
