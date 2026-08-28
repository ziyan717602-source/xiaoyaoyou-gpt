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
import type { AvailableAction, MatchState } from "./index.js";
import type { MonsterId } from "./encounter-content.js";
import { validateMonsterBattle } from "./monster-debut.js";
import { validateEncounterRuntime } from "./npc-effects.js";
import { beginDamageResponse } from "./reaction.js";
import { planDamageBatch } from "./damage-dying.js";
import { withPetOwnership } from "./pet-effects.js";
import {
  finishMonsterBattle,
  chooseCapturedPet,
} from "./encounter-resolution.js";
import { nextInt } from "./random.js";
import { encounterDefinition } from "./encounter-definitions.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";
import {
  startMonsterOutcomeEffects,
  advanceMonsterOutcomeEffects,
  chooseMonsterOutcomeEffect,
  projectMonsterOutcomeEffects,
  type MonsterOutcomeCursor,
  type MonsterOutcomeTransition,
  validateMonsterOutcomeCursor,
} from "./monster-outcome-effects.js";

const quiet = (s: MatchState) =>
  !s.pendingChoice &&
  !s.reactionWindow &&
  !s.dyingBatch &&
  s.effectStack.length === 0;
type Operation =
  | { readonly kind: "start" }
  | { readonly kind: "continue" }
  | {
      readonly kind: "choose";
      readonly playerId: PlayerId;
      readonly choiceId: string;
      readonly selections: readonly string[] | null;
    };
function replace(
  s: MatchState,
  cursor: MonsterOutcomeCursor,
  stage: NonNullable<MatchState["encounterState"]["battle"]>["stage"],
  at: number,
): MatchState {
  return {
    ...s,
    encounterState: {
      ...s.encounterState,
      resolution: { ...s.encounterState.resolution!, updatedAt: at },
      battle: {
        ...s.encounterState.battle!,
        stage,
        outcome: cursor,
        updatedAt: at,
      },
    },
  };
}
function complete(s: MatchState, at: number): MatchState {
  const b = s.encounterState.battle!,
    flow = s.encounterState.resolution!;
  return {
    ...s,
    encounterState: {
      ...s.encounterState,
      resolution: { ...flow, supporter: null, hinder: null, updatedAt: at },
      battle: {
        ...b,
        stage: "complete",
        playerStrengthBonuses: {},
        updatedAt: at,
      },
    },
  };
}
function abort(s: MatchState, at: number): MatchState {
  const flow = s.encounterState.resolution!;
  return complete(
    {
      ...s,
      encounterDiscard: [...s.encounterDiscard, flow.heldCardId!],
      encounterState: {
        ...s.encounterState,
        resolution: {
          ...flow,
          stage: "completed",
          heldCardId: null,
          petDecision: null,
          result: null,
          rewardDrawCount: 0,
          scoreTiming: "none",
        },
      },
    },
    at,
  );
}
function capture(s: MatchState, at: number): MatchState {
  const b = s.encounterState.battle!,
    c = b.outcome!,
    flow = s.encounterState.resolution!;
  if (c.passiveCapture) {
    const { ownerPlayerId, replacedPetId } = c.passiveCapture;
    if (
      c.monsterId !== "xyy.monster.gt04" ||
      c.result !== "lose" ||
      !s.encounterState.pets[ownerPlayerId]?.includes(replacedPetId)
    )
      throw new Error("Invalid GT04 passive capture.");
    const result = withPetOwnership(
      {
        ...s,
        encounterDiscard: [...s.encounterDiscard, replacedPetId],
        encounterState: {
          ...s.encounterState,
          resolution: {
            ...flow,
            stage: "completed",
            heldCardId: null,
            result: "monster-battle",
            rewardDrawCount: 2,
            scoreTiming: "turn-end",
          },
        },
      },
      {
        ...s.encounterState.pets,
        [ownerPlayerId]: s.encounterState.pets[ownerPlayerId]!.map((id) =>
          id === replacedPetId ? c.monsterId : id,
        ),
      },
    );
    return complete(result, at);
  }
  const result = finishMonsterBattle(
    flow,
    {
      ...s,
      pets: s.encounterState.pets,
      companions: s.encounterState.companions,
    },
    {
      outcome: c.result === "win" ? "win" : "lose",
      capture: c.result === "win",
      ownerPlayerId: flow.activePlayerId,
    },
    at,
  );
  let next: MatchState = {
    ...s,
    encounterDiscard: result.zones.encounterDiscard,
    encounterState: { ...s.encounterState, resolution: result.flow },
  };
  next = withPetOwnership(next, result.zones.pets);
  return result.flow.stage === "pet-choice"
    ? replace(next, c, "capture-choice", at)
    : complete(next, at);
}
function install(initial: MonsterOutcomeTransition, at: number) {
  let result = initial;
  const reports: unknown[] = [];
  for (let guard = 0; guard < 32; guard++) {
    const c = result.cursor;
    const stage = c.stage === "damage" ? "outcome-damage" : "outcome-choice";
    let state = replace(result.state, c, stage, at);
    reports.push({
      cursor: c,
      damageIntents: result.damageIntents,
      cures: result.cures,
    });
    if (c.stage === "effects-complete")
      return { state: capture(state, at), reports };
    if (c.stage === "choice") return { state, reports };
    if (c.stage !== "damage" || result.damageIntents === null)
      throw new Error("Missing outcome damage batch.");
    state = beginDamageResponse(
      state,
      `${c.effectId}:${c.stepIndex}`,
      null,
      planDamageBatch(state, result.damageIntents),
      at,
      state.encounterState.battle!.effectId,
    );
    if (!quiet(state)) return { state, reports };
    if (state.phase === "finished") return { state: abort(state, at), reports };
    result = advanceMonsterOutcomeEffects(state, c, at);
  }
  throw new Error("Monster outcome did not reach a wait.");
}
function transition(s: MatchState, op: Operation, at: number) {
  validateMonsterBattle(s, op.kind === "continue");
  const b = s.encounterState.battle;
  if (!b || !Number.isSafeInteger(at) || at < b.updatedAt || !quiet(s))
    throw new Error("Monster outcome cannot advance.");
  let result: ReturnType<typeof install>;
  if (op.kind === "start") {
    if (
      b.outcome !== undefined ||
      !["outcome-ready", "escaped"].includes(b.stage)
    )
      throw new Error("Battle has not finished card rounds.");
    result = install(
      startMonsterOutcomeEffects(
        s,
        b.stage === "escaped"
          ? "escape"
          : b.cards!.outcome!.activeSideWins
            ? "win"
            : "lose",
        at,
      ),
      at,
    );
  } else if (op.kind === "continue") {
    if (b.stage !== "outcome-damage" || !b.outcome)
      throw new Error("No outcome damage continuation.");
    result =
      s.phase === "finished"
        ? { state: abort(s, at), reports: [] }
        : install(advanceMonsterOutcomeEffects(s, b.outcome, at), at);
  } else if (b.stage === "capture-choice") {
    const flow = s.encounterState.resolution!,
      choice = flow.petDecision!;
    if (
      choice.ownerPlayerId !== op.playerId ||
      choice.choiceId !== op.choiceId ||
      at < choice.openedAt ||
      (op.selections !== null && at > choice.deadlineAt)
    )
      throw new Error("Invalid capture choice.");
    let state = s,
      selected = op.selections;
    if (selected === null) {
      if (
        at !==
        (s.connections[op.playerId]?.status === "auto"
          ? choice.openedAt
          : choice.deadlineAt)
      )
        throw new Error("Capture timeout is not due.");
      const drawn = nextInt(s.rng, choice.cardIds.length);
      state = { ...state, rng: drawn.rng };
      selected = [[...choice.cardIds].sort()[drawn.value]!];
    }
    if (selected.length !== 1) throw new Error("Capture must retain one pet.");
    const selectedResult = chooseCapturedPet(
      flow,
      {
        ...state,
        pets: state.encounterState.pets,
        companions: state.encounterState.companions,
      },
      op.playerId,
      choice.choiceId,
      selected[0] as MonsterId,
      at,
    );
    state = withPetOwnership(
      {
        ...state,
        encounterDiscard: selectedResult.zones.encounterDiscard,
        encounterState: {
          ...state.encounterState,
          resolution: selectedResult.flow,
        },
      },
      selectedResult.zones.pets,
    );
    result = {
      state: complete(state, at),
      reports: [{ keptPet: selected[0] }],
    };
  } else {
    if (
      b.stage !== "outcome-choice" ||
      !b.outcome ||
      !b.outcome.choices.some(
        (c) => c.choiceId === op.choiceId && c.playerId === op.playerId,
      )
    )
      throw new Error("Invalid monster outcome choice.");
    result = install(
      chooseMonsterOutcomeEffect(s, b.outcome, op.playerId, op.selections, at),
      at,
    );
  }
  validateEncounterRuntime(result.state);
  validateMonsterBattle(result.state);
  return {
    state: result.state,
    report: {
      steps: result.reports,
      battle: result.state.encounterState.battle,
      flow: result.state.encounterState.resolution,
      pets: result.state.encounterState.pets,
      encounterDiscard: result.state.encounterDiscard,
    },
  };
}
export function reduceMonsterOutcomeEvent(
  s: MatchState,
  e: DomainEvent,
): MatchState {
  const { operation, resolvedAt, matchVersion, report } = e.payload;
  if (
    e.type !== "monster.outcome" ||
    e.matchId !== s.matchId ||
    e.rulesetVersion !== s.rulesetVersion ||
    e.sequence !== s.eventSequence + 1 ||
    matchVersion !== s.version + (e.causationEventId === null ? 1 : 0) ||
    typeof resolvedAt !== "number" ||
    !operation ||
    typeof operation !== "object" ||
    !["start", "continue", "choose"].includes((operation as Operation).kind)
  )
    throw new Error("Invalid monster outcome event.");
  const next = transition(s, operation as Operation, resolvedAt);
  if (JSON.stringify(next.report) !== JSON.stringify(report))
    throw new Error("Monster outcome report mismatch.");
  return {
    ...next.state,
    version: matchVersion as number,
    eventSequence: e.sequence,
  };
}
function execute(
  s: MatchState,
  op: Operation,
  commandId: CommandId,
  at: number,
  causationEventId: string | null = null,
) {
  const planned = transition(s, op, at);
  const event: DomainEvent = {
    type: "monster.outcome",
    eventId: `${s.matchId}:event:${s.eventSequence + 1}`,
    sequence: s.eventSequence + 1,
    matchId: s.matchId,
    rulesetVersion: s.rulesetVersion,
    causationCommandId: commandId,
    causationEventId,
    payload: {
      operation: op,
      resolvedAt: at,
      matchVersion: s.version + (causationEventId === null ? 1 : 0),
      report: planned.report,
    },
  };
  return {
    accepted: true as const,
    state: reduceMonsterOutcomeEvent(s, event),
    events: [event],
  };
}
/** Internal combat handoff; never a player-selected win/lose command. */
export function beginMonsterOutcome(
  s: MatchState,
  commandId: CommandId,
  at: number,
  causationEventId: string | null = null,
) {
  return execute(s, { kind: "start" }, commandId, at, causationEventId);
}
export function continueMonsterOutcome(
  s: MatchState,
  commandId: CommandId,
  at: number,
  causationEventId: string | null,
): Extract<ApplyCommandResult, { accepted: true }> {
  return s.encounterState.battle?.stage === "outcome-damage" && quiet(s)
    ? execute(s, { kind: "continue" }, commandId, at, causationEventId)
    : { accepted: true, state: s, events: [] };
}
export function monsterOutcomeActions(
  s: MatchState,
  viewer: PlayerId,
): AvailableAction[] {
  const b = s.encounterState.battle;
  if (!b?.outcome || s.phase !== "playing") return [];
  const pet = s.encounterState.resolution?.petDecision;
  const choices =
    b.stage === "capture-choice" && pet?.ownerPlayerId === viewer
      ? [
          {
            choiceId: pet.choiceId,
            optionIds: pet.cardIds,
            minSelections: 1,
            maxSelections: 1,
            optional: false,
          },
        ]
      : b.stage === "outcome-choice"
        ? projectMonsterOutcomeEffects(b.outcome, viewer).availableActions
        : [];
  return choices.map((c) => ({
    type: "submit-choice",
    choiceId: c.choiceId,
    optionIds: c.optionIds,
    minSelections: c.minSelections,
    maxSelections: c.maxSelections,
    optional: c.optional,
  }));
}
export function applyMonsterOutcomeCommand(
  s: MatchState,
  e: CommandEnvelope,
  at: number,
): ApplyCommandResult {
  const cmd = e.command;
  if (cmd.type !== "submit-choice")
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: s.version,
    };
  try {
    return execute(
      s,
      {
        kind: "choose",
        playerId: e.playerId,
        choiceId: cmd.choiceId,
        selections: cmd.selections,
      },
      e.commandId,
      at,
    );
  } catch {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: s.version,
    };
  }
}
export function applyMonsterOutcomeTimeout(
  s: MatchState,
  cmd: Extract<EngineCommand, { origin: "system-timeout" }>,
  playerId: PlayerId,
): ApplyCommandResult {
  const action = monsterOutcomeActions(s, playerId)[0];
  if (!action || action.type !== "submit-choice")
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: s.version,
    };
  try {
    return execute(
      s,
      { kind: "choose", playerId, choiceId: action.choiceId, selections: null },
      cmd.commandId,
      cmd.deadlineAt,
    );
  } catch {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: s.version,
    };
  }
}

export function validateMonsterOutcome(s: MatchState, transient = false): void {
  const b = s.encounterState.battle!,
    c = b.outcome!,
    f = s.encounterState.resolution!;
  const fail = () => {
    throw new Error("Invalid monster outcome snapshot.");
  };
  if (
    !c ||
    c.monsterId !== b.monsterId ||
    c.effectId !==
      `${f.flowId}:monster:${f.revealCount}:${b.monsterId}:outcome` ||
    !["win", "lose", "escape"].includes(c.result) ||
    !Number.isSafeInteger(c.stepIndex) ||
    c.stepIndex < 0 ||
    !Number.isSafeInteger(c.openedAt) ||
    c.openedAt < b.openedAt ||
    !Number.isSafeInteger(c.updatedAt) ||
    c.updatedAt < c.openedAt ||
    c.updatedAt > b.updatedAt ||
    !Array.isArray(c.choices) ||
    b.cardWindow !== null ||
    !b.cards ||
    b.cards.pendingEffectId !== null ||
    b.cards.plays.some((p) => p.result === "pending")
  )
    fail();
  if (
    c.result === "escape"
      ? b.cards!.outcome !== null
      : b.cards!.outcome?.activeSideWins !== (c.result === "win")
  )
    fail();
  validateMonsterOutcomeCursor(s, c);
  if (b.stage === "complete") {
    if (
      f.stage !== "completed" ||
      f.heldCardId !== null ||
      f.petDecision !== null ||
      !quiet(s) ||
      (s.phase !== "finished" && c.stage !== "effects-complete")
    )
      fail();
    return;
  }
  if (
    f.heldCardId !== b.monsterId ||
    (s.phase !== "finished" && s.turn?.phase !== "encounter")
  )
    fail();
  if (b.stage === "capture-choice") {
    const p = f.petDecision;
    const old = p?.cardIds[0] ? encounterDefinition(p.cardIds[0]) : null;
    const monster = encounterDefinition(b.monsterId);
    if (
      f.stage !== "pet-choice" ||
      !p ||
      c.stage !== "effects-complete" ||
      c.result !== "win" ||
      !quiet(s) ||
      p.ownerPlayerId !== f.activePlayerId ||
      p.choiceId !== `${f.flowId}:pet:${f.revealCount}` ||
      !Number.isSafeInteger(p.openedAt) ||
      p.openedAt !== b.updatedAt ||
      p.deadlineAt !== p.openedAt + ACTION_DEADLINE_MS ||
      p.cardIds.length !== 2 ||
      old?.kind !== "monster" ||
      monster.kind !== "monster" ||
      old.element !== monster.element ||
      p.cardIds[1] !== b.monsterId ||
      !s.encounterState.pets[p.ownerPlayerId]?.includes(p.cardIds[0]!)
    )
      fail();
  } else if (b.stage === "outcome-choice") {
    if (
      f.stage !== "monster-effects" ||
      c.stage !== "choice" ||
      !quiet(s) ||
      !c.choices.length ||
      c.choices.every((x) => x.selections !== null)
    )
      fail();
    const owners = new Set<string>();
    for (const x of c.choices) {
      if (
        owners.has(x.playerId) ||
        !s.players[x.playerId] ||
        x.choiceId !== `${c.effectId}:${c.stepIndex}:choice:${x.playerId}` ||
        x.deadlineAt !== x.openedAt + ACTION_DEADLINE_MS ||
        x.openedAt < c.openedAt ||
        x.openedAt > c.updatedAt ||
        !Array.isArray(x.optionIds) ||
        !x.optionIds.length ||
        new Set(x.optionIds).size !== x.optionIds.length ||
        (x.selections !== null &&
          (!Array.isArray(x.selections) ||
            x.selections.some((id) => !x.optionIds.includes(id))))
      )
        fail();
      owners.add(x.playerId);
    }
  } else if (b.stage === "outcome-damage") {
    if (
      f.stage !== "monster-effects" ||
      c.stage !== "damage" ||
      (!transient && quiet(s))
    )
      fail();
  } else fail();
}
