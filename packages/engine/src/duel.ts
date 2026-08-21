import { createHash } from "node:crypto";
import {
  type CommandEnvelope,
  type CommandId,
  type PlayerId,
} from "@xiaoyaoyou/protocol";
import type {
  ApplyCommandResult,
  DomainEvent,
  EngineCommand,
} from "./architecture.js";
import { planDamageBatch } from "./damage-dying.js";
import type {
  DiceRollState,
  DuelContinuation,
  MatchState,
  PendingChoice,
} from "./index.js";
import { nextInt } from "./random.js";
import { beginDamageResponse } from "./reaction.js";
import { heroHasSkill, type CardInstanceId } from "./setup-content.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";

const DIE_FACES = [1, 2, 3, 4, 5, 6] as const;
const DIE_OPTION_SET_HASH = createHash("sha256")
  .update(JSON.stringify(DIE_FACES))
  .digest("hex");

function numberPayload(event: Readonly<DomainEvent>, key: string): number {
  const value = event.payload[key];
  if (typeof value !== "number") throw new Error(`Invalid ${key} payload.`);
  return value;
}

function stringPayload(event: Readonly<DomainEvent>, key: string): string {
  const value = event.payload[key];
  if (typeof value !== "string") throw new Error(`Invalid ${key} payload.`);
  return value;
}

function stringsPayload(
  event: Readonly<DomainEvent>,
  key: string,
): readonly string[] {
  const value = event.payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${key} payload.`);
  }
  return value as string[];
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function currentTarget(
  state: Readonly<MatchState>,
  duel: Readonly<DuelContinuation>,
): PlayerId {
  const target = duel.targetPlayerIds[duel.currentTargetIndex];
  if (target === undefined || !(target in state.players)) {
    throw new Error("Duel target continuation is invalid.");
  }
  return target;
}

function currentRoller(duel: Readonly<DuelContinuation>): PlayerId {
  if (duel.stage === "rolling-owner") return duel.ownerPlayerId;
  if (duel.stage === "rolling-target") {
    const target = duel.targetPlayerIds[duel.currentTargetIndex];
    if (target === undefined) throw new Error("Duel target is missing.");
    return target;
  }
  throw new Error("Duel is not waiting on a die roll.");
}

function rollForStage(duel: Readonly<DuelContinuation>): DiceRollState | null {
  return duel.stage === "rolling-owner" ? duel.ownerRoll : duel.targetRoll;
}

function rerollChoice(
  state: Readonly<MatchState>,
  duel: Readonly<DuelContinuation>,
  roll: Readonly<DiceRollState>,
  openedAt: number,
): PendingChoice | null {
  const roller = state.players[roll.playerId];
  if (
    roller?.alive !== true ||
    roller.heroId === null ||
    !heroHasSkill(roller.heroId, "xyy.skill.jn20102") ||
    roller.hand.length === 0
  ) {
    return null;
  }
  const choiceId = `${duel.sourceEffectId}:choice:${duel.currentTargetIndex}:${roll.playerId}:${roll.attempt}`;
  return {
    choiceId,
    playerIds: [roll.playerId],
    prompt: "hero-skill:xyy.skill.jn20102",
    minSelections: 0,
    maxSelections: 1,
    optionIds: roller.hand,
    optional: true,
    status: "open",
    openedAt,
    deadlineAt: openedAt + ACTION_DEADLINE_MS,
    fallback: "pass",
    continuation: {
      continuationId: `${choiceId}:continuation`,
      effectId: duel.sourceEffectId,
      step: "after-jn20102-reroll",
      locals: {
        rollerPlayerId: roll.playerId,
        targetIndex: duel.currentTargetIndex,
        attempt: roll.attempt,
      },
      resumeWith: "resolve-jn20102-reroll",
    },
  };
}

function acceptedStage(duel: Readonly<DuelContinuation>): DuelContinuation {
  return duel.stage === "rolling-owner"
    ? { ...duel, stage: "rolling-target", attempt: 0 }
    : { ...duel, stage: "ready-damage", attempt: 0 };
}

function damageIntents(
  state: Readonly<MatchState>,
  duel: Readonly<DuelContinuation>,
) {
  const targetPlayerId = currentTarget(state, duel);
  const ownerRoll = duel.ownerRoll;
  const targetRoll = duel.targetRoll;
  if (ownerRoll === null || targetRoll === null) {
    throw new Error("Duel damage requires two accepted rolls.");
  }
  const candidates =
    ownerRoll.value > targetRoll.value
      ? [{ targetPlayerId, amount: 3 }]
      : ownerRoll.value < targetRoll.value
        ? [{ targetPlayerId: duel.ownerPlayerId, amount: 3 }]
        : [
            { targetPlayerId, amount: 2 },
            { targetPlayerId: duel.ownerPlayerId, amount: 2 },
          ];
  return candidates
    .filter(({ targetPlayerId: candidate }) => state.players[candidate]?.alive)
    .map(({ targetPlayerId: candidate, amount }, index) => ({
      itemId: `${duel.sourceEffectId}:target:${duel.currentTargetIndex}:damage:${index}`,
      sourcePlayerId: duel.ownerPlayerId,
      targetPlayerId: candidate,
      amount,
      element: "neutral",
      hpEvoMask: ["tux-inavo", "alive", "rsv-duel"] as const,
    }));
}

export function reduceDuelEvent(
  state: Readonly<MatchState>,
  event: Readonly<DomainEvent>,
): MatchState {
  if (
    event.matchId !== state.matchId ||
    event.sequence !== state.eventSequence + 1 ||
    event.rulesetVersion !== state.rulesetVersion
  ) {
    throw new Error("Duel event does not extend the current match head.");
  }
  if (state.phase !== "playing" || state.turn?.phase !== "action") {
    throw new Error("Duel events require the action phase.");
  }
  const matchVersion = numberPayload(event, "matchVersion");
  const expectedMatchVersion =
    event.causationEventId === null ? state.version + 1 : state.version;
  if (matchVersion !== expectedMatchVersion) {
    throw new Error("Duel event has an invalid match version.");
  }

  let next: MatchState;
  if (event.type === "duel.started") {
    const ownerPlayerId = stringPayload(event, "ownerPlayerId");
    const skillId = stringPayload(event, "skillId");
    const cardInstanceIds = stringsPayload(
      event,
      "cardInstanceIds",
    ) as readonly CardInstanceId[];
    const targetPlayerIds = stringsPayload(
      event,
      "targetPlayerIds",
    ) as readonly PlayerId[];
    const sourceEffectId = stringPayload(event, "sourceEffectId");
    const owner = state.players[ownerPlayerId];
    const previousCount =
      state.turn.usedSkillCounts?.["xyy.skill.jn30601"] ?? 0;
    const requiredCost = previousCount + 1;
    if (
      skillId !== "xyy.skill.jn30601" ||
      state.activePlayerId !== ownerPlayerId ||
      owner?.alive !== true ||
      owner.heroId === null ||
      !heroHasSkill(owner.heroId, "xyy.skill.jn30601") ||
      !heroHasSkill(owner.heroId, "xyy.skill.jn30602") ||
      state.turn.duelContinuation !== undefined ||
      state.pendingChoice !== null ||
      state.reactionWindow !== null ||
      state.dyingBatch !== null ||
      cardInstanceIds.length !== requiredCost ||
      new Set(cardInstanceIds).size !== cardInstanceIds.length ||
      cardInstanceIds.some((card) => !owner.hand.includes(card)) ||
      targetPlayerIds.length < 1 ||
      targetPlayerIds.length > 2 ||
      new Set(targetPlayerIds).size !== targetPlayerIds.length ||
      targetPlayerIds.some(
        (targetPlayerId) =>
          targetPlayerId === ownerPlayerId ||
          state.players[targetPlayerId]?.alive !== true,
      ) ||
      sourceEffectId !== `${state.matchId}:effect:${event.causationCommandId}`
    ) {
      throw new Error("JN30601 start event is not applicable.");
    }
    const paid = new Set(cardInstanceIds);
    next = {
      ...state,
      players: {
        ...state.players,
        [ownerPlayerId]: {
          ...owner,
          hand: owner.hand.filter((card) => !paid.has(card)),
        },
      },
      discardPile: [...state.discardPile, ...cardInstanceIds],
      turn: {
        ...state.turn,
        usedSkillCounts: {
          ...state.turn.usedSkillCounts,
          "xyy.skill.jn30601": requiredCost,
        },
        duelContinuation: {
          kind: "jn30601-duel",
          sourceEffectId,
          ownerPlayerId,
          targetPlayerIds,
          currentTargetIndex: 0,
          stage: "rolling-owner",
          attempt: 0,
          ownerRoll: null,
          targetRoll: null,
        },
      },
    };
  } else if (event.type === "duel.die-rolled") {
    const duel = state.turn.duelContinuation;
    if (
      duel === undefined ||
      (duel.stage !== "rolling-owner" && duel.stage !== "rolling-target") ||
      state.pendingChoice !== null ||
      rollForStage(duel) !== null
    ) {
      throw new Error("Duel die roll is not currently applicable.");
    }
    const playerId = stringPayload(event, "playerId");
    const value = numberPayload(event, "value");
    const attempt = numberPayload(event, "attempt");
    const rolledAt = numberPayload(event, "rolledAt");
    const planned = nextInt(state.rng, DIE_FACES.length);
    if (
      playerId !== currentRoller(duel) ||
      attempt !== duel.attempt ||
      value !== planned.value + 1 ||
      event.payload.optionSetHash !== DIE_OPTION_SET_HASH ||
      event.payload.rngCursorStart !== state.rng.cursor ||
      event.payload.rngCursorEnd !== planned.rng.cursor
    ) {
      throw new Error("Duel roll disagrees with deterministic dice evidence.");
    }
    const roll: DiceRollState = {
      playerId,
      value,
      attempt,
      rngCursorStart: state.rng.cursor,
      rngCursorEnd: planned.rng.cursor,
      optionSetHash: DIE_OPTION_SET_HASH,
    };
    const withRoll: DuelContinuation =
      duel.stage === "rolling-owner"
        ? { ...duel, ownerRoll: roll }
        : { ...duel, targetRoll: roll };
    const choice = rerollChoice(state, withRoll, roll, rolledAt);
    next = {
      ...state,
      rng: planned.rng,
      turn: {
        ...state.turn,
        duelContinuation: choice === null ? acceptedStage(withRoll) : withRoll,
      },
      pendingChoice: choice,
    };
  } else if (event.type === "duel.roll-accepted") {
    const duel = state.turn.duelContinuation;
    const choice = state.pendingChoice;
    const playerId = stringPayload(event, "playerId");
    if (
      duel === undefined ||
      choice === null ||
      choice.prompt !== "hero-skill:xyy.skill.jn20102" ||
      choice.choiceId !== stringPayload(event, "choiceId") ||
      choice.playerIds[0] !== playerId ||
      currentRoller(duel) !== playerId ||
      rollForStage(duel) === null
    ) {
      throw new Error("JN20102 pass is not applicable.");
    }
    next = {
      ...state,
      turn: { ...state.turn, duelContinuation: acceptedStage(duel) },
      pendingChoice: null,
    };
  } else if (event.type === "duel.reroll-requested") {
    const duel = state.turn.duelContinuation;
    const choice = state.pendingChoice;
    const playerId = stringPayload(event, "playerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const player = state.players[playerId];
    if (
      duel === undefined ||
      choice === null ||
      choice.prompt !== "hero-skill:xyy.skill.jn20102" ||
      choice.choiceId !== stringPayload(event, "choiceId") ||
      choice.playerIds[0] !== playerId ||
      currentRoller(duel) !== playerId ||
      rollForStage(duel) === null ||
      player === undefined ||
      !choice.optionIds.includes(cardInstanceId) ||
      !player.hand.includes(cardInstanceId)
    ) {
      throw new Error("JN20102 reroll payment is not applicable.");
    }
    const clearedRoll: DuelContinuation =
      duel.stage === "rolling-owner"
        ? { ...duel, ownerRoll: null, attempt: duel.attempt + 1 }
        : { ...duel, targetRoll: null, attempt: duel.attempt + 1 };
    next = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          hand: player.hand.filter((card) => card !== cardInstanceId),
        },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      turn: { ...state.turn, duelContinuation: clearedRoll },
      pendingChoice: null,
    };
  } else if (event.type === "duel.damage-started") {
    const duel = state.turn.duelContinuation;
    if (
      duel === undefined ||
      duel.stage !== "ready-damage" ||
      state.pendingChoice !== null ||
      state.reactionWindow !== null ||
      state.dyingBatch !== null
    ) {
      throw new Error("Duel damage is not ready.");
    }
    const expected = planDamageBatch(state, damageIntents(state, duel));
    if (
      stringPayload(event, "sourceEffectId") !== duel.sourceEffectId ||
      numberPayload(event, "targetIndex") !== duel.currentTargetIndex ||
      JSON.stringify(event.payload.damageItems) !== JSON.stringify(expected)
    ) {
      throw new Error("Duel damage disagrees with deterministic rolls.");
    }
    const resolving: MatchState = {
      ...state,
      turn: {
        ...state.turn,
        duelContinuation: { ...duel, stage: "resolving-damage" },
      },
    };
    next = beginDamageResponse(
      resolving,
      `${duel.sourceEffectId}:target:${duel.currentTargetIndex}`,
      duel.ownerPlayerId,
      expected,
      numberPayload(event, "openedAt"),
    );
  } else if (event.type === "duel.target-resolved") {
    const duel = state.turn.duelContinuation;
    if (
      duel === undefined ||
      duel.stage !== "resolving-damage" ||
      state.pendingChoice !== null ||
      state.reactionWindow !== null ||
      state.dyingBatch !== null ||
      numberPayload(event, "targetIndex") !== duel.currentTargetIndex ||
      stringPayload(event, "targetPlayerId") !== currentTarget(state, duel)
    ) {
      throw new Error("Duel target cannot resume yet.");
    }
    const nextIndex = duel.currentTargetIndex + 1;
    if (nextIndex >= duel.targetPlayerIds.length) {
      const { duelContinuation: _completed, ...turn } = state.turn;
      next = { ...state, turn };
    } else {
      next = {
        ...state,
        turn: {
          ...state.turn,
          duelContinuation: {
            ...duel,
            currentTargetIndex: nextIndex,
            stage: "rolling-owner",
            attempt: 0,
            ownerRoll: null,
            targetRoll: null,
          },
        },
      };
    }
  } else {
    throw new Error(`Unsupported duel event ${event.type}.`);
  }
  return { ...next, version: matchVersion, eventSequence: event.sequence };
}

class EventBuilder {
  readonly events: DomainEvent[] = [];
  state: MatchState;

  constructor(
    state: Readonly<MatchState>,
    private readonly commandId: CommandId,
    private readonly matchVersion: number,
    readonly resolvedAt: number,
    private readonly initialCausationEventId: string | null = null,
  ) {
    this.state = state as MatchState;
  }

  append(type: string, payload: Readonly<Record<string, unknown>>): void {
    const sequence = this.state.eventSequence + 1;
    const previous = this.events.at(-1);
    const event: DomainEvent = {
      eventId: `${this.state.matchId}:event:${sequence}`,
      sequence,
      matchId: this.state.matchId,
      causationCommandId: this.commandId,
      causationEventId: previous?.eventId ?? this.initialCausationEventId,
      rulesetVersion: this.state.rulesetVersion,
      type,
      payload: { ...payload, matchVersion: this.matchVersion },
    };
    this.events.push(event);
    this.state = reduceDuelEvent(this.state, event);
  }

  roll(): void {
    const duel = this.state.turn?.duelContinuation;
    if (
      duel === undefined ||
      (duel.stage !== "rolling-owner" && duel.stage !== "rolling-target")
    ) {
      throw new Error("Duel roll is not ready.");
    }
    const planned = nextInt(this.state.rng, DIE_FACES.length);
    this.append("duel.die-rolled", {
      playerId: currentRoller(duel),
      value: planned.value + 1,
      attempt: duel.attempt,
      rolledAt: this.resolvedAt,
      optionSetHash: DIE_OPTION_SET_HASH,
      rngCursorStart: this.state.rng.cursor,
      rngCursorEnd: planned.rng.cursor,
    });
  }

  advanceUntilWait(): void {
    for (let guard = 0; guard < 16; guard += 1) {
      const duel = this.state.turn?.duelContinuation;
      if (
        duel === undefined ||
        this.state.phase !== "playing" ||
        this.state.pendingChoice !== null ||
        this.state.reactionWindow !== null ||
        this.state.dyingBatch !== null
      ) {
        return;
      }
      if (
        (duel.stage === "rolling-owner" || duel.stage === "rolling-target") &&
        rollForStage(duel) === null
      ) {
        this.roll();
        continue;
      }
      if (duel.stage === "ready-damage") {
        this.append("duel.damage-started", {
          sourceEffectId: duel.sourceEffectId,
          targetIndex: duel.currentTargetIndex,
          openedAt: this.resolvedAt,
          damageItems: planDamageBatch(
            this.state,
            damageIntents(this.state, duel),
          ),
        });
        continue;
      }
      if (duel.stage === "resolving-damage") {
        this.append("duel.target-resolved", {
          targetIndex: duel.currentTargetIndex,
          targetPlayerId: currentTarget(this.state, duel),
          resolvedAt: this.resolvedAt,
        });
        continue;
      }
      throw new Error("Duel continuation cannot advance.");
    }
    throw new Error("Duel continuation exceeded its deterministic guard.");
  }
}

export function applyDuelActivation(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
): ApplyCommandResult {
  const command = envelope.command;
  const owner = input.players[envelope.playerId];
  if (
    command.type !== "activate-hero-skill" ||
    command.skillId !== "xyy.skill.jn30601" ||
    input.phase !== "playing" ||
    input.turn?.phase !== "action" ||
    input.activePlayerId !== envelope.playerId ||
    owner?.alive !== true ||
    owner.heroId === null ||
    !heroHasSkill(owner.heroId, "xyy.skill.jn30601") ||
    input.turn.duelContinuation !== undefined ||
    input.pendingChoice !== null ||
    input.reactionWindow !== null ||
    input.dyingBatch !== null
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  const cardInstanceIds = command.cardInstanceIds as readonly CardInstanceId[];
  const targetPlayerIds = command.targetPlayerIds;
  const requiredCost =
    (input.turn.usedSkillCounts?.["xyy.skill.jn30601"] ?? 0) + 1;
  if (
    !Number.isSafeInteger(serverReceivedAt) ||
    serverReceivedAt < 0 ||
    serverReceivedAt > input.turn.deadlineAt ||
    cardInstanceIds.length !== requiredCost ||
    new Set(cardInstanceIds).size !== cardInstanceIds.length ||
    cardInstanceIds.some((card) => !owner.hand.includes(card)) ||
    targetPlayerIds.length < 1 ||
    targetPlayerIds.length > 2 ||
    new Set(targetPlayerIds).size !== targetPlayerIds.length ||
    targetPlayerIds.some(
      (targetPlayerId) =>
        targetPlayerId === owner.id ||
        input.players[targetPlayerId]?.alive !== true,
    )
  ) {
    return {
      accepted: false,
      reason:
        serverReceivedAt > input.turn.deadlineAt
          ? "expired-window"
          : "forbidden",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    envelope.commandId,
    input.version + 1,
    serverReceivedAt,
  );
  builder.append("duel.started", {
    ownerPlayerId: owner.id,
    skillId: "xyy.skill.jn30601",
    cardInstanceIds,
    targetPlayerIds,
    sourceEffectId: `${input.matchId}:effect:${envelope.commandId}`,
  });
  builder.advanceUntilWait();
  return { accepted: true, state: builder.state, events: builder.events };
}

export function applyDuelChoiceCommand(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
): ApplyCommandResult {
  const choice = input.pendingChoice;
  const duel = input.turn?.duelContinuation;
  const command = envelope.command;
  if (
    duel === undefined ||
    choice === null ||
    choice.status !== "open" ||
    choice.prompt !== "hero-skill:xyy.skill.jn20102" ||
    command.type !== "submit-choice" ||
    command.choiceId !== choice.choiceId ||
    choice.playerIds[0] !== envelope.playerId ||
    command.selections.length > 1 ||
    command.selections.some((card) => !choice.optionIds.includes(card))
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  if (
    !Number.isSafeInteger(serverReceivedAt) ||
    serverReceivedAt < 0 ||
    serverReceivedAt > choice.deadlineAt
  ) {
    return {
      accepted: false,
      reason:
        serverReceivedAt > choice.deadlineAt ? "expired-window" : "invalid",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    envelope.commandId,
    input.version + 1,
    serverReceivedAt,
  );
  const cardInstanceId = command.selections[0] as CardInstanceId | undefined;
  builder.append(
    cardInstanceId === undefined
      ? "duel.roll-accepted"
      : "duel.reroll-requested",
    {
      playerId: envelope.playerId,
      choiceId: choice.choiceId,
      ...(cardInstanceId === undefined ? {} : { cardInstanceId }),
      resolvedAt: serverReceivedAt,
      timeout: false,
    },
  );
  builder.advanceUntilWait();
  return { accepted: true, state: builder.state, events: builder.events };
}

export function applyDuelChoiceTimeout(
  input: Readonly<MatchState>,
  command: Readonly<Extract<EngineCommand, { origin: "system-timeout" }>>,
  playerId: PlayerId,
): ApplyCommandResult {
  const choice = input.pendingChoice;
  if (
    input.turn?.duelContinuation === undefined ||
    choice === null ||
    choice.status !== "open" ||
    choice.prompt !== "hero-skill:xyy.skill.jn20102" ||
    choice.fallback !== "pass" ||
    choice.playerIds[0] !== playerId ||
    command.deadlineAt < choice.openedAt ||
    command.deadlineAt > choice.deadlineAt ||
    command.targetId !== `choice:${choice.choiceId}:${playerId}`
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    command.commandId,
    input.version + 1,
    command.deadlineAt,
  );
  builder.append("duel.roll-accepted", {
    playerId,
    choiceId: choice.choiceId,
    resolvedAt: command.deadlineAt,
    timeout: true,
  });
  builder.advanceUntilWait();
  return { accepted: true, state: builder.state, events: builder.events };
}

export function continueDuelAfterDamage(
  input: Readonly<MatchState>,
  commandId: CommandId,
  matchVersion: number,
  resolvedAt: number,
  causationEventId: string | null,
): { readonly state: MatchState; readonly events: readonly DomainEvent[] } {
  if (
    input.phase !== "playing" ||
    input.turn?.phase !== "action" ||
    input.turn.duelContinuation?.stage !== "resolving-damage" ||
    input.pendingChoice !== null ||
    input.reactionWindow !== null ||
    input.dyingBatch !== null
  ) {
    return { state: input as MatchState, events: [] };
  }
  const builder = new EventBuilder(
    input,
    commandId,
    matchVersion,
    resolvedAt,
    causationEventId,
  );
  builder.advanceUntilWait();
  return { state: builder.state, events: builder.events };
}
