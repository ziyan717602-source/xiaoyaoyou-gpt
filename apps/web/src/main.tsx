import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";

type ScenarioId =
  | "own-turn"
  | "single-target"
  | "multi-target"
  | "bingxin-response"
  | "multi-dying"
  | "waiting"
  | "disconnected"
  | "reconnecting"
  | "expired-action"
  | "long-content"
  | "settlement";

type Team = "蜀山" | "幻暝";

interface PlayerSummary {
  readonly id: string;
  readonly seat: number;
  readonly name: string;
  readonly hero: string;
  readonly team: Team;
  readonly hp: number;
  readonly maxHp: number;
  readonly handCount: number;
  readonly equipment: readonly string[];
  readonly status?: string;
}

interface HandCard {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly cost: string;
  readonly description: string;
  readonly playable: boolean;
}

interface AvailableAction {
  readonly id: string;
  readonly kind: "play-card" | "pass";
  readonly cardId?: string;
  readonly label: string;
  readonly targetIds?: readonly string[];
  readonly minSelections?: number;
  readonly maxSelections?: number;
}

interface MockPlayerView {
  readonly scenarioId: ScenarioId;
  readonly roomCode: string;
  readonly round: number;
  readonly phase: string;
  readonly secondsLeft: number;
  readonly kicker: string;
  readonly title: string;
  readonly description: string;
  readonly timeoutConsequence: string;
  readonly effectNodes: readonly string[];
  readonly connection: "online" | "disconnected" | "reconnecting";
  readonly interaction: "active" | "waiting" | "expired" | "settled";
  readonly players: readonly PlayerSummary[];
  readonly hand: readonly HandCard[];
  readonly availableActions: readonly AvailableAction[];
}

const scenarioLabels: Readonly<Record<ScenarioId, string>> = {
  "own-turn": "自己回合",
  "single-target": "选择单目标",
  "multi-target": "选择多目标",
  "bingxin-response": "冰心诀响应",
  "multi-dying": "多人濒死",
  waiting: "等待他人",
  disconnected: "连接中断",
  reconnecting: "正在重连",
  "expired-action": "操作已过期",
  "long-content": "长文本与大量手牌",
  settlement: "对局结算",
};

const players: readonly PlayerSummary[] = [
  {
    id: "p1",
    seat: 1,
    name: "青石",
    hero: "李逍遥",
    team: "蜀山",
    hp: 3,
    maxHp: 4,
    handCount: 5,
    equipment: ["无尘剑"],
    status: "行动中",
  },
  {
    id: "p2",
    seat: 2,
    name: "云舟",
    hero: "柳梦璃",
    team: "幻暝",
    hp: 3,
    maxHp: 3,
    handCount: 4,
    equipment: ["玉柄龙吟"],
  },
  {
    id: "p3",
    seat: 3,
    name: "照夜",
    hero: "景天",
    team: "蜀山",
    hp: 2,
    maxHp: 4,
    handCount: 2,
    equipment: [],
  },
  {
    id: "p4",
    seat: 4,
    name: "兰因",
    hero: "玄霄",
    team: "幻暝",
    hp: 4,
    maxHp: 4,
    handCount: 6,
    equipment: ["凝冰剑"],
  },
  {
    id: "p5",
    seat: 5,
    name: "砚秋",
    hero: "赵灵儿",
    team: "蜀山",
    hp: 2,
    maxHp: 3,
    handCount: 3,
    equipment: ["圣灵珠"],
  },
  {
    id: "p6",
    seat: 6,
    name: "长川",
    hero: "重楼",
    team: "幻暝",
    hp: 5,
    maxHp: 5,
    handCount: 4,
    equipment: [],
  },
];

const hand: readonly HandCard[] = [
  {
    id: "TP01-17",
    name: "灵力爆发",
    kind: "技牌",
    cost: "灵力 1",
    description: "对一名其他角色造成 1 点伤害。",
    playable: true,
  },
  {
    id: "JP01-04",
    name: "冰心诀",
    kind: "技牌",
    cost: "弃置此牌",
    description: "响应一个可取消的效果，令其取消。",
    playable: false,
  },
  {
    id: "TP05-09",
    name: "妙手回春",
    kind: "技牌",
    cost: "灵力 1",
    description: "令一名角色恢复 1 点体力。",
    playable: true,
  },
  {
    id: "ZP03-02",
    name: "天雷破",
    kind: "战牌",
    cost: "战力 2",
    description: "本次战斗中你的战力增加 2。",
    playable: false,
  },
  {
    id: "TP08-11",
    name: "御剑术",
    kind: "技牌",
    cost: "灵力 1",
    description: "选择一名角色，查看其一张随机手牌。",
    playable: true,
  },
];

const mockView: MockPlayerView = {
  scenarioId: "own-turn",
  roomCode: "XYY-7K2F",
  round: 4,
  phase: "行动阶段",
  secondsLeft: 12,
  kicker: "现在轮到你",
  title: "选择一张牌开始行动",
  description:
    "可用牌已点亮。先选择卡牌，再确认目标；任何选择在确认前都不会提交。",
  timeoutConsequence: "秒后自动结束行动",
  effectNodes: ["回合开始", "等待你的行动"],
  connection: "online",
  interaction: "active",
  players,
  hand,
  availableActions: [
    {
      id: "act-1",
      kind: "play-card",
      cardId: "TP01-17",
      label: "使用灵力爆发",
      targetIds: ["p2", "p3", "p4", "p5", "p6"],
      minSelections: 1,
      maxSelections: 1,
    },
    {
      id: "act-2",
      kind: "play-card",
      cardId: "TP05-09",
      label: "使用妙手回春",
      targetIds: ["p1", "p2", "p3", "p4", "p5", "p6"],
      minSelections: 1,
      maxSelections: 1,
    },
    {
      id: "act-3",
      kind: "play-card",
      cardId: "TP08-11",
      label: "使用御剑术",
      targetIds: ["p2", "p3", "p4", "p5", "p6"],
      minSelections: 1,
      maxSelections: 1,
    },
    { id: "act-4", kind: "pass", label: "结束行动阶段" },
  ],
};

function playAction(
  id: string,
  cardId: string,
  label: string,
  targetIds: readonly string[],
  selections = 1,
): AvailableAction {
  return {
    id,
    kind: "play-card",
    cardId,
    label,
    targetIds,
    minSelections: selections,
    maxSelections: selections,
  };
}

const passAction = (id: string, label: string): AvailableAction => ({
  id,
  kind: "pass",
  label,
});

const longHand: readonly HandCard[] = [
  ...hand,
  ...hand,
  ...hand.slice(0, 4),
].map((card, index) => ({ ...card, id: `${card.id}-long-${index}` }));

const scenarioViews: Readonly<Record<ScenarioId, MockPlayerView>> = {
  "own-turn": mockView,
  "single-target": {
    ...mockView,
    scenarioId: "single-target",
    secondsLeft: 9,
    kicker: "请选择目标",
    title: "灵力爆发需要 1 名目标",
    description: "只有带有“可选目标”标记的角色能被选择；确认前可重新选择。",
    timeoutConsequence: "秒后自动放弃本次出牌",
    effectNodes: ["李逍遥使用灵力爆发", "选择 1 名目标"],
    availableActions: [
      playAction("single", "TP01-17", "使用灵力爆发", [
        "p2",
        "p3",
        "p4",
        "p5",
        "p6",
      ]),
      passAction("pass-single", "放弃本次出牌"),
    ],
  },
  "multi-target": {
    ...mockView,
    scenarioId: "multi-target",
    secondsLeft: 11,
    kicker: "请选择多个目标",
    title: "五气朝元需要 2 名不同角色",
    description: "已选数量始终可见；选满两名后仍需明确确认，避免触控误交。",
    timeoutConsequence: "秒后自动放弃本次出牌",
    effectNodes: ["五气朝元", "选择 2 名目标"],
    availableActions: [
      playAction(
        "multi",
        "TP05-09",
        "使用五气朝元",
        ["p1", "p2", "p3", "p4", "p5"],
        2,
      ),
      passAction("pass-multi", "放弃本次出牌"),
    ],
  },
  "bingxin-response": {
    ...mockView,
    scenarioId: "bingxin-response",
    phase: "响应窗口",
    secondsLeft: 8,
    kicker: "你可以响应",
    title: "是否以【冰心诀】取消该效果？",
    description:
      "冰心诀准确指向当前效果实例。放弃只对本次响应窗有效，不会跳过之后的响应。",
    timeoutConsequence: "秒后自动放弃本次响应",
    effectNodes: ["玄霄使用天雷破", "等待响应", "可使用冰心诀"],
    availableActions: [
      playAction("bingxin", "JP01-04", "使用冰心诀", [], 0),
      passAction("pass-bingxin", "本次放弃"),
    ],
  },
  "multi-dying": {
    ...mockView,
    scenarioId: "multi-dying",
    phase: "救援结算",
    secondsLeft: 10,
    kicker: "全局濒死 · 当前救援对象",
    title: "先救援 3 席 景天",
    description:
      "5 席赵灵儿也处于濒死队列，但必须等待当前对象完成救援或死亡结算。",
    timeoutConsequence: "秒后自动放弃对景天的救援",
    effectNodes: ["伤害批次完成", "景天濒死（当前）", "赵灵儿濒死（排队）"],
    players: players.map((player) =>
      player.id === "p3"
        ? { ...player, hp: 0, status: "濒死 · 当前" }
        : player.id === "p5"
          ? { ...player, hp: 0, status: "濒死 · 排队" }
          : player,
    ),
    availableActions: [
      playAction("rescue", "TP05-09", "对景天使用妙手回春", ["p3"]),
      passAction("pass-rescue", "本次放弃救援"),
    ],
  },
  waiting: {
    ...mockView,
    scenarioId: "waiting",
    phase: "响应窗口",
    secondsLeft: 0,
    kicker: "当前无需操作",
    title: "等待其他玩家响应",
    description:
      "为保护私密信息，界面不会提示具体哪位玩家拥有响应牌或可执行动作。",
    timeoutConsequence: "",
    effectNodes: ["你已放弃本次响应", "等待其他玩家"],
    interaction: "waiting",
    availableActions: [],
  },
  disconnected: {
    ...mockView,
    scenarioId: "disconnected",
    secondsLeft: 6,
    kicker: "连接已中断",
    title: "当前操作计时仍在继续",
    description:
      "系统正在重连。断联不会把当前 15 秒重置为 60 秒；到期后将按本动作默认策略处理。",
    timeoutConsequence: "秒后自动结束行动",
    connection: "disconnected",
    interaction: "waiting",
    availableActions: [],
  },
  reconnecting: {
    ...mockView,
    scenarioId: "reconnecting",
    secondsLeft: 4,
    kicker: "正在恢复你的座位",
    title: "同步最新玩家视图…",
    description: "重连完成后只恢复仍然开放的窗口；已过期动作不会重新出现。",
    timeoutConsequence: "秒后当前窗口到期",
    connection: "reconnecting",
    interaction: "waiting",
    availableActions: [],
  },
  "expired-action": {
    ...mockView,
    scenarioId: "expired-action",
    secondsLeft: 0,
    kicker: "操作已过期",
    title: "服务端已推进到新的结算状态",
    description:
      "旧卡牌、目标和确认按钮均已禁用。请以当前玩家视图为准，不会重复提交旧命令。",
    timeoutConsequence: "",
    effectNodes: ["窗口已关闭", "正在获取最新状态"],
    interaction: "expired",
    availableActions: [],
  },
  "long-content": {
    ...mockView,
    scenarioId: "long-content",
    secondsLeft: 14,
    kicker: "压力状态 · 长说明与大量手牌",
    title: "选择一张牌；完整说明仍可滚动查看",
    description:
      "此状态用于确认十四张手牌、长角色名、多个装备和说明文字不会遮住倒计时、选择反馈或最终确认。",
    timeoutConsequence: "秒后自动结束行动",
    hand: longHand,
    availableActions: longHand
      .filter((card) => card.playable)
      .map((card, index) =>
        playAction(`long-${index}`, card.id, `使用${card.name}`, [
          "p2",
          "p3",
          "p4",
          "p5",
          "p6",
        ]),
      ),
  },
  settlement: {
    ...mockView,
    scenarioId: "settlement",
    phase: "对局结束",
    secondsLeft: 0,
    kicker: "对局已结束",
    title: "蜀山阵营获胜",
    description:
      "完成死亡后效果和队伍重算后，蜀山阵营仍有两名角色存活。对局状态已锁定。",
    timeoutConsequence: "",
    effectNodes: ["重楼死亡", "胜负重算", "蜀山阵营获胜"],
    interaction: "settled",
    availableActions: [],
  },
};

function TeamMark({ team }: { readonly team: Team }) {
  return <span className={`team-mark team-${team}`}>{team.slice(0, 1)}</span>;
}

function PlayerSeat({
  player,
  self = false,
  targetable = false,
  selected = false,
  onSelect,
}: {
  readonly player: PlayerSummary;
  readonly self?: boolean;
  readonly targetable?: boolean;
  readonly selected?: boolean;
  readonly onSelect?: () => void;
}) {
  const className = `player-seat${self ? " is-self" : ""}${targetable ? " is-targetable" : ""}${selected ? " is-selected-target" : ""}${player.hp === 0 ? " is-dying" : ""}`;
  const content = (
    <>
      <div className="seat-avatar" aria-hidden="true">
        {player.hero.slice(0, 1)}
      </div>
      <div className="seat-copy">
        <div className="seat-heading">
          <TeamMark team={player.team} />
          <strong>{player.hero}</strong>
          <span className="seat-number">{player.seat}席</span>
        </div>
        <p>
          {player.name}
          {self ? " · 你" : ""}
        </p>
        <div className="seat-metrics">
          <span aria-label={`体力 ${player.hp}/${player.maxHp}`}>
            体 {player.hp}/{player.maxHp}
          </span>
          <span aria-label={`${player.handCount} 张手牌`}>
            手 {player.handCount}
          </span>
          <span>{player.equipment[0] ?? "无装备"}</span>
        </div>
      </div>
      {player.status ? (
        <span className="seat-status">{player.status}</span>
      ) : null}
      {targetable ? (
        <span className="target-hint">{selected ? "已选择" : "可选目标"}</span>
      ) : null}
    </>
  );

  if (targetable) {
    return (
      <button
        className={className}
        type="button"
        aria-label={`${player.hero}，可选目标`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        {content}
      </button>
    );
  }
  return (
    <article
      className={className}
      aria-label={`${player.hero}，${player.team}阵营`}
    >
      {content}
    </article>
  );
}

function CardButton({
  card,
  selected,
  playable,
  onSelect,
}: {
  readonly card: HandCard;
  readonly selected: boolean;
  readonly playable: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      className={`hand-card${selected ? " is-selected" : ""}`}
      type="button"
      disabled={!playable}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="card-kind">{card.kind}</span>
      <strong>{card.name}</strong>
      <span className="card-description">{card.description}</span>
      <span className="card-cost">{card.cost}</span>
      {!playable ? <span className="card-lock">当前不可用</span> : null}
    </button>
  );
}

function App() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>("own-turn");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedTargetIds, setSelectedTargetIds] = useState<readonly string[]>(
    [],
  );
  const [notice, setNotice] = useState<string | null>(null);
  const view = scenarioViews[scenarioId];
  const selectedCard =
    view.hand.find((card) => card.id === selectedCardId) ?? null;
  const selectedAction = view.availableActions.find(
    (action) => action.kind === "play-card" && action.cardId === selectedCardId,
  );
  const pass = view.availableActions.find((action) => action.kind === "pass");
  const minimum = selectedAction?.minSelections ?? 0;
  const maximum = selectedAction?.maxSelections ?? 0;
  const canConfirm =
    selectedAction !== undefined &&
    selectedTargetIds.length >= minimum &&
    selectedTargetIds.length <= maximum;

  useEffect(() => {
    setSelectedCardId(null);
    setSelectedTargetIds([]);
    setNotice(null);
  }, [scenarioId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedCardId(null);
        setSelectedTargetIds([]);
        setNotice("已清除尚未提交的选择");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function chooseCard(cardId: string) {
    setSelectedCardId((current) => (current === cardId ? null : cardId));
    setSelectedTargetIds([]);
    setNotice(null);
  }

  function chooseTarget(playerId: string) {
    if (
      selectedAction === undefined ||
      !selectedAction.targetIds?.includes(playerId)
    )
      return;
    setSelectedTargetIds((current) => {
      if (current.includes(playerId))
        return current.filter((id) => id !== playerId);
      if (current.length >= maximum)
        return maximum === 1 ? [playerId] : current;
      return [...current, playerId];
    });
  }

  function submitDraft() {
    if (!canConfirm || selectedAction === undefined) return;
    const targetNames = selectedTargetIds
      .map((id) => view.players.find((player) => player.id === id)?.hero)
      .filter(Boolean);
    setNotice(
      `已生成原型命令：${selectedAction.label}${targetNames.length ? ` → ${targetNames.join("、")}` : ""}`,
    );
  }

  return (
    <main className="game-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-seal" aria-hidden="true">
            逍
          </span>
          <div>
            <strong>逍遥游</strong>
            <span>标准包 · 凤鸣玉誓</span>
          </div>
        </div>
        <div className="match-meta" aria-label="对局信息">
          <span>房间 {view.roomCode}</span>
          <span>第 {view.round} 轮</span>
          <strong>{view.phase}</strong>
        </div>
        <label className="scenario-picker">
          原型场景
          <select
            aria-label="原型场景"
            value={scenarioId}
            onChange={(event) =>
              setScenarioId(event.target.value as ScenarioId)
            }
          >
            {Object.entries(scenarioLabels).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {view.connection !== "online" ? (
        <div className={`network-banner is-${view.connection}`} role="status">
          <strong>
            {view.connection === "disconnected" ? "连接中断" : "正在重连"}
          </strong>
          <span>
            {view.connection === "disconnected"
              ? "当前 15 秒计时不会暂停；持续断联 60 秒后进入自动模式。"
              : "正在验证座位并获取最新私密视图。"}
          </span>
        </div>
      ) : null}

      <div className="table-layout">
        <section className="board-column" aria-label="对局桌面">
          <div className="rival-strip" aria-label="其他玩家">
            {view.players.map((player) => {
              const targetable =
                selectedAction?.targetIds?.includes(player.id) === true;
              return (
                <PlayerSeat
                  key={player.id}
                  player={player}
                  self={player.id === "p1"}
                  targetable={targetable}
                  selected={selectedTargetIds.includes(player.id)}
                  onSelect={() => chooseTarget(player.id)}
                />
              );
            })}
          </div>
          <section
            className="battlefield"
            aria-labelledby="current-event-title"
          >
            <div className="phase-ribbon">
              第 {view.round} 轮 · {view.phase}
            </div>
            <div className="event-focus">
              <p className="overline">{view.kicker}</p>
              <h1 id="current-event-title">{view.title}</h1>
              <p>{view.description}</p>
            </div>
            <div className="effect-path" aria-label="当前效果链">
              {view.effectNodes.map((node, index) => (
                <span className="effect-step" key={node}>
                  <span
                    className={`effect-node${index === view.effectNodes.length - 1 ? " is-current" : " is-resolved"}`}
                  >
                    {node}
                  </span>
                  {index < view.effectNodes.length - 1 ? (
                    <span className="effect-arrow" aria-hidden="true">
                      →
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
            {view.secondsLeft > 0 ? (
              <div
                className="timer-block"
                aria-label={`剩余 ${view.secondsLeft} 秒`}
              >
                <span className="timer-value">{view.secondsLeft}</span>
                <span>{view.timeoutConsequence}</span>
              </div>
            ) : null}
          </section>
          <section className="self-and-actions" aria-label="自己的状态和操作">
            <PlayerSeat
              player={view.players[0]!}
              self
              targetable={selectedAction?.targetIds?.includes("p1") === true}
              selected={selectedTargetIds.includes("p1")}
              onSelect={() => chooseTarget("p1")}
            />
            <div className={`action-tray is-${view.interaction}`}>
              <div className="action-copy">
                <span className="action-kicker">
                  {view.interaction === "active" ? "你的操作" : "当前状态"}
                </span>
                <strong>
                  {view.interaction === "waiting"
                    ? "等待服务端推进"
                    : view.interaction === "expired"
                      ? "旧操作已禁用"
                      : view.interaction === "settled"
                        ? "对局状态已锁定"
                        : selectedCard
                          ? `已选择【${selectedCard.name}】`
                          : "选择一张可用手牌"}
                </strong>
                <span>
                  {selectedAction
                    ? maximum === 0
                      ? "无需目标，可以确认"
                      : `目标 ${selectedTargetIds.length}/${maximum} · 确认前可修改`
                    : view.interaction === "active"
                      ? "选择只保存在本地，尚未提交"
                      : "不会向其他玩家泄露私密动作"}
                </span>
              </div>
              <div className="action-buttons">
                {pass ? (
                  <button
                    className="button-secondary"
                    type="button"
                    onClick={() => setNotice(`已生成原型命令：${pass.label}`)}
                  >
                    {pass.label}
                  </button>
                ) : (
                  <button className="button-secondary" type="button" disabled>
                    {view.interaction === "settled" ? "已结束" : "等待中"}
                  </button>
                )}
                <button
                  className="button-primary"
                  type="button"
                  disabled={!canConfirm}
                  onClick={submitDraft}
                >
                  {canConfirm
                    ? "确认提交"
                    : selectedAction && maximum > 0
                      ? `还需选择 ${minimum - selectedTargetIds.length} 名`
                      : "选择可用手牌"}
                </button>
              </div>
            </div>
          </section>
          <section className="hand-zone" aria-label="你的手牌">
            <div className="section-heading">
              <div>
                <span>你的手牌</span>
                <strong>{view.hand.length} 张</strong>
              </div>
              <p>横向滚动查看更多 · 暗色牌当前不可用</p>
            </div>
            <div className="hand-scroll">
              {view.hand.map((card) => (
                <CardButton
                  key={card.id}
                  card={card}
                  selected={card.id === selectedCardId}
                  playable={view.availableActions.some(
                    (action) =>
                      action.kind === "play-card" && action.cardId === card.id,
                  )}
                  onSelect={() => chooseCard(card.id)}
                />
              ))}
            </div>
          </section>
        </section>
        <aside className="side-rail" aria-label="对局记录">
          <div className="connection-status">
            <span aria-hidden="true" />
            {view.connection === "online" ? "连接稳定 · 42ms" : "连接状态异常"}
          </div>
          <div className="rail-heading">
            <span>公开记录</span>
            <button type="button">规则摘要</button>
          </div>
          <ol className="event-log">
            <li>
              <time>20:14</time>
              <p>
                <strong>第 4 轮开始</strong>
                <span>行动权交给 1 席 李逍遥</span>
              </p>
            </li>
            <li>
              <time>20:13</time>
              <p>
                <strong>赵灵儿获得「圣灵珠」</strong>
                <span>装备状态已公开</span>
              </p>
            </li>
            <li>
              <time>20:12</time>
              <p>
                <strong>遭遇结算完成</strong>
                <span>玄霄受到 1 点伤害</span>
              </p>
            </li>
            <li>
              <time>20:11</time>
              <p>
                <strong>所有玩家均已放弃响应</strong>
                <span>原效果继续结算</span>
              </p>
            </li>
          </ol>
          <div className="privacy-note">
            <span aria-hidden="true">◇</span>
            <p>
              <strong>私密信息已隔离</strong>
              其他玩家只会看到你的手牌数量，不会看到牌面或可用响应。
            </p>
          </div>
        </aside>
      </div>
      {notice ? (
        <div className="command-notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");
const globalWithRoot = globalThis as typeof globalThis & {
  __xiaoyaoyouRoot?: Root;
};
globalWithRoot.__xiaoyaoyouRoot ??= createRoot(root);
globalWithRoot.__xiaoyaoyouRoot.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
