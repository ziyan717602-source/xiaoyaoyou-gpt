import type { CommandId, PlayerId } from "@xiaoyaoyou/protocol";
import type { DomainEvent, ApplyCommandResult } from "./architecture.js";
import type { MatchState } from "./index.js";
import type { MonsterId } from "./encounter-content.js";
import type { EncounterParticipant } from "./encounter.js";
import { encounterDefinition } from "./encounter-definitions.js";
import { validateEncounterRuntime } from "./npc-effects.js";
import {
  planDamageBatch,
  type AppliedDamage,
  type DamageIntent,
} from "./damage-dying.js";
import { beginDamageResponse } from "./reaction.js";
import { isCanonicalHpEvolutionMask } from "./hp-evolution.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";
import {
  validateBattleCards,
  type BattleCardsState,
  type BattleCardWindow,
} from "./battle-cards.js";

export interface MonsterBattleState {
  readonly monsterId: MonsterId;
  readonly effectId: string;
  readonly stage:
    | "debut-damage"
    | "combat-ready"
    | "aborted"
    | "card-window"
    | "card-reactions"
    | "card-choice"
    | "outcome-ready"
    | "escaped";
  readonly cards: BattleCardsState | null;
  readonly cardWindow: BattleCardWindow | null;
  readonly remainingCardQuota: Readonly<Record<PlayerId, number>>;
  readonly openedAt: number;
  readonly updatedAt: number;
  readonly strength: number;
  readonly agility: number;
  readonly playerStrengthBonuses: Readonly<Partial<Record<PlayerId, number>>>;
  /** Parentage survives consumed effect frames and nested death aftermath. */
  readonly damageSourceParents: Readonly<Record<string, string | null>>;
}
const EVENT = "monster.debut";
const quiet = (s: MatchState) =>
  s.effectStack.length === 0 &&
  s.reactionWindow === null &&
  s.pendingChoice === null &&
  s.dyingBatch === null;
function realPlayer(
  s: MatchState,
  p: EncounterParticipant | null,
): PlayerId | null {
  return p?.kind === "player" && s.players[p.playerId]?.alive === true
    ? p.playerId
    : null;
}
const effectIdFor = (s: MatchState, monster: MonsterId) =>
  `${s.encounterState.resolution!.flowId}:monster:${s.encounterState.resolution!.revealCount}:${monster}:debut`;

/** Validate the cursor independently from NPC execution. A transient quiet
 * damage cursor exists only between chained events, never invent a new wait. */
export function validateMonsterBattle(
  s: MatchState,
  allowTransient = false,
): void {
  const battle = s.encounterState.battle;
  const flow = s.encounterState.resolution;
  if (battle === null) {
    if (flow?.stage === "monster-effects" && !quiet(s))
      throw new Error("Monster child is missing its battle continuation.");
    return;
  }
  if (
    !battle ||
    typeof battle !== "object" ||
    flow === null ||
    s.encounterState.npc !== null ||
    flow.npcDecision !== null ||
    flow.pendingEffect !== null ||
    flow.petDecision !== null
  )
    throw new Error("Invalid monster battle context.");
  const definition = encounterDefinition(battle.monsterId);
  if (
    definition.kind !== "monster" ||
    battle.effectId !== effectIdFor(s, battle.monsterId) ||
    ![
      "debut-damage",
      "combat-ready",
      "aborted",
      "card-window",
      "card-reactions",
      "card-choice",
      "outcome-ready",
      "escaped",
    ].includes(battle.stage) ||
    !Number.isSafeInteger(battle.openedAt) ||
    battle.openedAt < 0 ||
    !Number.isSafeInteger(battle.updatedAt) ||
    battle.updatedAt < battle.openedAt ||
    battle.updatedAt !== flow.updatedAt ||
    battle.strength !==
      definition.strength + (battle.monsterId === "xyy.monster.gt03" ? 3 : 0) ||
    battle.agility !== definition.agility ||
    !battle.playerStrengthBonuses ||
    typeof battle.playerStrengthBonuses !== "object" ||
    Array.isArray(battle.playerStrengthBonuses)
  )
    throw new Error("Invalid monster battle cursor.");
  const bonusEntries = Object.entries(battle.playerStrengthBonuses);
  if (
    bonusEntries.length > 1 ||
    bonusEntries.some(
      ([id, n]) =>
        definition.id !== "xyy.monster.gl02" ||
        n !== 2 ||
        s.players[id] === undefined ||
        flow.supporter?.kind !== "player" ||
        flow.supporter.playerId !== id,
    )
  )
    throw new Error("Invalid monster battle strength bonus.");
  validateBattleCards(s, allowTransient);
  const sources = battle.damageSourceParents;
  const sourceBound = (id: string, seen = new Set<string>()): boolean => {
    if (seen.has(id) || !Object.hasOwn(sources, id)) return false;
    seen.add(id);
    if (id === battle.effectId) return sources[id] === null;
    const parent = sources[id];
    return typeof parent === "string" && sourceBound(parent, seen);
  };
  if (
    !sources ||
    typeof sources !== "object" ||
    Array.isArray(sources) ||
    !sourceBound(battle.effectId) ||
    Object.keys(sources).some((id) => !sourceBound(id))
  )
    throw new Error("Invalid monster damage ancestry.");
  if (battle.stage === "aborted") {
    if (
      s.phase !== "finished" ||
      flow.heldCardId !== null ||
      flow.stage !== "completed" ||
      !quiet(s) ||
      flow.rewardDrawCount !== 0 ||
      !s.encounterDiscard.includes(battle.monsterId)
    )
      throw new Error("Invalid terminal monster cleanup.");
  } else if (
    flow.stage !== "monster-effects" ||
    flow.heldCardId !== battle.monsterId ||
    (s.phase !== "finished" && s.turn?.phase !== "encounter") ||
    (s.phase !== "finished" && s.activePlayerId !== flow.activePlayerId) ||
    (battle.stage === "combat-ready" && (s.phase !== "playing" || !quiet(s)))
  )
    throw new Error("Invalid held monster battle.");
  if (
    battle.stage === "debut-damage" &&
    !["xyy.monster.gh03", "xyy.monster.gh04", "xyy.monster.gt02"].includes(
      battle.monsterId,
    )
  )
    throw new Error("Monster has no debut damage.");
  if (battle.stage === "debut-damage") {
    if (
      !allowTransient &&
      (s.phase !== "playing" ||
        (s.reactionWindow === null && s.pendingChoice === null))
    )
      throw new Error("Monster damage cursor has no resumable wait.");
    const root = s.effectStack.find(
      (e) =>
        e.kind === "damage-batch" &&
        e.effectId === `${battle.effectId}:damage-batch`,
    );
    if (root !== undefined) {
      const items = root.payload.damageItems;
      if (
        root.parentEffectId !== null ||
        root.sourcePlayerId !== null ||
        root.payload.sourceEffectId !== battle.effectId ||
        !Array.isArray(items) ||
        items.some(
          (item: AppliedDamage) =>
            !item ||
            item.sourcePlayerId !== null ||
            item.sourceMonsterId !== battle.monsterId ||
            !item.itemId?.startsWith(`${battle.effectId}:`) ||
            s.players[item.targetPlayerId] === undefined ||
            !Number.isSafeInteger(item.amount) ||
            item.amount < 0 ||
            item.element !== definition.element ||
            !isCanonicalHpEvolutionMask(item.hpEvoMask) ||
            !item.hpEvoMask.includes("from-nmb"),
        )
      )
        throw new Error("Invalid monster damage source binding.");
    }
    // A child may be prevention/counter, pursuit, or death aftermath. Follow
    // actual parent links instead of assuming every generated child ID shares
    // the root prefix (reaction cards have their own event-derived identity).
    const bound = (id: string, seen = new Set<string>()): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      if (sourceBound(id)) return true;
      const effect = s.effectStack.find((e) => e.effectId === id);
      if (effect === undefined) return false;
      const parent = effect.parentEffectId ?? effect.payload.sourceEffectId;
      return typeof parent === "string" && bound(parent, seen);
    };
    const w = s.reactionWindow,
      c = s.pendingChoice,
      dying = s.dyingBatch;
    if (
      s.effectStack.some((e) => !bound(e.effectId)) ||
      (dying !== null && !sourceBound(dying.sourceEffectId)) ||
      (w !== null &&
        (w.continuation.effectId !== w.effectId || !bound(w.effectId))) ||
      (c !== null &&
        !bound(c.continuation.effectId) &&
        c.continuation.effectId !== dying?.sourceEffectId)
    )
      throw new Error("Unbound monster child effect.");
    for (const wait of [w, c].filter((v) => v !== null)) {
      if (
        !Number.isSafeInteger(wait.openedAt) ||
        wait.openedAt < battle.openedAt ||
        !Number.isSafeInteger(wait.deadlineAt) ||
        wait.deadlineAt !== wait.openedAt + ACTION_DEADLINE_MS
      )
        throw new Error("Invalid monster child deadline.");
    }
  }
}

function settle(input: MatchState, at: number): MatchState {
  const flow = input.encounterState.resolution!,
    battle = input.encounterState.battle!;
  if (!quiet(input)) return input;
  if (input.phase !== "finished")
    return {
      ...input,
      encounterState: {
        ...input.encounterState,
        resolution: { ...flow, updatedAt: at },
        battle: { ...battle, stage: "combat-ready", updatedAt: at },
      },
    };
  return {
    ...input,
    encounterDiscard: [...input.encounterDiscard, battle.monsterId],
    encounterState: {
      ...input.encounterState,
      resolution: {
        ...flow,
        heldCardId: null,
        stage: "completed",
        result: null,
        rewardDrawCount: 0,
        scoreTiming: "none",
        updatedAt: at,
      },
      battle: { ...battle, stage: "aborted", updatedAt: at },
    },
  };
}

function transition(
  input: MatchState,
  operation: "start" | "continue",
  at: number,
) {
  validateEncounterRuntime(input);
  validateMonsterBattle(input, operation === "continue");
  const flow = input.encounterState.resolution;
  if (
    flow === null ||
    !Number.isSafeInteger(at) ||
    at < flow.updatedAt ||
    !Number.isSafeInteger(at + ACTION_DEADLINE_MS)
  )
    throw new Error("Invalid monster debut time or flow.");
  let state = input;
  let damageItems: readonly AppliedDamage[] = [];
  const swappedPlayerIds: PlayerId[] = [];
  if (operation === "continue") {
    if (input.encounterState.battle?.stage !== "debut-damage" || !quiet(input))
      throw new Error("Monster debut child still pending.");
    state = settle(input, at);
  } else {
    if (
      input.phase !== "playing" ||
      input.turn?.phase !== "encounter" ||
      !quiet(input) ||
      flow.stage !== "monster-effects" ||
      flow.heldCardId === null ||
      input.encounterState.battle !== null ||
      input.encounterState.npc !== null ||
      input.activePlayerId !== flow.activePlayerId ||
      input.players[flow.activePlayerId]?.alive !== true ||
      flow.pendingEffect !== null ||
      flow.npcDecision !== null
    )
      throw new Error("Monster debut is not ready or already started.");
    const definition = encounterDefinition(flow.heldCardId);
    if (definition.kind !== "monster")
      throw new Error("Expected held monster.");
    const monsterId = definition.id,
      effectId = effectIdFor(input, monsterId);
    const actor = flow.activePlayerId,
      supporter = realPlayer(input, flow.supporter),
      hinder = realPlayer(input, flow.hinder);
    const intents: DamageIntent[] = [];
    const harm = (id: PlayerId, n: number) => {
      if (n > 0 && input.players[id]?.alive === true)
        intents.push({
          itemId: `${effectId}:${id}`,
          sourcePlayerId: null,
          sourceMonsterId: monsterId,
          targetPlayerId: id,
          amount: n,
          element: definition.element,
          hpEvoMask: ["from-nmb"],
        });
    };
    const living = Object.values(input.players)
      .filter((p) => p.alive)
      .sort((a, b) => a.seat - b.seat);
    const bonuses: Partial<Record<PlayerId, number>> = {};
    if (
      monsterId === "xyy.monster.gs01" &&
      hinder !== null &&
      hinder !== actor
    ) {
      state = {
        ...state,
        players: {
          ...state.players,
          [actor]: {
            ...state.players[actor]!,
            hand: input.players[hinder]!.hand,
          },
          [hinder]: {
            ...state.players[hinder]!,
            hand: input.players[actor]!.hand,
          },
        },
      };
      swappedPlayerIds.push(actor, hinder);
    } else if (monsterId === "xyy.monster.gh03" && supporter !== null) {
      harm(supporter, input.players[actor]!.strength - 1);
    } else if (monsterId === "xyy.monster.gh04") {
      for (const player of living) harm(player.id, 2);
    } else if (monsterId === "xyy.monster.gl02" && supporter !== null) {
      bonuses[supporter] = 2;
    } else if (monsterId === "xyy.monster.gt02") {
      for (const player of living)
        if (
          player.id !== actor &&
          player.id !== supporter &&
          player.id !== hinder
        )
          harm(player.id, player.hand.length);
    }
    // No-debut definitions still produce an explicit cursor. This does not
    // finish or skip their win/loss/pet/consumption effects.
    const battle: MonsterBattleState = {
      monsterId,
      effectId,
      stage: "combat-ready",
      cards: null,
      cardWindow: null,
      remainingCardQuota: {},
      openedAt: at,
      updatedAt: at,
      strength:
        definition.strength + (monsterId === "xyy.monster.gt03" ? 3 : 0),
      agility: definition.agility,
      playerStrengthBonuses: bonuses,
      damageSourceParents: { [effectId]: null },
    };
    state = {
      ...state,
      encounterState: {
        ...state.encounterState,
        battle,
        resolution: { ...flow, updatedAt: at },
      },
    };
    if (intents.length > 0) {
      damageItems = planDamageBatch(state, intents);
      state = beginDamageResponse(
        {
          ...state,
          encounterState: {
            ...state.encounterState,
            battle: { ...battle, stage: "debut-damage" },
          },
        },
        effectId,
        null,
        damageItems,
        at,
      );
      state = settle(state, at);
    }
  }
  validateEncounterRuntime(state);
  validateMonsterBattle(state);
  return {
    state,
    report: {
      battle: state.encounterState.battle,
      swappedPlayerIds,
      damageItems,
    },
  };
}

export function reduceMonsterDebutEvent(
  state: MatchState,
  event: DomainEvent,
): MatchState {
  const { operation, resolvedAt, matchVersion, report } = event.payload;
  if (
    event.type !== EVENT ||
    event.matchId !== state.matchId ||
    event.rulesetVersion !== state.rulesetVersion ||
    event.sequence !== state.eventSequence + 1 ||
    matchVersion !==
      state.version + (event.causationEventId === null ? 1 : 0) ||
    (operation !== "start" && operation !== "continue") ||
    typeof resolvedAt !== "number"
  )
    throw new Error("Invalid monster debut event.");
  const expected = transition(state, operation, resolvedAt);
  // v12 logs predate battle cards. Compare their unchanged debut report against
  // the v12 shape; never erase actual card state or repair a partial new report.
  const oldReport = report as { battle?: Record<string, unknown> } | null;
  let comparable: unknown = expected.report;
  if (
    oldReport?.battle &&
    ["cards", "cardWindow", "remainingCardQuota"].every(
      (key) => !Object.hasOwn(oldReport.battle!, key),
    )
  ) {
    const { cards, cardWindow, remainingCardQuota, ...legacyBattle } =
      expected.report.battle!;
    if (
      cards !== null ||
      cardWindow !== null ||
      Object.keys(remainingCardQuota).length
    )
      throw new Error("Cannot downgrade a battle-card report.");
    comparable = { ...expected.report, battle: legacyBattle };
  }
  if (JSON.stringify(comparable) !== JSON.stringify(report))
    throw new Error("Monster debut report mismatch.");
  return {
    ...expected.state,
    version: matchVersion as number,
    eventSequence: event.sequence,
  };
}
function execute(
  state: MatchState,
  operation: "start" | "continue",
  commandId: CommandId,
  at: number,
  causationEventId: string | null,
) {
  const planned = transition(state, operation, at);
  const event: DomainEvent = {
    type: EVENT,
    eventId: `${state.matchId}:event:${state.eventSequence + 1}`,
    sequence: state.eventSequence + 1,
    matchId: state.matchId,
    rulesetVersion: state.rulesetVersion,
    causationCommandId: commandId,
    causationEventId,
    payload: {
      operation,
      resolvedAt: at,
      matchVersion: state.version + (causationEventId === null ? 1 : 0),
      report: planned.report,
    },
  };
  return {
    accepted: true as const,
    state: reduceMonsterDebutEvent(state, event),
    events: [event],
  };
}
export function beginMonsterDebut(
  state: MatchState,
  commandId: CommandId,
  at: number,
  causationEventId: string | null = null,
) {
  return execute(state, "start", commandId, at, causationEventId);
}
export function continueMonsterAfterDamage(
  state: MatchState,
  commandId: CommandId,
  at: number,
  causationEventId: string | null,
): Extract<ApplyCommandResult, { accepted: true }> {
  if (state.encounterState.battle?.stage !== "debut-damage" || !quiet(state))
    return { accepted: true, state, events: [] };
  return execute(state, "continue", commandId, at, causationEventId);
}
