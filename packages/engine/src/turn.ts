import type {
  CommandEnvelope,
  CommandId,
  PlayerId,
} from "@xiaoyaoyou/protocol";
import type { ApplyCommandResult, DomainEvent } from "./architecture.js";
import { planDraw } from "./card-zones.js";
import type { MatchState, TeamId, TurnPhase } from "./index.js";
import { beginCancellableCardEffect } from "./reaction.js";
import { cardDefinition, type CardInstanceId } from "./setup-content.js";

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
    next = { ...state, turn: { ...state.turn, phase: to } };
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
    next = {
      ...state,
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
      turn: { number: turnNumber, phase: "turn-start" },
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
  builder.append("turn.phase-changed", { from, to });
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
  );

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
    if (!player.hand.includes(cardInstanceId)) {
      return {
        accepted: false,
        reason: "forbidden",
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
    if (
      definition.coreAction.type === "cancel-effect" ||
      definition.coreAction.type === "rescue-two"
    ) {
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
    } else {
      const target = input.players[command.targetPlayerIds[0] ?? ""];
      if (
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
