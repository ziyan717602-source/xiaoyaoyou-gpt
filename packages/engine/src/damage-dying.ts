import type {
  CommandEnvelope,
  CommandId,
  EffectId,
  PlayerId,
} from "@xiaoyaoyou/protocol";
import type { ApplyCommandResult, DomainEvent } from "./architecture.js";
import type {
  DyingBatch,
  MatchState,
  PendingChoice,
  PlayerState,
  TeamId,
} from "./index.js";
import { cardDefinition, type CardInstanceId } from "./setup-content.js";
import { reduceTurnEvent } from "./turn.js";

export const RESCUE_DEADLINE_MS = 15_000;

export interface DamageIntent {
  readonly itemId: string;
  readonly sourcePlayerId: PlayerId | null;
  readonly targetPlayerId: PlayerId;
  readonly amount: number;
  readonly element: string;
}

export interface DamageModifier {
  readonly effectId: EffectId;
  readonly sourcePlayerId: PlayerId;
  readonly priority: number;
  readonly kind: "replacement" | "addition" | "reduction";
  readonly amount: number;
  readonly replacementTargetPlayerId?: PlayerId;
}

export interface AppliedDamage {
  readonly itemId: string;
  readonly sourcePlayerId: PlayerId | null;
  readonly targetPlayerId: PlayerId;
  readonly amount: number;
  readonly element: string;
  readonly appliedReplacementEffectIds: readonly EffectId[];
}

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

function seatOrder(
  state: Readonly<MatchState>,
  livingOnly = true,
): readonly PlayerId[] {
  return Object.values(state.players)
    .filter((player) => !livingOnly || player.alive)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
}

function priorityFromTarget(
  state: Readonly<MatchState>,
  targetPlayerId: PlayerId,
): readonly PlayerId[] {
  const living = seatOrder(state);
  const start = living.indexOf(targetPlayerId);
  if (start < 0) return living;
  return Array.from(
    { length: living.length },
    (_, offset) => living[(start + offset) % living.length]!,
  );
}

function modifierSeat(
  state: Readonly<MatchState>,
  modifier: DamageModifier,
): number {
  return (
    state.players[modifier.sourcePlayerId]?.seat ?? Number.MAX_SAFE_INTEGER
  );
}

export function planDamageBatch(
  state: Readonly<MatchState>,
  intents: readonly DamageIntent[],
  modifiers: readonly DamageModifier[] = [],
): readonly AppliedDamage[] {
  for (const modifier of modifiers) {
    if (!Number.isSafeInteger(modifier.amount) || modifier.amount < 0) {
      throw new Error(
        "Damage modifier amount must be a nonnegative safe integer.",
      );
    }
    if (!Number.isSafeInteger(modifier.priority)) {
      throw new Error("Damage modifier priority must be a safe integer.");
    }
  }
  const orderedModifiers = [...modifiers].sort(
    (left, right) =>
      left.priority - right.priority ||
      modifierSeat(state, left) - modifierSeat(state, right) ||
      left.effectId.localeCompare(right.effectId),
  );
  return intents.map((intent) => {
    if (!Number.isSafeInteger(intent.amount) || intent.amount < 0) {
      throw new Error("Damage amount must be a nonnegative safe integer.");
    }
    let targetPlayerId = intent.targetPlayerId;
    let amount = intent.amount;
    const replacements = new Set<EffectId>();
    for (const modifier of orderedModifiers) {
      if (modifier.kind !== "replacement") continue;
      if (replacements.has(modifier.effectId)) continue;
      replacements.add(modifier.effectId);
      targetPlayerId = modifier.replacementTargetPlayerId ?? targetPlayerId;
      amount = modifier.amount;
    }
    for (const modifier of orderedModifiers) {
      if (modifier.kind === "addition") amount += modifier.amount;
    }
    for (const modifier of orderedModifiers) {
      if (modifier.kind === "reduction") amount -= modifier.amount;
    }
    if (!Number.isSafeInteger(amount)) {
      throw new Error("Modified damage amount must remain a safe integer.");
    }
    if (!(targetPlayerId in state.players)) {
      throw new Error(`Unknown damage target ${targetPlayerId}.`);
    }
    return {
      ...intent,
      targetPlayerId,
      amount: Math.max(0, amount),
      appliedReplacementEffectIds: [...replacements],
    };
  });
}

function makePendingChoice(
  state: Readonly<MatchState>,
  batch: DyingBatch,
): PendingChoice {
  const priority = batch.priorityOrder[batch.priorityIndex];
  if (priority === undefined) throw new Error("Rescue priority is empty.");
  return {
    choiceId: `${batch.batchId}:choice:${batch.currentIndex}`,
    playerIds: [priority],
    prompt: `rescue:${batch.currentTargetPlayerId}`,
    minSelections: 0,
    maxSelections: 1,
    optionIds: [batch.currentTargetPlayerId],
    optional: true,
    status: "open",
    openedAt: batch.openedAt,
    deadlineAt: batch.deadlineAt,
    fallback: "pass",
    continuation: {
      continuationId: `${batch.batchId}:continuation:${batch.currentIndex}`,
      effectId: batch.sourceEffectId,
      step: "after-rescue",
      locals: {
        batchId: batch.batchId,
        targetPlayerId: batch.currentTargetPlayerId,
      },
      resumeWith: "advance-dying-batch",
    },
  };
}

function openTarget(
  state: Readonly<MatchState>,
  batch: DyingBatch,
  fromIndex: number,
  openedAt: number,
): MatchState {
  let currentIndex = fromIndex;
  while (currentIndex < batch.targetPlayerIds.length) {
    const candidate = state.players[batch.targetPlayerIds[currentIndex]!];
    if (candidate?.alive === true && candidate.hp === 0) break;
    currentIndex += 1;
  }
  if (currentIndex >= batch.targetPlayerIds.length) {
    return { ...state, dyingBatch: null, pendingChoice: null };
  }
  const currentTargetPlayerId = batch.targetPlayerIds[currentIndex]!;
  const priorityOrder = priorityFromTarget(state, currentTargetPlayerId);
  const opened: DyingBatch = {
    ...batch,
    currentIndex,
    currentTargetPlayerId,
    priorityOrder,
    priorityIndex: 0,
    passedPlayerIds: [],
    status: "awaiting-rescue",
    openedAt,
    deadlineAt: openedAt + RESCUE_DEADLINE_MS,
  };
  return {
    ...state,
    dyingBatch: opened,
    pendingChoice: makePendingChoice(state, opened),
  };
}

export function beginDyingBatch(
  state: Readonly<MatchState>,
  sourceEffectId: EffectId,
  openedAt: number,
): MatchState {
  const targetPlayerIds = Object.values(state.players)
    .filter((player) => player.alive && player.hp === 0)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  if (targetPlayerIds.length === 0) {
    return { ...state, dyingBatch: null, pendingChoice: null };
  }
  const initial: DyingBatch = {
    batchId: `${state.matchId}:dying:${sourceEffectId}`,
    sourceEffectId,
    targetPlayerIds,
    currentIndex: 0,
    currentTargetPlayerId: targetPlayerIds[0]!,
    priorityOrder: [],
    priorityIndex: 0,
    passedPlayerIds: [],
    rescuedPlayerIds: [],
    deadPlayerIds: [],
    status: "awaiting-rescue",
    openedAt,
    deadlineAt: openedAt + RESCUE_DEADLINE_MS,
  };
  return openTarget(state, initial, 0, openedAt);
}

export function applyPlannedDamage(
  state: Readonly<MatchState>,
  sourceEffectId: EffectId,
  applied: readonly AppliedDamage[],
  openedAt: number,
): MatchState {
  const players: Record<PlayerId, PlayerState> = { ...state.players };
  for (const damage of applied) {
    const target = players[damage.targetPlayerId];
    if (target === undefined || !target.alive) {
      throw new Error("Applied damage target is not alive.");
    }
    players[damage.targetPlayerId] = {
      ...target,
      hp: Math.max(0, target.hp - damage.amount),
    };
  }
  return beginDyingBatch({ ...state, players }, sourceEffectId, openedAt);
}

function advanceBatch(
  state: Readonly<MatchState>,
  batch: DyingBatch,
  openedAt: number,
): MatchState {
  return openTarget(state, batch, batch.currentIndex + 1, openedAt);
}

export function reduceDyingEvent(
  state: Readonly<MatchState>,
  event: Readonly<DomainEvent>,
): MatchState {
  if (
    event.matchId !== state.matchId ||
    event.sequence !== state.eventSequence + 1 ||
    event.rulesetVersion !== state.rulesetVersion
  ) {
    throw new Error("Dying event does not extend the current match head.");
  }
  if (state.phase !== "playing" || state.turn?.phase !== "action") {
    throw new Error("Dying events require the action phase.");
  }
  const matchVersion = numberPayload(event, "matchVersion");
  const expectedMatchVersion =
    event.causationEventId === null ? state.version + 1 : state.version;
  if (matchVersion !== expectedMatchVersion) {
    throw new Error("Dying event has an invalid match version.");
  }
  const batch = state.dyingBatch;
  if (batch === null) throw new Error("Dying batch is missing.");
  let next: MatchState;
  if (event.type === "rescue.passed") {
    const playerId = stringPayload(event, "playerId");
    const choiceId = stringPayload(event, "choiceId");
    const passedAt = numberPayload(event, "passedAt");
    const priority = batch.priorityOrder[batch.priorityIndex];
    if (
      batch.status !== "awaiting-rescue" ||
      state.pendingChoice?.status !== "open" ||
      state.pendingChoice.choiceId !== choiceId ||
      priority !== playerId
    ) {
      throw new Error("Rescue pass is not applicable.");
    }
    const passedPlayerIds = [...batch.passedPlayerIds, playerId];
    const closed = passedPlayerIds.length === batch.priorityOrder.length;
    const updated: DyingBatch = {
      ...batch,
      passedPlayerIds,
      priorityIndex: closed ? batch.priorityIndex : batch.priorityIndex + 1,
      status: closed ? "awaiting-death" : "awaiting-rescue",
      openedAt: passedAt,
      deadlineAt: passedAt + RESCUE_DEADLINE_MS,
    };
    next = {
      ...state,
      dyingBatch: updated,
      pendingChoice: closed
        ? { ...state.pendingChoice, status: "closed" }
        : makePendingChoice(state, updated),
    };
  } else if (event.type === "rescue.card-played") {
    const playerId = stringPayload(event, "playerId");
    const targetPlayerId = stringPayload(event, "targetPlayerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const rescuedAt = numberPayload(event, "rescuedAt");
    const player = state.players[playerId];
    const target = state.players[targetPlayerId];
    if (
      batch.status !== "awaiting-rescue" ||
      state.pendingChoice?.status !== "open" ||
      batch.priorityOrder[batch.priorityIndex] !== playerId ||
      targetPlayerId !== batch.currentTargetPlayerId ||
      player === undefined ||
      target === undefined ||
      !target.alive ||
      target.hp !== 0 ||
      !player.hand.includes(cardInstanceId) ||
      cardDefinition(cardInstanceId).coreAction?.type !== "rescue-two"
    ) {
      throw new Error("Rescue card event is not applicable.");
    }
    const intermediate: MatchState = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          hand: player.hand.filter((card) => card !== cardInstanceId),
        },
        [targetPlayerId]: {
          ...target,
          hp: Math.min(target.maxHp, target.hp + 2),
        },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      dyingBatch: {
        ...batch,
        rescuedPlayerIds: [...batch.rescuedPlayerIds, targetPlayerId],
      },
      pendingChoice: null,
    };
    next = advanceBatch(intermediate, intermediate.dyingBatch!, rescuedAt);
  } else if (event.type === "death.player-died") {
    const playerId = stringPayload(event, "playerId");
    const player = state.players[playerId];
    if (
      batch.status !== "awaiting-death" ||
      playerId !== batch.currentTargetPlayerId ||
      player === undefined ||
      !player.alive ||
      player.hp !== 0
    ) {
      throw new Error("Death event is not applicable.");
    }
    const discarded = [
      ...player.hand,
      ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
      ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
    ];
    const expectedDiscarded = stringsPayload(event, "cardInstanceIds");
    if (
      discarded.length !== expectedDiscarded.length ||
      discarded.some((card, index) => card !== expectedDiscarded[index])
    ) {
      throw new Error("Death cleanup cards do not match player zones.");
    }
    next = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          alive: false,
          hp: 0,
          hand: [],
          equipment: { weapon: null, armor: null },
        },
      },
      discardPile: [...state.discardPile, ...discarded],
      dyingBatch: {
        ...batch,
        deadPlayerIds: [...batch.deadPlayerIds, playerId],
        status: "after-death",
      },
      pendingChoice: null,
    };
  } else if (event.type === "death.after-effects-completed") {
    const playerId = stringPayload(event, "playerId");
    const completedAt = numberPayload(event, "completedAt");
    if (
      batch.status !== "after-death" ||
      playerId !== batch.currentTargetPlayerId ||
      state.players[playerId]?.alive !== false
    ) {
      throw new Error("After-death completion is not applicable.");
    }
    next = advanceBatch(state, batch, completedAt);
  } else {
    throw new Error(`Unsupported dying event ${event.type}.`);
  }
  return { ...next, version: matchVersion, eventSequence: event.sequence };
}

function aliveTeams(state: Readonly<MatchState>): readonly TeamId[] {
  return [
    ...new Set(
      Object.values(state.players)
        .filter((player) => player.alive && player.team !== null)
        .map((player) => player.team!),
    ),
  ].sort();
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
    this.state =
      type === "match.finished"
        ? reduceTurnEvent(this.state, event)
        : reduceDyingEvent(this.state, event);
  }

  resolveClosedRescue(): void {
    if (this.state.dyingBatch?.status !== "awaiting-death") return;
    const playerId = this.state.dyingBatch.currentTargetPlayerId;
    const player = this.state.players[playerId]!;
    const cardInstanceIds = [
      ...player.hand,
      ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
      ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
    ];
    this.append("death.player-died", { playerId, cardInstanceIds });
    this.append("death.after-effects-completed", {
      playerId,
      completedAt: this.serverReceivedAt,
    });
  }

  finishIfNeeded(): void {
    if (this.state.dyingBatch !== null) return;
    const teams = aliveTeams(this.state);
    if (teams.length > 1) return;
    this.append("match.finished", {
      winner: teams.length === 1 ? teams[0]! : "draw",
      reason: "death-cycle",
    });
  }
}

export function applyDyingCommand(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
): ApplyCommandResult {
  const batch = input.dyingBatch;
  const choice = input.pendingChoice;
  if (
    batch === null ||
    choice === null ||
    batch.status !== "awaiting-rescue" ||
    choice.status !== "open"
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
  const priority = batch.priorityOrder[batch.priorityIndex];
  if (priority !== envelope.playerId) {
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
  if (command.type === "pass-rescue") {
    if (command.choiceId !== choice.choiceId) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    builder.append("rescue.passed", {
      playerId: envelope.playerId,
      choiceId: choice.choiceId,
      passedAt: serverReceivedAt,
    });
    builder.resolveClosedRescue();
  } else if (command.type === "play-rescue-card") {
    if (command.targetPlayerId !== batch.currentTargetPlayerId) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const cardInstanceId = command.cardInstanceId as CardInstanceId;
    const player = input.players[envelope.playerId]!;
    let rescueCard = false;
    try {
      rescueCard =
        cardDefinition(cardInstanceId).coreAction?.type === "rescue-two";
    } catch {
      rescueCard = false;
    }
    if (!player.hand.includes(cardInstanceId) || !rescueCard) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    builder.append("rescue.card-played", {
      playerId: envelope.playerId,
      targetPlayerId: command.targetPlayerId,
      cardInstanceId,
      rescuedAt: serverReceivedAt,
    });
  } else {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  builder.finishIfNeeded();
  return { accepted: true, state: builder.state, events: builder.events };
}
