import type {
  CommandEnvelope,
  CommandId,
  PlayerId,
} from "@xiaoyaoyou/protocol";
import type {
  ApplyCommandResult,
  DomainEvent,
  EngineCommand,
} from "./architecture.js";
import type {
  AvailableAction,
  EffectFrame,
  MatchState,
  ReactionWindow,
  TeamId,
} from "./index.js";
import type { EncounterParticipant } from "./encounter.js";
import { encounterDefinition } from "./encounter-definitions.js";
import { evaluateBattle } from "./encounter-resolution.js";
import { validateMonsterBattle } from "./monster-debut.js";
import { openCardResponse } from "./reaction.js";
import { cardIdOf, type CardInstanceId } from "./setup-content.js";
import { nextInt } from "./random.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";

export interface BattleCardWindow {
  readonly windowId: string;
  readonly sideTeam: TeamId;
  readonly playerIds: readonly PlayerId[];
  readonly passedPlayerIds: readonly PlayerId[];
  readonly openedAt: number;
  readonly deadlineAt: number;
}
interface BattleCardPlay {
  readonly effectId: string;
  readonly playerId: PlayerId;
  readonly cardInstanceId: CardInstanceId;
  readonly result: "pending" | "resolved" | "cancelled";
  readonly chosenTeam: TeamId | null;
}
export interface BattleCardsState {
  readonly baselineStrength: Readonly<Record<PlayerId, number>>;
  readonly plays: readonly BattleCardPlay[];
  readonly pendingEffectId: string | null;
  readonly windowSerial: number;
  readonly consecutivePasses: number;
  readonly outcome: ReturnType<typeof evaluateBattle> | null;
}
const quiet = (s: MatchState) =>
  !s.reactionWindow &&
  !s.pendingChoice &&
  !s.dyingBatch &&
  s.effectStack.length === 0;
const opposite = (team: TeamId): TeamId => (team === 1 ? 2 : 1);
function playerTeam(s: MatchState, id: PlayerId): TeamId {
  const team = s.players[id]?.team;
  if (team !== 1 && team !== 2) throw new Error("Missing battle team.");
  return team;
}
const isBattleCard = (id: string) =>
  ["xyy.card.zp01", "xyy.card.zp02", "xyy.card.zp03", "xyy.card.zp04"].includes(
    id,
  );
const livingTeam = (s: MatchState, team: TeamId) =>
  Object.values(s.players)
    .filter((p) => p.alive && p.team === team)
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.id);

/** Derive public combat numbers from paid/resolved plays, never from hand contents. */
export function battleScore(s: MatchState): ReturnType<typeof evaluateBattle> {
  const battle = s.encounterState.battle!,
    flow = s.encounterState.resolution!;
  const cards = battle.cards;
  const strength = (id: PlayerId) =>
    s.players[id]!.strength +
    (battle.playerStrengthBonuses[id] ?? 0) +
    (cards?.plays ?? [])
      .filter((p) => p.playerId === id && p.result === "resolved")
      .reduce(
        (n, p) =>
          n +
          (cardIdOf(p.cardInstanceId) === "xyy.card.zp02"
            ? Math.max(cards!.baselineStrength[id]!, 0)
            : cardIdOf(p.cardInstanceId) === "xyy.card.zp03"
              ? 3
              : 0),
        0,
      );
  const pet = (p: EncounterParticipant | null) => {
    if (p?.kind !== "pet") return { hit: false, strength: 0 };
    const def = encounterDefinition(p.cardId);
    if (
      def.kind !== "monster" ||
      !s.encounterState.pets[p.ownerPlayerId]?.includes(def.id)
    )
      throw new Error("Invalid battle pet.");
    return { hit: def.agility >= battle.agility, strength: def.strength };
  };
  const supportPet = pet(flow.supporter),
    hinderPet = pet(flow.hinder);
  if (flow.supporter?.kind === "special" || flow.hinder?.kind === "special")
    throw new Error("Unimplemented special battle participant.");
  const activeTeam = playerTeam(s, flow.activePlayerId);
  const bonus = (team: TeamId) =>
    (cards?.plays ?? []).filter(
      (p) => p.result === "resolved" && p.chosenTeam === team,
    ).length * 2;
  const score = evaluateBattle({
    players: Object.values(s.players).map((p) => ({
      playerId: p.id,
      team: playerTeam(s, p.id),
      seat: p.seat,
      alive: p.alive,
      strength: strength(p.id),
      dexterity: p.dexterity,
      hitOverride: 0,
      winOverride: 0,
    })),
    activePlayerId: flow.activePlayerId,
    supporterPlayerId:
      flow.supporter?.kind === "player" ? flow.supporter.playerId : null,
    hinderPlayerId:
      flow.hinder?.kind === "player" ? flow.hinder.playerId : null,
    monsterStrength: battle.strength,
    monsterAgility: battle.agility,
    attackingBonus:
      bonus(activeTeam) + (supportPet.hit ? supportPet.strength : 0),
    defendingBonus:
      bonus(opposite(activeTeam)) + (hinderPet.hit ? hinderPet.strength : 0),
  });
  return {
    ...score,
    supportHit: score.supportHit || supportPet.hit,
    hinderHit: score.hinderHit || hinderPet.hit,
  };
}
function eligible(s: MatchState, id: PlayerId, card: CardInstanceId): boolean {
  const b = s.encounterState.battle!,
    flow = s.encounterState.resolution!;
  const code = cardIdOf(card);
  if (
    !isBattleCard(code) ||
    b.remainingCardQuota[id] !== 1 ||
    !s.players[id]?.alive ||
    !s.players[id]!.hand.includes(card)
  )
    return false;
  if (code === "xyy.card.zp04") return true;
  if (id === flow.activePlayerId) return true;
  const score = battleScore(s);
  return (
    (flow.supporter?.kind === "player" &&
      flow.supporter.playerId === id &&
      (code === "xyy.card.zp01" || score.supportHit)) ||
    (flow.hinder?.kind === "player" &&
      flow.hinder.playerId === id &&
      (code === "xyy.card.zp01" || score.hinderHit))
  );
}
export function battleCardActions(
  s: MatchState,
  id: PlayerId,
): AvailableAction[] {
  const b = s.encounterState.battle,
    w = b?.cardWindow;
  if (
    s.phase !== "playing" ||
    b?.stage !== "card-window" ||
    !w ||
    !quiet(s) ||
    !w.playerIds.includes(id) ||
    w.passedPlayerIds.includes(id)
  )
    return [];
  return [
    ...s.players[id]!.hand.filter((c) => eligible(s, id, c)).map(
      (cardInstanceId) => ({
        type: "play-battle-card" as const,
        windowId: w.windowId,
        cardInstanceId,
      }),
    ),
    { type: "pass-battle", windowId: w.windowId },
  ];
}
function replaceBattle(
  s: MatchState,
  battle: NonNullable<MatchState["encounterState"]["battle"]>,
  at: number,
): MatchState {
  const updatedAt = Math.max(battle.updatedAt, at);
  return {
    ...s,
    encounterState: {
      ...s.encounterState,
      battle: { ...battle, updatedAt },
      resolution: { ...s.encounterState.resolution!, updatedAt },
    },
  };
}
function openSide(s: MatchState, at: number): MatchState {
  const b = s.encounterState.battle!,
    c = b.cards!,
    flow = s.encounterState.resolution!;
  if (c.consecutivePasses === 2)
    return replaceBattle(
      s,
      {
        ...b,
        stage: "outcome-ready",
        cardWindow: null,
        cards: { ...c, outcome: battleScore(s) },
      },
      at,
    );
  const actorTeam = playerTeam(s, flow.activePlayerId);
  const losingTeam = battleScore(s).activeSideWins
    ? opposite(actorTeam)
    : actorTeam;
  const sideTeam =
    c.consecutivePasses === 0 ? losingTeam : opposite(losingTeam);
  const serial = c.windowSerial + 1;
  const playerIds = livingTeam(s, sideTeam);
  if (playerIds.length === 0)
    throw new Error("Battle side has no living players.");
  return replaceBattle(
    s,
    {
      ...b,
      stage: "card-window",
      cards: { ...c, windowSerial: serial },
      cardWindow: {
        windowId: `${b.effectId}:cards:${serial}`,
        sideTeam,
        playerIds,
        passedPlayerIds: [],
        openedAt: at,
        deadlineAt: at + ACTION_DEADLINE_MS,
      },
    },
    at,
  );
}
type Operation =
  | { readonly kind: "start" }
  | { readonly kind: "continue" }
  | {
      readonly kind: "pass";
      readonly playerId: PlayerId;
      readonly windowId: string;
    }
  | {
      readonly kind: "play";
      readonly playerId: PlayerId;
      readonly windowId: string;
      readonly cardInstanceId: CardInstanceId;
    }
  | {
      readonly kind: "choose";
      readonly playerId: PlayerId;
      readonly choiceId: string;
      readonly optionId: string | null;
      readonly timeout: boolean;
    };

function transition(input: MatchState, op: Operation, at: number): MatchState {
  validateMonsterBattle(input, op.kind === "continue");
  const b = input.encounterState.battle;
  if (
    !b ||
    input.phase !== "playing" ||
    input.turn?.phase !== "encounter" ||
    !Number.isSafeInteger(at) ||
    at < 0 ||
    !Number.isSafeInteger(at + ACTION_DEADLINE_MS)
  )
    throw new Error("Invalid battle context.");
  if (op.kind === "start") {
    if (
      b.stage !== "combat-ready" ||
      b.cards !== null ||
      !quiet(input) ||
      at < b.updatedAt
    )
      throw new Error("Battle cards already started or not ready.");
    return openSide(
      replaceBattle(
        input,
        {
          ...b,
          remainingCardQuota: Object.fromEntries(
            input.turnOrder.map((id) => [id, 1]),
          ),
          cards: {
            baselineStrength: Object.fromEntries(
              input.turnOrder.map((id) => [
                id,
                input.players[id]!.strength +
                  (b.playerStrengthBonuses[id] ?? 0),
              ]),
            ),
            plays: [],
            pendingEffectId: null,
            windowSerial: 0,
            consecutivePasses: 0,
            outcome: null,
          },
        },
        at,
      ),
      at,
    );
  }
  const c = b.cards;
  if (!c) throw new Error("Missing battle cards cursor.");
  if (op.kind === "continue") {
    if (
      b.stage !== "card-reactions" ||
      !quiet(input) ||
      c.pendingEffectId === null
    )
      throw new Error("Battle card child is still pending.");
    const plays = c.plays.map((p) =>
      p.effectId === c.pendingEffectId && p.result === "pending"
        ? { ...p, result: "cancelled" as const }
        : p,
    );
    const next = replaceBattle(
      input,
      {
        ...b,
        cards: { ...c, plays, pendingEffectId: null, consecutivePasses: 0 },
      },
      at,
    );
    return plays.some(
      (p) =>
        p.result === "resolved" &&
        cardIdOf(p.cardInstanceId) === "xyy.card.zp01",
    )
      ? replaceBattle(
          next,
          { ...next.encounterState.battle!, stage: "escaped" },
          at,
        )
      : openSide(next, at);
  }
  if (op.kind === "choose") {
    const choice = input.pendingChoice;
    const p = c.plays.find((p) => p.effectId === c.pendingEffectId);
    if (
      b.stage !== "card-choice" ||
      !choice ||
      choice.choiceId !== op.choiceId ||
      choice.continuation.resumeWith !== "resolve-battle-team" ||
      choice.playerIds[0] !== op.playerId ||
      !p ||
      p.result !== "pending" ||
      cardIdOf(p.cardInstanceId) !== "xyy.card.zp04" ||
      at < choice.openedAt ||
      (!op.timeout && at > choice.deadlineAt)
    )
      throw new Error("Invalid battle team choice.");
    if (
      op.timeout &&
      at !==
        (input.connections[op.playerId]?.status === "auto"
          ? choice.openedAt
          : choice.deadlineAt)
    )
      throw new Error("Battle choice timeout is not due.");
    const drawn = op.timeout ? nextInt(input.rng, 2) : null;
    const selected = drawn ? choice.optionIds[drawn.value] : op.optionId;
    if (selected !== "team:1" && selected !== "team:2")
      throw new Error("Invalid battle team.");
    const chosenTeam: TeamId = selected === "team:1" ? 1 : 2;
    return replaceBattle(
      {
        ...input,
        rng: drawn?.rng ?? input.rng,
        pendingChoice: null,
        effectStack: [],
      },
      {
        ...b,
        stage: "card-reactions",
        cards: {
          ...c,
          plays: c.plays.map((x) =>
            x === p ? { ...p, result: "resolved", chosenTeam } : x,
          ),
        },
      },
      at,
    );
  }
  const w = b.cardWindow;
  if (
    b.stage !== "card-window" ||
    !quiet(input) ||
    !w ||
    w.windowId !== op.windowId ||
    !w.playerIds.includes(op.playerId) ||
    w.passedPlayerIds.includes(op.playerId) ||
    at < w.openedAt ||
    at > w.deadlineAt
  )
    throw new Error("Invalid battle window action.");
  if (op.kind === "pass") {
    const passed = [...w.passedPlayerIds, op.playerId];
    const next = replaceBattle(
      input,
      { ...b, cardWindow: { ...w, passedPlayerIds: passed } },
      at,
    );
    return passed.length !== w.playerIds.length
      ? next
      : openSide(
          replaceBattle(
            next,
            {
              ...next.encounterState.battle!,
              cardWindow: null,
              cards: { ...c, consecutivePasses: c.consecutivePasses + 1 },
            },
            at,
          ),
          at,
        );
  }
  if (!eligible(input, op.playerId, op.cardInstanceId))
    throw new Error("Unavailable battle card.");
  const effectId = `${b.effectId}:card:${c.plays.length + 1}`;
  const play: BattleCardPlay = {
    effectId,
    playerId: op.playerId,
    cardInstanceId: op.cardInstanceId,
    result: "pending",
    chosenTeam: null,
  };
  const player = input.players[op.playerId]!;
  const paid = replaceBattle(
    {
      ...input,
      players: {
        ...input.players,
        [player.id]: {
          ...player,
          hand: player.hand.filter((x) => x !== op.cardInstanceId),
        },
      },
      discardPile: [...input.discardPile, op.cardInstanceId],
    },
    {
      ...b,
      stage: "card-reactions",
      cardWindow: null,
      remainingCardQuota: { ...b.remainingCardQuota, [player.id]: 0 },
      cards: {
        ...c,
        plays: [...c.plays, play],
        pendingEffectId: effectId,
        consecutivePasses: 0,
      },
    },
    at,
  );
  return openCardResponse(
    paid,
    {
      effectId,
      parentEffectId: null,
      kind: `card:${cardIdOf(op.cardInstanceId)}`,
      sourcePlayerId: player.id,
      targetIds: [player.id],
      step: "awaiting-reactions",
      status: "waiting",
      payload: { cardInstanceId: op.cardInstanceId },
    },
    at,
  );
}

/** Called by the common response reducer only after an uncancelled root closes. */
export function resolveBattleCardEffect(
  s: MatchState,
  effect: EffectFrame,
  at: number,
): MatchState {
  const b = s.encounterState.battle!,
    c = b.cards!;
  const play = c.plays.find((p) => p.effectId === effect.effectId);
  if (
    b.stage !== "card-reactions" ||
    c.pendingEffectId !== effect.effectId ||
    !play ||
    play.result !== "pending" ||
    effect.kind !== `card:${cardIdOf(play.cardInstanceId)}` ||
    effect.sourcePlayerId !== play.playerId
  )
    throw new Error("Invalid battle card effect binding.");
  if (effect.kind === "card:xyy.card.zp04") {
    const choiceId = `${effect.effectId}:team`;
    return replaceBattle(
      {
        ...s,
        reactionWindow: null,
        effectStack: [
          { ...effect, step: "awaiting-team", status: "resolving" },
        ],
        pendingChoice: {
          choiceId,
          playerIds: [play.playerId],
          prompt: "battle-team",
          minSelections: 1,
          maxSelections: 1,
          optionIds: ["team:1", "team:2"],
          optional: false,
          status: "open",
          openedAt: at,
          deadlineAt: at + ACTION_DEADLINE_MS,
          fallback: "deterministic-random",
          continuation: {
            continuationId: `${choiceId}:continue`,
            effectId: effect.effectId,
            step: "choose-team",
            locals: {},
            resumeWith: "resolve-battle-team",
          },
        },
      },
      { ...b, stage: "card-choice" },
      at,
    );
  }
  return replaceBattle(
    { ...s, reactionWindow: null, effectStack: [] },
    {
      ...b,
      cards: {
        ...c,
        plays: c.plays.map((p) =>
          p === play ? { ...p, result: "resolved" } : p,
        ),
      },
    },
    at,
  );
}

export function reduceBattleCardsEvent(
  s: MatchState,
  event: DomainEvent,
): MatchState {
  if (
    event.type !== "battle.cards" ||
    event.matchId !== s.matchId ||
    event.rulesetVersion !== s.rulesetVersion ||
    event.sequence !== s.eventSequence + 1 ||
    event.payload.matchVersion !==
      s.version + (event.causationEventId === null ? 1 : 0)
  )
    throw new Error("Invalid battle event head.");
  const next = transition(
    s,
    event.payload.operation as Operation,
    event.payload.resolvedAt as number,
  );
  const report = { battle: next.encounterState.battle, rng: next.rng };
  if (JSON.stringify(report) !== JSON.stringify(event.payload.report))
    throw new Error("Battle event report mismatch.");
  validateMonsterBattle(
    next,
    next.encounterState.battle?.stage === "card-reactions" && quiet(next),
  );
  return {
    ...next,
    version: event.payload.matchVersion as number,
    eventSequence: event.sequence,
  };
}
function execute(
  s: MatchState,
  op: Operation,
  id: CommandId,
  at: number,
  causation: string | null = null,
): Extract<ApplyCommandResult, { accepted: true }> {
  const next = transition(s, op, at);
  const event: DomainEvent = {
    type: "battle.cards",
    eventId: `${s.matchId}:event:${s.eventSequence + 1}`,
    sequence: s.eventSequence + 1,
    matchId: s.matchId,
    rulesetVersion: s.rulesetVersion,
    causationCommandId: id,
    causationEventId: causation,
    payload: {
      operation: op,
      resolvedAt: at,
      matchVersion: s.version + (causation === null ? 1 : 0),
      report: { battle: next.encounterState.battle, rng: next.rng },
    },
  };
  return {
    accepted: true,
    state: reduceBattleCardsEvent(s, event),
    events: [event],
  };
}
export function beginBattleCards(
  s: MatchState,
  id: CommandId,
  at: number,
  causation: string | null = null,
) {
  return execute(s, { kind: "start" }, id, at, causation);
}
export function continueBattleCards(
  s: MatchState,
  id: CommandId,
  at: number,
  causation: string | null,
): Extract<ApplyCommandResult, { accepted: true }> {
  return s.encounterState.battle?.stage === "card-reactions" && quiet(s)
    ? execute(s, { kind: "continue" }, id, at, causation)
    : { accepted: true, state: s, events: [] };
}
export function applyBattleCommand(
  s: MatchState,
  envelope: CommandEnvelope,
  at: number,
): ApplyCommandResult {
  const cmd = envelope.command;
  let op: Operation;
  if (cmd.type === "pass-battle")
    op = { kind: "pass", playerId: envelope.playerId, windowId: cmd.windowId };
  else if (cmd.type === "play-battle-card")
    op = {
      kind: "play",
      playerId: envelope.playerId,
      windowId: cmd.windowId,
      cardInstanceId: cmd.cardInstanceId as CardInstanceId,
    };
  else if (cmd.type === "submit-choice" && cmd.selections.length === 1)
    op = {
      kind: "choose",
      playerId: envelope.playerId,
      choiceId: cmd.choiceId,
      optionId: cmd.selections[0]!,
      timeout: false,
    };
  else
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: s.version,
    };
  try {
    return execute(s, op, envelope.commandId, at);
  } catch {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: s.version,
    };
  }
}
export function applyBattleChoiceTimeout(
  s: MatchState,
  cmd: Extract<EngineCommand, { origin: "system-timeout" }>,
  playerId: PlayerId,
): ApplyCommandResult {
  if (!s.pendingChoice)
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: s.version,
    };
  return execute(
    s,
    {
      kind: "choose",
      playerId,
      choiceId: s.pendingChoice.choiceId,
      optionId: null,
      timeout: true,
    },
    cmd.commandId,
    cmd.deadlineAt,
  );
}

function validateCounterChain(s: MatchState, rootId: string): void {
  const visited = new Set<string>();
  let window: ReactionWindow | null = s.reactionWindow;
  let top = true;
  while (window !== null) {
    const effect = s.effectStack.find((e) => e.effectId === window!.effectId);
    if (
      !effect ||
      visited.has(effect.effectId) ||
      effect.status !== (top ? "waiting" : "pending")
    )
      throw new Error("Invalid battle counter chain.");
    visited.add(effect.effectId);
    const expected = Object.values(s.players)
      .filter((p) => p.alive && p.id !== effect.sourcePlayerId)
      .map((p) => p.id)
      .sort();
    if (
      window.status !== "open" ||
      window.continuation.effectId !== effect.effectId ||
      window.continuation.resumeWith !== "resolve-effect" ||
      JSON.stringify([...window.eligiblePlayerIds].sort()) !==
        JSON.stringify(expected) ||
      JSON.stringify([...window.priorityOrder].sort()) !==
        JSON.stringify(expected) ||
      !Number.isInteger(window.priorityIndex) ||
      window.priorityIndex < 0 ||
      window.priorityIndex >= expected.length ||
      window.priorityIndex !== window.passedPlayerIds.length ||
      JSON.stringify(window.passedPlayerIds) !==
        JSON.stringify(window.priorityOrder.slice(0, window.priorityIndex)) ||
      !Number.isSafeInteger(window.openedAt) ||
      window.openedAt < s.encounterState.battle!.openedAt ||
      !Number.isSafeInteger(window.deadlineAt) ||
      window.deadlineAt !== window.openedAt + ACTION_DEADLINE_MS
    )
      throw new Error("Invalid saved battle response window.");
    const parent = window.continuation.locals.parentWindow as
      ReactionWindow | undefined;
    if (effect.effectId === rootId) {
      if (
        effect.parentEffectId !== null ||
        window.parentWindowId !== null ||
        parent !== undefined
      )
        throw new Error("Unexpected parent on root card.");
      window = null;
    } else {
      if (
        effect.kind !== "cancel-effect" ||
        !parent ||
        window.parentWindowId !== parent.windowId ||
        effect.parentEffectId !== parent.effectId ||
        JSON.stringify(effect.targetIds) !== JSON.stringify([parent.effectId])
      )
        throw new Error("Missing battle counter parent.");
      window = parent;
    }
    top = false;
  }
  if (!visited.has(rootId) || visited.size !== s.effectStack.length)
    throw new Error("Duplicated or orphaned battle frame.");
}

/** Reject orphaned waits, refunded payments and forged public state on restore. */
export function validateBattleCards(s: MatchState, transient = false): void {
  const b = s.encounterState.battle!;
  const c = b.cards,
    w = b.cardWindow;
  const fail = () => {
    throw new Error("Invalid battle cards snapshot.");
  };
  if (c === null) {
    if (
      w !== null ||
      !b.remainingCardQuota ||
      Object.keys(b.remainingCardQuota).length ||
      !["debut-damage", "combat-ready", "aborted"].includes(b.stage)
    )
      fail();
    return;
  }
  if (
    !c ||
    ![
      "card-window",
      "card-reactions",
      "card-choice",
      "outcome-ready",
      "escaped",
      "outcome-damage",
      "outcome-choice",
      "capture-choice",
      "complete",
    ].includes(b.stage) ||
    (b.outcome === undefined && s.phase !== "playing") ||
    (b.outcome === undefined && s.dyingBatch !== null) ||
    !Number.isSafeInteger(c.windowSerial) ||
    c.windowSerial < 1 ||
    ![0, 1, 2].includes(c.consecutivePasses) ||
    !Array.isArray(c.plays) ||
    c.plays.length > 6 ||
    !c.baselineStrength ||
    !b.remainingCardQuota
  )
    fail();
  if (
    Object.keys(c.baselineStrength).length !== 6 ||
    Object.keys(b.remainingCardQuota).length !== 6 ||
    s.turnOrder.some((id) => !Number.isSafeInteger(c.baselineStrength[id]))
  )
    fail();
  const ids = new Set<string>(),
    owners = new Set<string>(),
    usedCards = new Set<string>();
  for (const [index, p] of c.plays.entries()) {
    if (
      !p ||
      !s.players[p.playerId] ||
      !isBattleCard(cardIdOf(p.cardInstanceId)) ||
      ids.has(p.effectId) ||
      owners.has(p.playerId) ||
      usedCards.has(p.cardInstanceId) ||
      p.effectId !== `${b.effectId}:card:${index + 1}` ||
      (b.outcome === undefined && !s.discardPile.includes(p.cardInstanceId)) ||
      !["pending", "resolved", "cancelled"].includes(p.result)
    )
      fail();
    if (
      cardIdOf(p.cardInstanceId) === "xyy.card.zp04" && p.result === "resolved"
        ? ![1, 2].includes(p.chosenTeam!)
        : p.chosenTeam !== null
    )
      fail();
    if (
      p.result === "pending" &&
      (index !== c.plays.length - 1 || c.pendingEffectId !== p.effectId)
    )
      fail();
    ids.add(p.effectId);
    owners.add(p.playerId);
    usedCards.add(p.cardInstanceId);
  }
  if (
    s.turnOrder.some(
      (id) => b.remainingCardQuota[id] !== (owners.has(id) ? 0 : 1),
    )
  )
    fail();
  const pending = c.plays.find((p) => p.effectId === c.pendingEffectId);
  if (b.stage === "card-window") {
    if (
      !w ||
      !quiet(s) ||
      c.pendingEffectId !== null ||
      c.outcome !== null ||
      c.consecutivePasses > 1
    )
      fail();
    if (!w) return;
    const actorTeam = playerTeam(
      s,
      s.encounterState.resolution!.activePlayerId,
    );
    const losing = battleScore(s).activeSideWins
      ? opposite(actorTeam)
      : actorTeam;
    if (
      w.sideTeam !== (c.consecutivePasses === 0 ? losing : opposite(losing)) ||
      w.windowId !== `${b.effectId}:cards:${c.windowSerial}` ||
      !Number.isSafeInteger(w.openedAt) ||
      w.openedAt < b.openedAt ||
      w.deadlineAt !== w.openedAt + ACTION_DEADLINE_MS ||
      JSON.stringify(w.playerIds) !==
        JSON.stringify(livingTeam(s, w.sideTeam)) ||
      !Array.isArray(w.passedPlayerIds) ||
      new Set(w.passedPlayerIds).size !== w.passedPlayerIds.length ||
      w.passedPlayerIds.length >= w.playerIds.length ||
      w.passedPlayerIds.some((id) => !w.playerIds.includes(id))
    )
      fail();
  } else if (w !== null) fail();
  if (["outcome-ready", "escaped"].includes(b.stage)) {
    if (
      !quiet(s) ||
      c.pendingEffectId !== null ||
      c.plays.some((p) => p.result === "pending")
    )
      fail();
    if (
      b.stage === "outcome-ready" &&
      (c.consecutivePasses !== 2 ||
        JSON.stringify(c.outcome) !== JSON.stringify(battleScore(s)))
    )
      fail();
    if (
      b.stage === "escaped" &&
      (c.outcome !== null ||
        !c.plays.some(
          (p) =>
            p.result === "resolved" &&
            cardIdOf(p.cardInstanceId) === "xyy.card.zp01",
        ))
    )
      fail();
  }
  if (b.stage === "card-reactions" || b.stage === "card-choice") {
    if (!pending || c.outcome !== null || c.consecutivePasses !== 0) fail();
    if (!pending) return;
    if (transient && quiet(s)) return;
    if (pending.result !== "pending") fail();
    const root = s.effectStack.find((e) => e.effectId === pending.effectId);
    if (
      !root ||
      root.kind !== `card:${cardIdOf(pending.cardInstanceId)}` ||
      root.sourcePlayerId !== pending.playerId ||
      root.payload.cardInstanceId !== pending.cardInstanceId ||
      root.parentEffectId !== null ||
      JSON.stringify(root.targetIds) !== JSON.stringify([pending.playerId])
    )
      fail();
    const bound = (id: string, seen = new Set<string>()): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      if (id === pending.effectId) return true;
      const e = s.effectStack.find((e) => e.effectId === id);
      return (
        e?.kind === "cancel-effect" &&
        e.parentEffectId !== null &&
        bound(e.parentEffectId, seen)
      );
    };
    if (s.effectStack.some((e) => !bound(e.effectId))) fail();
    const r = s.reactionWindow,
      choice = s.pendingChoice;
    if (b.stage === "card-reactions") {
      if (
        choice !== null ||
        !r ||
        r.status !== "open" ||
        !bound(r.effectId) ||
        r.continuation.effectId !== r.effectId ||
        r.priorityOrder.length === 0 ||
        !r.priorityOrder.includes(r.priorityOrder[r.priorityIndex]!)
      )
        fail();
      validateCounterChain(s, pending.effectId);
    } else if (
      !choice ||
      r !== null ||
      s.effectStack.length !== 1 ||
      root?.status !== "resolving" ||
      cardIdOf(pending.cardInstanceId) !== "xyy.card.zp04" ||
      choice.choiceId !== `${pending.effectId}:team` ||
      choice.continuation.effectId !== pending.effectId ||
      choice.continuation.resumeWith !== "resolve-battle-team" ||
      JSON.stringify(choice.playerIds) !== JSON.stringify([pending.playerId]) ||
      JSON.stringify(choice.optionIds) !==
        JSON.stringify(["team:1", "team:2"]) ||
      choice.optional !== false ||
      choice.minSelections !== 1 ||
      choice.maxSelections !== 1 ||
      choice.fallback !== "deterministic-random"
    )
      fail();
    const wait = r ?? choice;
    if (
      !wait ||
      !Number.isSafeInteger(wait.openedAt) ||
      wait.openedAt < b.openedAt ||
      wait.deadlineAt !== wait.openedAt + ACTION_DEADLINE_MS
    )
      fail();
  }
}
