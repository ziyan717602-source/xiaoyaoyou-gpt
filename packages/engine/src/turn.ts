import { createHash } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type CommandEnvelope,
  type CommandId,
  type PlayerId,
} from "@xiaoyaoyou/protocol";
import type {
  ApplyCommandResult,
  DomainEvent,
  EngineCommand,
} from "./architecture.js";
import { planDraw } from "./card-zones.js";
import type { MatchState, TeamId, TurnPhase } from "./index.js";
import { planCureBatch, playersAfterCures } from "./healing.js";
import {
  beginCancellableCardEffect,
  beginSkillConvertedCardEffect,
} from "./reaction.js";
import { nextInt } from "./random.js";
import {
  cardDefinition,
  cardIdOf,
  heroHasSkill,
  type CardInstanceId,
} from "./setup-content.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";

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
  return value as readonly string[];
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

function playerHasAnyCards(
  player: Readonly<MatchState["players"][PlayerId]>,
): boolean {
  return (
    player.hand.length > 0 ||
    player.equipment.weapon !== null ||
    player.equipment.armor !== null
  );
}

const PHASE_EDGES: Readonly<Record<TurnPhase, readonly TurnPhase[]>> = {
  "turn-start": ["event"],
  event: ["action"],
  action: ["encounter"],
  encounter: ["battle"],
  battle: ["reward"],
  reward: ["discard", "turn-end"],
  discard: ["turn-end"],
  "turn-end": [],
};

function aliveTeams(state: Readonly<MatchState>): TeamId[] {
  return [
    ...new Set(
      Object.values(state.players)
        .filter((player) => player.alive && player.team !== null)
        .map((player) => player.team!),
    ),
  ].sort();
}

function nextAlivePlayer(state: Readonly<MatchState>): PlayerId | null {
  if (state.activePlayerId === null || state.turnOrder.length === 0)
    return null;
  const activeIndex = state.turnOrder.indexOf(state.activePlayerId);
  if (activeIndex < 0) return null;
  for (let offset = 1; offset <= state.turnOrder.length; offset += 1) {
    const candidate =
      state.turnOrder[(activeIndex + offset) % state.turnOrder.length];
    if (candidate !== undefined && state.players[candidate]?.alive === true) {
      return candidate;
    }
  }
  return null;
}

export function reduceTurnEvent(
  state: Readonly<MatchState>,
  event: Readonly<DomainEvent>,
): MatchState {
  if (
    event.matchId !== state.matchId ||
    event.sequence !== state.eventSequence + 1 ||
    event.rulesetVersion !== state.rulesetVersion
  ) {
    throw new Error("Turn event does not extend the current match head.");
  }
  if (state.phase !== "playing" || state.turn === null) {
    throw new Error("Turn event requires a playing match.");
  }
  const matchVersion = numberPayload(event, "matchVersion");
  const expectedMatchVersion =
    event.causationEventId === null ? state.version + 1 : state.version;
  if (matchVersion !== expectedMatchVersion) {
    throw new Error("Turn event has an invalid match version.");
  }

  let next: MatchState;
  if (event.type === "turn.phase-changed") {
    const from = stringPayload(event, "from") as TurnPhase;
    const to = stringPayload(event, "to") as TurnPhase;
    if (
      state.turn.phase !== from ||
      PHASE_EDGES[from] === undefined ||
      !PHASE_EDGES[from].includes(to)
    ) {
      throw new Error(`Invalid turn phase transition ${from} -> ${to}.`);
    }
    const changedAt = numberPayload(event, "changedAt");
    next = {
      ...state,
      turn: {
        ...state.turn,
        phase: to,
        openedAt: changedAt,
        deadlineAt: changedAt + ACTION_DEADLINE_MS,
      },
    };
  } else if (event.type === "turn.hero-skill-activated") {
    const playerId = stringPayload(event, "playerId");
    const cardInstanceIds = stringsPayload(
      event,
      "cardInstanceIds",
    ) as readonly CardInstanceId[];
    const targetPlayerIds = stringsPayload(
      event,
      "targetPlayerIds",
    ) as readonly PlayerId[];
    const skillId = stringPayload(event, "skillId");
    const player = state.players[playerId];
    const target = state.players[targetPlayerIds[0] ?? ""];
    if (
      state.turn.phase !== "action" ||
      state.activePlayerId !== playerId ||
      player === undefined ||
      player.heroId === null
    ) {
      throw new Error("Hero-skill event is not applicable.");
    }
    const cardInstanceId = cardInstanceIds[0];
    if (skillId === "xyy.skill.jn20302") {
      if (
        !heroHasSkill(player.heroId, "xyy.skill.jn20302") ||
        cardInstanceIds.length !== 1 ||
        cardInstanceId === undefined ||
        !player.hand.includes(cardInstanceId) ||
        !cardIdOf(cardInstanceId).startsWith("xyy.card.jp") ||
        targetPlayerIds.length !== 1 ||
        target === undefined ||
        !target.alive
      ) {
        throw new Error("JN20302 event is not applicable.");
      }
      const paymentState: MatchState = {
        ...state,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand: player.hand.filter((card) => card !== cardInstanceId),
          },
        },
        discardPile: [...state.discardPile, cardInstanceId],
      };
      const expectedCures = planCureBatch(paymentState, [
        {
          itemId: `${event.eventId}:cure:0`,
          sourcePlayerId: playerId,
          targetPlayerId: target.id,
          amount: 2,
          element: "neutral",
        },
      ]);
      if (
        JSON.stringify(event.payload.healingItems) !==
        JSON.stringify(expectedCures)
      ) {
        throw new Error("JN20302 healing disagrees with deterministic plan.");
      }
      next = {
        ...paymentState,
        players: playersAfterCures(paymentState, expectedCures),
      };
    } else if (skillId === "xyy.skill.jn40401") {
      const sourceZone = stringPayload(event, "sourceZone");
      const validSource =
        cardInstanceIds.length === 1 &&
        cardInstanceId !== undefined &&
        ((sourceZone === "hand" && player.hand.includes(cardInstanceId)) ||
          (sourceZone === "weapon" &&
            player.equipment.weapon === cardInstanceId) ||
          (sourceZone === "armor" &&
            player.equipment.armor === cardInstanceId));
      if (
        !heroHasSkill(player.heroId, "xyy.skill.jn40401") ||
        !validSource ||
        targetPlayerIds.length !== 1 ||
        targetPlayerIds[0] !== playerId
      ) {
        throw new Error("JN40401 event is not applicable.");
      }
      const paymentState: MatchState = {
        ...state,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand:
              sourceZone === "hand"
                ? player.hand.filter((card) => card !== cardInstanceId)
                : player.hand,
            equipment:
              sourceZone === "weapon" || sourceZone === "armor"
                ? { ...player.equipment, [sourceZone]: null }
                : player.equipment,
          },
        },
        discardPile: [...state.discardPile, cardInstanceId!],
      };
      const expectedCures = planCureBatch(paymentState, [
        {
          itemId: `${event.eventId}:cure:0`,
          sourcePlayerId: playerId,
          targetPlayerId: playerId,
          amount: 2,
          element: "neutral",
        },
      ]);
      if (
        JSON.stringify(event.payload.healingItems) !==
        JSON.stringify(expectedCures)
      ) {
        throw new Error("JN40401 healing disagrees with deterministic plan.");
      }
      next = {
        ...paymentState,
        players: playersAfterCures(paymentState, expectedCures),
      };
    } else if (skillId === "xyy.skill.jn50202") {
      const drawnCardInstanceIds = stringsPayload(
        event,
        "drawnCardInstanceIds",
      ) as readonly CardInstanceId[];
      const effectId = stringPayload(event, "effectId");
      const choiceId = stringPayload(event, "choiceId");
      const openedAt = numberPayload(event, "openedAt");
      const expected = planDraw(state, 1);
      if (
        !heroHasSkill(player.heroId, "xyy.skill.jn50202") ||
        (state.turn.usedSkillIds ?? []).includes("xyy.skill.jn50202") ||
        cardInstanceIds.length !== 0 ||
        targetPlayerIds.length !== 0 ||
        state.pendingChoice !== null ||
        state.reactionWindow !== null ||
        effectId !== `${state.matchId}:effect:${event.causationCommandId}` ||
        choiceId !== `${state.matchId}:choice:${event.causationCommandId}` ||
        state.effectStack.some((effect) => effect.effectId === effectId) ||
        !sameValues(drawnCardInstanceIds, expected.cards) ||
        numberPayload(event, "rngCursor") !== expected.rng.cursor
      ) {
        throw new Error("JN50202 event is not applicable.");
      }
      const hand = [...player.hand, ...drawnCardInstanceIds];
      const shouldDiscard = hand.length >= 2;
      const effect = {
        effectId,
        parentEffectId: null,
        kind: "hero-skill:xyy.skill.jn50202",
        sourcePlayerId: playerId,
        targetIds: [playerId],
        step: "awaiting-choice",
        status: "resolving" as const,
        payload: { skillId: "xyy.skill.jn50202" },
      };
      next = {
        ...state,
        players: {
          ...state.players,
          [playerId]: { ...player, hand },
        },
        drawPile: expected.drawPile,
        discardPile: expected.discardPile,
        rng: expected.rng,
        turn: {
          ...state.turn,
          usedSkillIds: [
            ...(state.turn.usedSkillIds ?? []),
            "xyy.skill.jn50202",
          ],
        },
        effectStack: shouldDiscard
          ? [...state.effectStack, effect]
          : state.effectStack,
        pendingChoice: shouldDiscard
          ? {
              choiceId,
              playerIds: [playerId],
              prompt: "jn50202-discard-one",
              minSelections: 1,
              maxSelections: 1,
              optionIds: hand,
              optional: false,
              status: "open",
              openedAt,
              deadlineAt: openedAt + ACTION_DEADLINE_MS,
              fallback: "deterministic-random",
              continuation: {
                continuationId: `${choiceId}:continuation`,
                effectId,
                step: "after-jn50202-discard",
                locals: {},
                resumeWith: "resolve-jn50202-discard",
              },
            }
          : null,
      };
    } else {
      throw new Error("Unsupported active hero skill event.");
    }
  } else if (event.type === "turn.card-pawned") {
    const playerId = stringPayload(event, "playerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const sourceZone = stringPayload(event, "sourceZone");
    const player = state.players[playerId];
    const definition = cardDefinition(cardInstanceId);
    const pawnAction = definition.alternateActions?.find((action) =>
      ["pawn-draw-one", "pawn-draw-two"].includes(action.type),
    );
    const fromHand =
      sourceZone === "hand" && player?.hand.includes(cardInstanceId) === true;
    const fromWeapon =
      sourceZone === "weapon" &&
      pawnAction?.type === "pawn-draw-two" &&
      player?.equipment.weapon === cardInstanceId;
    if (
      state.turn.phase !== "action" ||
      state.activePlayerId !== playerId ||
      player === undefined ||
      !player.alive ||
      (!fromHand && !fromWeapon) ||
      pawnAction === undefined
    ) {
      throw new Error("Card pawn event is not applicable.");
    }
    next = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          hand: fromHand
            ? player.hand.filter((card) => card !== cardInstanceId)
            : player.hand,
          equipment: fromWeapon
            ? { ...player.equipment, weapon: null }
            : player.equipment,
        },
      },
      discardPile: [...state.discardPile, cardInstanceId],
    };
  } else if (event.type === "turn.card-played") {
    const playerId = stringPayload(event, "playerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const targetPlayerIds = stringsPayload(event, "targetPlayerIds");
    const player = state.players[playerId];
    if (
      state.turn.phase !== "action" ||
      state.activePlayerId !== playerId ||
      player === undefined ||
      !player.alive ||
      !player.hand.includes(cardInstanceId)
    ) {
      throw new Error("Card play event is not applicable.");
    }
    const definition = cardDefinition(cardInstanceId);
    const hand = player.hand.filter((card) => card !== cardInstanceId);
    if (definition.coreAction?.type === "equip") {
      if (targetPlayerIds.length !== 1 || targetPlayerIds[0] !== playerId) {
        throw new Error("Equipment must target its owner.");
      }
      const slot = definition.coreAction.slot;
      const replaced = player.equipment[slot];
      next = {
        ...state,
        players: {
          ...state.players,
          [playerId]: {
            ...player,
            hand,
            equipment: { ...player.equipment, [slot]: cardInstanceId },
          },
        },
        discardPile:
          replaced === null
            ? state.discardPile
            : [...state.discardPile, replaced],
      };
    } else if (definition.coreAction?.type === "draw-two") {
      const target = state.players[targetPlayerIds[0] ?? ""];
      if (
        targetPlayerIds.length !== 1 ||
        target === undefined ||
        !target.alive
      ) {
        throw new Error("Draw-two requires one living target.");
      }
      next = {
        ...state,
        players: { ...state.players, [playerId]: { ...player, hand } },
        discardPile: [...state.discardPile, cardInstanceId],
      };
    } else {
      throw new Error(`Card ${cardInstanceId} has no M03 action.`);
    }
  } else if (event.type === "turn.cards-drawn") {
    const playerId = stringPayload(event, "playerId");
    const requestedCount = numberPayload(event, "requestedCount");
    const cards = stringsPayload(event, "cardInstanceIds") as CardInstanceId[];
    const reason = stringPayload(event, "reason");
    const player = state.players[playerId];
    const validReason =
      (reason === "reward" &&
        state.turn.phase === "reward" &&
        state.activePlayerId === playerId) ||
      (reason === "card-effect" &&
        state.turn.phase === "action" &&
        player?.alive === true);
    if (player === undefined || requestedCount < 0 || !validReason) {
      throw new Error("Card draw event is not applicable.");
    }
    const expected = planDraw(state, requestedCount);
    if (
      !sameValues(cards, expected.cards) ||
      numberPayload(event, "rngCursor") !== expected.rng.cursor
    ) {
      throw new Error("Card draw event disagrees with deterministic draw.");
    }
    next = {
      ...state,
      players: {
        ...state.players,
        [playerId]: { ...player, hand: [...player.hand, ...cards] },
      },
      drawPile: expected.drawPile,
      discardPile: expected.discardPile,
      rng: expected.rng,
    };
  } else if (event.type === "turn.cards-discarded") {
    const playerId = stringPayload(event, "playerId");
    const cards = stringsPayload(event, "cardInstanceIds") as CardInstanceId[];
    const player = state.players[playerId];
    const excess =
      player === undefined ? -1 : player.hand.length - player.handLimit;
    if (
      state.turn.phase !== "discard" ||
      state.activePlayerId !== playerId ||
      player === undefined ||
      excess <= 0 ||
      cards.length !== excess ||
      new Set(cards).size !== cards.length ||
      cards.some((card) => !player.hand.includes(card))
    ) {
      throw new Error("Discard event is not applicable.");
    }
    const discarded = new Set(cards);
    let rng = state.rng;
    if (event.payload.timeout === true) {
      const planned = planRandomDiscard(state, playerId, excess);
      if (
        !sameValues(cards, planned.cards) ||
        event.payload.optionSetHash !== planned.optionSetHash ||
        event.payload.rngCursorStart !== state.rng.cursor ||
        event.payload.rngCursorEnd !== planned.rng.cursor
      ) {
        throw new Error("Timed-out discard disagrees with deterministic RNG.");
      }
      rng = planned.rng;
    }
    next = {
      ...state,
      rng,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          hand: player.hand.filter((card) => !discarded.has(card)),
        },
      },
      discardPile: [...state.discardPile, ...cards],
    };
  } else if (event.type === "turn.advanced") {
    const playerId = stringPayload(event, "playerId");
    const turnNumber = numberPayload(event, "turnNumber");
    const advancedAt = numberPayload(event, "advancedAt");
    if (
      state.turn.phase !== "turn-end" ||
      aliveTeams(state).length !== 2 ||
      nextAlivePlayer(state) !== playerId ||
      turnNumber !== state.turn.number + 1
    ) {
      throw new Error("Turn advance event is not applicable.");
    }
    next = {
      ...state,
      activePlayerId: playerId,
      turn: {
        number: turnNumber,
        phase: "turn-start",
        openedAt: advancedAt,
        deadlineAt: advancedAt + ACTION_DEADLINE_MS,
        usedSkillIds: [],
      },
    };
  } else if (event.type === "match.finished") {
    const winnerValue = event.payload.winner;
    const deathCycle = event.payload.reason === "death-cycle";
    const teams = aliveTeams(state);
    const expectedWinner: TeamId | "draw" =
      teams.length === 1 ? teams[0]! : "draw";
    if (
      (!deathCycle && state.turn.phase !== "turn-end") ||
      (deathCycle && state.dyingBatch !== null) ||
      teams.length > 1 ||
      (winnerValue !== expectedWinner &&
        !(winnerValue === "draw" && expectedWinner === "draw"))
    ) {
      throw new Error("Match finish event is not applicable.");
    }
    next = {
      ...state,
      phase: "finished",
      activePlayerId: null,
      winner: expectedWinner,
    };
  } else {
    throw new Error(`Unsupported turn event ${event.type}.`);
  }
  return {
    ...next,
    version: matchVersion,
    eventSequence: event.sequence,
  };
}

class EventBuilder {
  readonly events: DomainEvent[] = [];
  state: MatchState;

  constructor(
    state: Readonly<MatchState>,
    private readonly commandId: CommandId,
    private readonly matchVersion: number,
    readonly resolvedAt: number,
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
      causationEventId: previous?.eventId ?? null,
      rulesetVersion: this.state.rulesetVersion,
      type,
      payload: { ...payload, matchVersion: this.matchVersion },
    };
    this.events.push(event);
    this.state = reduceTurnEvent(this.state, event);
  }
}

function changePhase(builder: EventBuilder, to: TurnPhase): void {
  const from = builder.state.turn?.phase;
  if (from === undefined) throw new Error("Turn phase is missing.");
  builder.append("turn.phase-changed", {
    from,
    to,
    changedAt: builder.resolvedAt,
  });
}

function appendDraw(
  builder: EventBuilder,
  playerId: PlayerId,
  requestedCount: number,
  reason: "card-effect" | "reward",
): void {
  const planned = planDraw(builder.state, requestedCount);
  builder.append("turn.cards-drawn", {
    playerId,
    requestedCount,
    cardInstanceIds: planned.cards,
    rngCursor: planned.rng.cursor,
    reason,
  });
}

function finishOrAdvance(builder: EventBuilder): void {
  const teams = aliveTeams(builder.state);
  if (teams.length <= 1) {
    builder.append("match.finished", {
      winner: teams.length === 1 ? teams[0]! : "draw",
    });
    return;
  }
  const nextPlayerId = nextAlivePlayer(builder.state);
  if (nextPlayerId === null || builder.state.turn === null) {
    builder.append("match.finished", { winner: "draw" });
    return;
  }
  builder.append("turn.advanced", {
    playerId: nextPlayerId,
    turnNumber: builder.state.turn.number + 1,
    advancedAt: builder.resolvedAt,
  });
  changePhase(builder, "event");
  changePhase(builder, "action");
}

function endAction(builder: EventBuilder, playerId: PlayerId): void {
  changePhase(builder, "encounter");
  changePhase(builder, "battle");
  changePhase(builder, "reward");
  appendDraw(builder, playerId, 1, "reward");
  const player = builder.state.players[playerId]!;
  if (player.hand.length > player.handLimit) {
    changePhase(builder, "discard");
    return;
  }
  changePhase(builder, "turn-end");
  finishOrAdvance(builder);
}

export function applyTurnCommand(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
): ApplyCommandResult {
  if (
    input.phase !== "playing" ||
    input.turn === null ||
    input.activePlayerId !== envelope.playerId ||
    input.players[envelope.playerId]?.alive !== true
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  const command = envelope.command;
  const builder = new EventBuilder(
    input,
    envelope.commandId,
    input.version + 1,
    serverReceivedAt,
  );

  if (
    !Number.isSafeInteger(serverReceivedAt) ||
    serverReceivedAt < 0 ||
    ((input.turn.phase === "action" || input.turn.phase === "discard") &&
      serverReceivedAt > input.turn.deadlineAt)
  ) {
    return {
      accepted: false,
      reason:
        serverReceivedAt > input.turn.deadlineAt ? "expired-window" : "invalid",
      currentVersion: input.version,
    };
  }

  if (command.type === "play-card") {
    if (input.turn.phase !== "action") {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: input.version,
      };
    }
    const player = input.players[envelope.playerId]!;
    const cardInstanceId = command.cardInstanceId as CardInstanceId;
    let definition;
    try {
      definition = cardDefinition(cardInstanceId);
    } catch {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    if (command.mode === "pawn") {
      const pawnAction = definition.alternateActions?.find((action) =>
        ["pawn-draw-one", "pawn-draw-two"].includes(action.type),
      );
      const sourceZone = player.hand.includes(cardInstanceId)
        ? "hand"
        : pawnAction?.type === "pawn-draw-two" &&
            player.equipment.weapon === cardInstanceId
          ? "weapon"
          : null;
      if (
        command.targetPlayerIds.length !== 0 ||
        pawnAction === undefined ||
        sourceZone === null
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      builder.append("turn.card-pawned", {
        playerId: envelope.playerId,
        cardInstanceId,
        sourceZone,
      });
      appendDraw(
        builder,
        envelope.playerId,
        pawnAction.type === "pawn-draw-one" ? 1 : 2,
        "card-effect",
      );
      return { accepted: true, state: builder.state, events: builder.events };
    }
    if (!player.hand.includes(cardInstanceId)) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    if (command.mode !== undefined && command.mode !== "primary") {
      return {
        accepted: false,
        reason: "invalid",
        currentVersion: input.version,
      };
    }
    if (definition.coreAction === null) {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: input.version,
      };
    }
    if (definition.coreAction.type === "cancel-effect") {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: input.version,
      };
    }
    if (definition.coreAction.type === "equip") {
      if (
        command.targetPlayerIds.length !== 1 ||
        command.targetPlayerIds[0] !== envelope.playerId
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
    } else if (definition.coreAction.type === "heal-team-one") {
      const expectedTargets = Object.values(input.players)
        .filter(
          (candidate) => candidate.alive && candidate.team === player.team,
        )
        .sort((left, right) => left.seat - right.seat)
        .map((candidate) => candidate.id);
      if (!sameValues(command.targetPlayerIds, expectedTargets)) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      return beginCancellableCardEffect(
        input,
        envelope,
        serverReceivedAt,
        cardInstanceId,
        expectedTargets,
      );
    } else if (definition.coreAction.type === "steal-one") {
      const target = input.players[command.targetPlayerIds[0] ?? ""];
      if (
        command.targetPlayerIds.length !== 1 ||
        target === undefined ||
        target.id === envelope.playerId ||
        !target.alive ||
        target.hand.length === 0
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      return beginCancellableCardEffect(
        input,
        envelope,
        serverReceivedAt,
        cardInstanceId,
        target.id,
      );
    } else if (definition.coreAction.type === "discard-one") {
      const target = input.players[command.targetPlayerIds[0] ?? ""];
      if (
        command.targetPlayerIds.length !== 1 ||
        target === undefined ||
        !target.alive ||
        (target.hand.length === 0 &&
          target.equipment.weapon === null &&
          target.equipment.armor === null)
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      return beginCancellableCardEffect(
        input,
        envelope,
        serverReceivedAt,
        cardInstanceId,
        target.id,
      );
    } else {
      const target = input.players[command.targetPlayerIds[0] ?? ""];
      if (
        command.targetPlayerIds.length !== 1 ||
        target === undefined ||
        !target.alive ||
        (definition.coreAction.type === "heal-two" &&
          target.id !== envelope.playerId)
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      return beginCancellableCardEffect(
        input,
        envelope,
        serverReceivedAt,
        cardInstanceId,
        command.targetPlayerIds[0]!,
      );
    }
    builder.append("turn.card-played", {
      playerId: envelope.playerId,
      cardInstanceId,
      targetPlayerIds: command.targetPlayerIds,
    });
  } else if (command.type === "activate-hero-skill") {
    const player = input.players[envelope.playerId]!;
    const cardInstanceIds = command.cardInstanceIds as CardInstanceId[];
    const target = input.players[command.targetPlayerIds[0] ?? ""];
    if (input.turn.phase !== "action" || player.heroId === null) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const nextEventId = `${input.matchId}:event:${input.eventSequence + 1}`;
    if (command.skillId === "xyy.skill.jn20302") {
      let techniqueCard = false;
      try {
        techniqueCard =
          cardInstanceIds.length === 1 &&
          cardIdOf(cardInstanceIds[0]!).startsWith("xyy.card.jp");
      } catch {
        techniqueCard = false;
      }
      if (
        !heroHasSkill(player.heroId, "xyy.skill.jn20302") ||
        !techniqueCard ||
        !player.hand.includes(cardInstanceIds[0]!) ||
        command.targetPlayerIds.length !== 1 ||
        target === undefined ||
        !target.alive
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      const cardInstanceId = cardInstanceIds[0]!;
      const paymentState: MatchState = {
        ...input,
        players: {
          ...input.players,
          [envelope.playerId]: {
            ...player,
            hand: player.hand.filter((card) => card !== cardInstanceId),
          },
        },
        discardPile: [...input.discardPile, cardInstanceId],
      };
      builder.append("turn.hero-skill-activated", {
        playerId: envelope.playerId,
        cardInstanceIds,
        skillId: "xyy.skill.jn20302",
        targetPlayerIds: [target.id],
        healingItems: planCureBatch(paymentState, [
          {
            itemId: `${nextEventId}:cure:0`,
            sourcePlayerId: envelope.playerId,
            targetPlayerId: target.id,
            amount: 2,
            element: "neutral",
          },
        ]),
      });
    } else if (command.skillId === "xyy.skill.jn40401") {
      const cardInstanceId = cardInstanceIds[0];
      const sourceZone =
        cardInstanceIds.length !== 1 || cardInstanceId === undefined
          ? null
          : player.hand.includes(cardInstanceId)
            ? "hand"
            : player.equipment.weapon === cardInstanceId
              ? "weapon"
              : player.equipment.armor === cardInstanceId
                ? "armor"
                : null;
      if (
        !heroHasSkill(player.heroId, "xyy.skill.jn40401") ||
        sourceZone === null ||
        command.targetPlayerIds.length !== 1 ||
        command.targetPlayerIds[0] !== envelope.playerId
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      const paidCard = cardInstanceId!;
      const paymentState: MatchState = {
        ...input,
        players: {
          ...input.players,
          [envelope.playerId]: {
            ...player,
            hand:
              sourceZone === "hand"
                ? player.hand.filter((card) => card !== paidCard)
                : player.hand,
            equipment:
              sourceZone === "weapon" || sourceZone === "armor"
                ? { ...player.equipment, [sourceZone]: null }
                : player.equipment,
          },
        },
        discardPile: [...input.discardPile, paidCard],
      };
      builder.append("turn.hero-skill-activated", {
        playerId: envelope.playerId,
        cardInstanceIds,
        skillId: "xyy.skill.jn40401",
        sourceZone,
        targetPlayerIds: [envelope.playerId],
        healingItems: planCureBatch(paymentState, [
          {
            itemId: `${nextEventId}:cure:0`,
            sourcePlayerId: envelope.playerId,
            targetPlayerId: envelope.playerId,
            amount: 2,
            element: "neutral",
          },
        ]),
      });
    } else if (command.skillId === "xyy.skill.jn50202") {
      if (
        !heroHasSkill(player.heroId, "xyy.skill.jn50202") ||
        (input.turn.usedSkillIds ?? []).includes("xyy.skill.jn50202") ||
        cardInstanceIds.length !== 0 ||
        command.targetPlayerIds.length !== 0
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      const planned = planDraw(input, 1);
      builder.append("turn.hero-skill-activated", {
        playerId: envelope.playerId,
        cardInstanceIds: [],
        skillId: "xyy.skill.jn50202",
        targetPlayerIds: [],
        drawnCardInstanceIds: planned.cards,
        rngCursor: planned.rng.cursor,
        effectId: `${input.matchId}:effect:${envelope.commandId}`,
        choiceId: `${input.matchId}:choice:${envelope.commandId}`,
        openedAt: serverReceivedAt,
      });
    } else {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
  } else if (command.type === "play-skill-converted-card") {
    const player = input.players[envelope.playerId]!;
    const cardInstanceIds = command.cardInstanceIds as CardInstanceId[];
    if (input.turn.phase !== "action" || player.heroId === null) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    if (command.skillId === "xyy.skill.jn40301") {
      if (
        !heroHasSkill(player.heroId, "xyy.skill.jn40301") ||
        (command.convertedCardId !== undefined &&
          command.convertedCardId !== "xyy.card.tp02") ||
        cardInstanceIds.length !== 2 ||
        new Set(cardInstanceIds).size !== 2 ||
        cardInstanceIds.some((card) => !player.hand.includes(card)) ||
        command.targetPlayerIds.length !== 1 ||
        command.targetPlayerIds[0] !== envelope.playerId
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      return beginSkillConvertedCardEffect(
        input,
        envelope,
        serverReceivedAt,
        cardInstanceIds,
        "xyy.skill.jn40301",
        "xyy.card.tp02",
        envelope.playerId,
      );
    }
    if (command.skillId === "xyy.skill.jn50201") {
      const target = input.players[command.targetPlayerIds[0] ?? ""];
      const paidCard = cardInstanceIds[0];
      const remainingHand =
        paidCard === undefined
          ? player.hand
          : player.hand.filter((card) => card !== paidCard);
      const targetHasCardsAfterPayment =
        target === undefined
          ? false
          : target.id === envelope.playerId
            ? remainingHand.length > 0 ||
              target.equipment.weapon !== null ||
              target.equipment.armor !== null
            : playerHasAnyCards(target);
      const validConvertedCard =
        command.convertedCardId === "xyy.card.jp01" ||
        command.convertedCardId === "xyy.card.jp06";
      const validTarget =
        command.targetPlayerIds.length === 1 &&
        target?.alive === true &&
        (command.convertedCardId === "xyy.card.jp01"
          ? target.id !== envelope.playerId && target.hand.length > 0
          : command.convertedCardId === "xyy.card.jp06" &&
            targetHasCardsAfterPayment);
      if (
        !heroHasSkill(player.heroId, "xyy.skill.jn50201") ||
        (input.turn.usedSkillIds ?? []).includes("xyy.skill.jn50201") ||
        cardInstanceIds.length !== 1 ||
        paidCard === undefined ||
        !player.hand.includes(paidCard) ||
        !Object.values(input.players).some(
          (candidate) =>
            candidate.id !== envelope.playerId && playerHasAnyCards(candidate),
        ) ||
        !validConvertedCard ||
        !validTarget
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      return beginSkillConvertedCardEffect(
        input,
        envelope,
        serverReceivedAt,
        cardInstanceIds,
        "xyy.skill.jn50201",
        command.convertedCardId,
        target.id,
      );
    }
    return {
      accepted: false,
      reason: "forbidden",
      currentVersion: input.version,
    };
  } else if (command.type === "end-action") {
    if (input.turn.phase !== "action") {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: input.version,
      };
    }
    endAction(builder, envelope.playerId);
  } else if (command.type === "discard-cards") {
    const player = input.players[envelope.playerId]!;
    const cardInstanceIds =
      command.cardInstanceIds as readonly CardInstanceId[];
    const excess = player.hand.length - player.handLimit;
    if (
      input.turn.phase !== "discard" ||
      cardInstanceIds.length !== excess ||
      new Set(cardInstanceIds).size !== cardInstanceIds.length ||
      cardInstanceIds.some((card) => !player.hand.includes(card))
    ) {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: input.version,
      };
    }
    builder.append("turn.cards-discarded", {
      playerId: envelope.playerId,
      cardInstanceIds,
    });
    changePhase(builder, "turn-end");
    finishOrAdvance(builder);
  } else {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }

  return { accepted: true, state: builder.state, events: builder.events };
}

interface PlannedRandomDiscard {
  readonly cards: readonly CardInstanceId[];
  readonly optionSetHash: string;
  readonly rng: MatchState["rng"];
}

function planRandomDiscard(
  state: Readonly<MatchState>,
  playerId: PlayerId,
  count: number,
): PlannedRandomDiscard {
  const player = state.players[playerId];
  if (player === undefined || count <= 0 || count > player.hand.length) {
    throw new Error("Random discard requires a valid positive excess.");
  }
  const originalOptions = [...player.hand].sort();
  const pool = [...originalOptions];
  const cards: CardInstanceId[] = [];
  let rng = state.rng;
  while (cards.length < count) {
    const drawn = nextInt(rng, pool.length);
    rng = drawn.rng;
    cards.push(pool.splice(drawn.value, 1)[0]!);
  }
  return {
    cards,
    optionSetHash: createHash("sha256")
      .update(JSON.stringify(originalOptions))
      .digest("hex"),
    rng,
  };
}

function timeoutEnvelope(
  state: Readonly<MatchState>,
  commandId: CommandId,
  playerId: PlayerId,
  command: ClientCommand,
  deadlineAt: number,
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    matchId: state.matchId,
    playerId,
    clientSequence: 0,
    expectedVersion: state.version,
    clientIssuedAt: deadlineAt,
    command,
  };
}

export function applyTurnTimeout(
  state: Readonly<MatchState>,
  command: Readonly<Extract<EngineCommand, { origin: "system-timeout" }>>,
  playerId: PlayerId,
): ApplyCommandResult {
  if (
    state.phase !== "playing" ||
    state.turn === null ||
    state.activePlayerId !== playerId
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: state.version,
    };
  }
  if (state.turn.phase === "action") {
    return applyTurnCommand(
      state,
      timeoutEnvelope(
        state,
        command.commandId,
        playerId,
        { type: "end-action" },
        command.deadlineAt,
      ),
      command.deadlineAt,
    );
  }
  if (state.turn.phase !== "discard") {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: state.version,
    };
  }
  const player = state.players[playerId]!;
  const excess = player.hand.length - player.handLimit;
  const planned = planRandomDiscard(state, playerId, excess);
  const builder = new EventBuilder(
    state,
    command.commandId,
    state.version + 1,
    command.deadlineAt,
  );
  builder.append("turn.cards-discarded", {
    playerId,
    cardInstanceIds: planned.cards,
    timeout: true,
    optionSetHash: planned.optionSetHash,
    rngCursorStart: state.rng.cursor,
    rngCursorEnd: planned.rng.cursor,
  });
  changePhase(builder, "turn-end");
  finishOrAdvance(builder);
  return { accepted: true, state: builder.state, events: builder.events };
}
