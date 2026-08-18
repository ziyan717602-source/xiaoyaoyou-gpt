import type {
  CommandEnvelope,
  CommandId,
  EffectId,
  PlayerId,
  WindowId,
} from "@xiaoyaoyou/protocol";
import type { ApplyCommandResult, DomainEvent } from "./architecture.js";
import { planDraw } from "./card-zones.js";
import type {
  Continuation,
  EffectFrame,
  MatchState,
  ReactionWindow,
} from "./index.js";
import { cardDefinition, type CardInstanceId } from "./setup-content.js";

const REACTION_DEADLINE_MS = 15_000;

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

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function effectById(
  state: Readonly<MatchState>,
  effectId: EffectId,
): EffectFrame | undefined {
  return state.effectStack.find((effect) => effect.effectId === effectId);
}

function updateEffects(
  state: Readonly<MatchState>,
  statuses: Readonly<Record<EffectId, EffectFrame["status"]>>,
): readonly EffectFrame[] {
  return state.effectStack.map((effect) =>
    statuses[effect.effectId] === undefined
      ? effect
      : {
          ...effect,
          status: statuses[effect.effectId]!,
          step:
            statuses[effect.effectId] === "waiting"
              ? "awaiting-reactions"
              : statuses[effect.effectId]!,
        },
  );
}

function pruneTerminalTail(
  effects: readonly EffectFrame[],
): readonly EffectFrame[] {
  const active = [...effects];
  while (
    active.length > 0 &&
    ["cancelled", "resolved", "fizzled"].includes(active.at(-1)!.status)
  ) {
    active.pop();
  }
  return active;
}

function livingSeatOrder(state: Readonly<MatchState>): readonly PlayerId[] {
  return Object.values(state.players)
    .filter((player) => player.alive)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
}

function priorityAfter(
  state: Readonly<MatchState>,
  eligible: ReadonlySet<PlayerId>,
  afterPlayerId: PlayerId,
): readonly PlayerId[] {
  const seats = livingSeatOrder(state);
  const start = seats.indexOf(afterPlayerId);
  if (start < 0) return seats.filter((playerId) => eligible.has(playerId));
  const result: PlayerId[] = [];
  for (let offset = 1; offset <= seats.length; offset += 1) {
    const playerId = seats[(start + offset) % seats.length]!;
    if (eligible.has(playerId)) result.push(playerId);
  }
  return result;
}

function makeWindow(input: {
  readonly state: Readonly<MatchState>;
  readonly effect: EffectFrame;
  readonly windowId: WindowId;
  readonly parentWindow: ReactionWindow | null;
  readonly afterPlayerId: PlayerId;
  readonly openedAt: number;
}): ReactionWindow {
  const sourcePlayerId = input.effect.sourcePlayerId;
  if (sourcePlayerId === null) {
    throw new Error("A player-card effect requires a source player.");
  }
  const eligiblePlayerIds = livingSeatOrder(input.state).filter(
    (playerId) => playerId !== sourcePlayerId,
  );
  const eligible = new Set(eligiblePlayerIds);
  const priorityOrder = priorityAfter(
    input.state,
    eligible,
    input.afterPlayerId,
  );
  const continuation: Continuation = {
    continuationId: `${input.state.matchId}:continuation:${input.windowId}`,
    effectId: input.effect.effectId,
    step: "after-reactions",
    locals:
      input.parentWindow === null ? {} : { parentWindow: input.parentWindow },
    resumeWith: "resolve-effect",
  };
  return {
    windowId: input.windowId,
    effectId: input.effect.effectId,
    parentWindowId: input.parentWindow?.windowId ?? null,
    eligiblePlayerIds,
    priorityOrder,
    priorityIndex: 0,
    passedPlayerIds: [],
    status: priorityOrder.length === 0 ? "closed" : "open",
    openedAt: input.openedAt,
    deadlineAt: input.openedAt + REACTION_DEADLINE_MS,
    continuation,
  };
}

function parentWindow(value: unknown): ReactionWindow | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<ReactionWindow>;
  return typeof candidate.windowId === "string" &&
    typeof candidate.effectId === "string" &&
    candidate.continuation !== undefined
    ? (candidate as ReactionWindow)
    : null;
}

export function reduceReactionEvent(
  state: Readonly<MatchState>,
  event: Readonly<DomainEvent>,
): MatchState {
  if (
    event.matchId !== state.matchId ||
    event.sequence !== state.eventSequence + 1 ||
    event.rulesetVersion !== state.rulesetVersion
  ) {
    throw new Error("Reaction event does not extend the current match head.");
  }
  if (state.phase !== "playing" || state.turn?.phase !== "action") {
    throw new Error("Reaction events require the action phase.");
  }
  const matchVersion = numberPayload(event, "matchVersion");
  const expectedMatchVersion =
    event.causationEventId === null ? state.version + 1 : state.version;
  if (matchVersion !== expectedMatchVersion) {
    throw new Error("Reaction event has an invalid match version.");
  }

  let next: MatchState;
  if (event.type === "effect.started") {
    const playerId = stringPayload(event, "playerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const targetPlayerId = stringPayload(event, "targetPlayerId");
    const effectId = stringPayload(event, "effectId");
    const windowId = stringPayload(event, "windowId");
    const openedAt = numberPayload(event, "openedAt");
    const player = state.players[playerId];
    const target = state.players[targetPlayerId];
    if (
      state.reactionWindow !== null ||
      state.activePlayerId !== playerId ||
      player === undefined ||
      target === undefined ||
      !target.alive ||
      !player.hand.includes(cardInstanceId) ||
      cardDefinition(cardInstanceId).coreAction?.type !== "draw-two" ||
      effectById(state, effectId) !== undefined
    ) {
      throw new Error("Original effect event is not applicable.");
    }
    const effect: EffectFrame = {
      effectId,
      parentEffectId: null,
      kind: `card:${cardDefinition(cardInstanceId).id}`,
      sourcePlayerId: playerId,
      targetIds: [targetPlayerId],
      step: "awaiting-reactions",
      status: "waiting",
      payload: { cardInstanceId },
    };
    const withoutCard = player.hand.filter((card) => card !== cardInstanceId);
    const intermediate: MatchState = {
      ...state,
      players: {
        ...state.players,
        [playerId]: { ...player, hand: withoutCard },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      effectStack: [...state.effectStack, effect],
    };
    next = {
      ...intermediate,
      reactionWindow: makeWindow({
        state: intermediate,
        effect,
        windowId,
        parentWindow: null,
        afterPlayerId: playerId,
        openedAt,
      }),
    };
  } else if (event.type === "reaction.card-played") {
    const playerId = stringPayload(event, "playerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const targetEffectId = stringPayload(event, "targetEffectId");
    const effectId = stringPayload(event, "effectId");
    const windowId = stringPayload(event, "windowId");
    const openedAt = numberPayload(event, "openedAt");
    const window = state.reactionWindow;
    const player = state.players[playerId];
    const targetEffect = effectById(state, targetEffectId);
    if (
      window === null ||
      window.status !== "open" ||
      window.effectId !== targetEffectId ||
      window.priorityOrder[window.priorityIndex] !== playerId ||
      player === undefined ||
      !player.hand.includes(cardInstanceId) ||
      cardDefinition(cardInstanceId).coreAction?.type !== "cancel-effect" ||
      targetEffect === undefined ||
      targetEffect.status !== "waiting" ||
      effectById(state, effectId) !== undefined
    ) {
      throw new Error("Reaction card event is not applicable.");
    }
    const effect: EffectFrame = {
      effectId,
      parentEffectId: targetEffectId,
      kind: "cancel-effect",
      sourcePlayerId: playerId,
      targetIds: [targetEffectId],
      step: "awaiting-reactions",
      status: "waiting",
      payload: { cardInstanceId },
    };
    const intermediate: MatchState = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          hand: player.hand.filter((card) => card !== cardInstanceId),
        },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      effectStack: [
        ...updateEffects(state, { [targetEffectId]: "pending" }),
        effect,
      ],
    };
    next = {
      ...intermediate,
      reactionWindow: makeWindow({
        state: intermediate,
        effect,
        windowId,
        parentWindow: window,
        afterPlayerId: playerId,
        openedAt,
      }),
    };
  } else if (event.type === "reaction.passed") {
    const playerId = stringPayload(event, "playerId");
    const windowId = stringPayload(event, "windowId");
    const openedAt = numberPayload(event, "openedAt");
    const window = state.reactionWindow;
    if (
      window === null ||
      window.status !== "open" ||
      window.windowId !== windowId ||
      window.priorityOrder[window.priorityIndex] !== playerId
    ) {
      throw new Error("Reaction pass event is not applicable.");
    }
    const passedPlayerIds = [...window.passedPlayerIds, playerId];
    const closed = passedPlayerIds.length === window.priorityOrder.length;
    next = {
      ...state,
      reactionWindow: {
        ...window,
        priorityIndex: closed ? window.priorityIndex : window.priorityIndex + 1,
        passedPlayerIds,
        status: closed ? "closed" : "open",
        openedAt,
        deadlineAt: openedAt + REACTION_DEADLINE_MS,
      },
    };
  } else if (event.type === "effect.resolved") {
    const effectId = stringPayload(event, "effectId");
    const resolvedAt = numberPayload(event, "resolvedAt");
    const window = state.reactionWindow;
    const effect = effectById(state, effectId);
    if (
      window === null ||
      window.status !== "closed" ||
      window.effectId !== effectId ||
      effect === undefined ||
      effect.status !== "waiting"
    ) {
      throw new Error("Effect resolution event is not applicable.");
    }
    if (effect.kind === "cancel-effect") {
      const targetEffectId = effect.targetIds[0];
      if (stringPayload(event, "targetEffectId") !== targetEffectId) {
        throw new Error(
          "Cancellation resolution target does not match effect.",
        );
      }
      const target =
        targetEffectId === undefined
          ? undefined
          : effectById(state, targetEffectId);
      if (target === undefined || target.status !== "pending") {
        throw new Error("Cancellation target is not pending.");
      }
      let restoredWindow: ReactionWindow | null = null;
      const statuses: Record<EffectId, EffectFrame["status"]> = {
        [effect.effectId]: "resolved",
        [target.effectId]: "cancelled",
      };
      if (target.kind === "cancel-effect") {
        const targetWindow = parentWindow(
          window.continuation.locals.parentWindow,
        );
        const originalWindow = parentWindow(
          targetWindow?.continuation.locals.parentWindow,
        );
        const originalEffect =
          originalWindow === null
            ? undefined
            : effectById(state, originalWindow.effectId);
        if (
          originalWindow === null ||
          originalEffect === undefined ||
          effect.sourcePlayerId === null
        ) {
          throw new Error("Counter-cancellation continuation is missing.");
        }
        statuses[originalEffect.effectId] = "waiting";
        restoredWindow = makeWindow({
          state,
          effect: { ...originalEffect, status: "waiting" },
          windowId: originalWindow.windowId,
          parentWindow: parentWindow(
            originalWindow.continuation.locals.parentWindow,
          ),
          afterPlayerId: effect.sourcePlayerId,
          openedAt: resolvedAt,
        });
      }
      next = {
        ...state,
        effectStack: pruneTerminalTail(updateEffects(state, statuses)),
        reactionWindow: restoredWindow,
      };
    } else if (effect.kind === "card:xyy.card.jp04") {
      const targetPlayerId = effect.targetIds[0];
      const target =
        targetPlayerId === undefined
          ? undefined
          : state.players[targetPlayerId];
      if (target === undefined || !target.alive) {
        throw new Error("Resolved draw-two target is no longer legal.");
      }
      const expected = planDraw(state, 2);
      const cards = event.payload.cardInstanceIds;
      if (
        !Array.isArray(cards) ||
        cards.some((card) => typeof card !== "string") ||
        !sameValues(cards as string[], expected.cards) ||
        numberPayload(event, "rngCursor") !== expected.rng.cursor
      ) {
        throw new Error("Resolved draw-two disagrees with deterministic draw.");
      }
      next = {
        ...state,
        players: {
          ...state.players,
          [targetPlayerId!]: {
            ...target,
            hand: [...target.hand, ...expected.cards],
          },
        },
        drawPile: expected.drawPile,
        discardPile: expected.discardPile,
        rng: expected.rng,
        effectStack: pruneTerminalTail(
          updateEffects(state, { [effectId]: "resolved" }),
        ),
        reactionWindow: null,
      };
    } else {
      throw new Error(`Unsupported resolvable effect ${effect.kind}.`);
    }
  } else {
    throw new Error(`Unsupported reaction event ${event.type}.`);
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
    private readonly serverReceivedAt: number,
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
    this.state = reduceReactionEvent(this.state, event);
  }

  resolveClosedWindows(): void {
    let guard = 0;
    while (this.state.reactionWindow?.status === "closed") {
      guard += 1;
      if (guard > this.state.effectStack.length + 1) {
        throw new Error("Closed reaction windows did not converge.");
      }
      const effectId = this.state.reactionWindow.effectId;
      const effect = effectById(this.state, effectId);
      if (effect === undefined)
        throw new Error("Closed window effect is missing.");
      if (effect.kind === "card:xyy.card.jp04") {
        const planned = planDraw(this.state, 2);
        this.append("effect.resolved", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          cardInstanceIds: planned.cards,
          rngCursor: planned.rng.cursor,
        });
      } else {
        this.append("effect.resolved", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          targetEffectId: effect.targetIds[0],
        });
      }
    }
  }
}

function validServerTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function beginCancellableCardEffect(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
  cardInstanceId: CardInstanceId,
  targetPlayerId: PlayerId,
): ApplyCommandResult {
  if (!validServerTime(serverReceivedAt)) {
    return {
      accepted: false,
      reason: "invalid",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    envelope.commandId,
    input.version + 1,
    serverReceivedAt,
  );
  builder.append("effect.started", {
    playerId: envelope.playerId,
    cardInstanceId,
    targetPlayerId,
    effectId: `${input.matchId}:effect:${envelope.commandId}`,
    windowId: `${input.matchId}:window:${envelope.commandId}`,
    openedAt: serverReceivedAt,
  });
  builder.resolveClosedWindows();
  return { accepted: true, state: builder.state, events: builder.events };
}

export function applyReactionCommand(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
): ApplyCommandResult {
  const window = input.reactionWindow;
  if (window === null || window.status !== "open") {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  if (!validServerTime(serverReceivedAt)) {
    return {
      accepted: false,
      reason: "invalid",
      currentVersion: input.version,
    };
  }
  if (serverReceivedAt > window.deadlineAt) {
    return {
      accepted: false,
      reason: "expired-window",
      currentVersion: input.version,
    };
  }
  const priorityPlayerId = window.priorityOrder[window.priorityIndex];
  if (priorityPlayerId !== envelope.playerId) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    envelope.commandId,
    input.version + 1,
    serverReceivedAt,
  );
  const command = envelope.command;
  if (command.type === "pass-reaction") {
    if (command.windowId !== window.windowId) {
      return {
        accepted: false,
        reason: "expired-window",
        currentVersion: input.version,
      };
    }
    builder.append("reaction.passed", {
      playerId: envelope.playerId,
      windowId: window.windowId,
      openedAt: serverReceivedAt,
    });
    builder.resolveClosedWindows();
  } else if (command.type === "play-reaction-card") {
    if (command.targetEffectId !== window.effectId) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const cardInstanceId = command.cardInstanceId as CardInstanceId;
    const player = input.players[envelope.playerId]!;
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
    if (
      !player.hand.includes(cardInstanceId) ||
      definition.coreAction?.type !== "cancel-effect"
    ) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    builder.append("reaction.card-played", {
      playerId: envelope.playerId,
      cardInstanceId,
      targetEffectId: window.effectId,
      effectId: `${input.matchId}:effect:${envelope.commandId}`,
      windowId: `${input.matchId}:window:${envelope.commandId}`,
      openedAt: serverReceivedAt,
    });
    builder.resolveClosedWindows();
  } else {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  return { accepted: true, state: builder.state, events: builder.events };
}
