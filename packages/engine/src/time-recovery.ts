import type { CommandId, PlayerId } from "@xiaoyaoyou/protocol";
import type {
  ApplyCommandResult,
  DomainEvent,
  EngineCommand,
} from "./architecture.js";
import type { MatchState } from "./index.js";

export const ACTION_DEADLINE_MS = 15_000;
export const DISCONNECT_GRACE_MS = 60_000;

export interface SystemDeadline {
  readonly id: string;
  readonly origin: "system-timeout" | "system-auto";
  readonly deadlineAt: number;
  readonly targetId: string;
  readonly playerId: PlayerId;
  readonly disconnectedAt?: number;
}

export type TimeoutResolver = (
  state: Readonly<MatchState>,
  command: Readonly<Extract<EngineCommand, { origin: "system-timeout" }>>,
  deadline: Readonly<SystemDeadline>,
) => ApplyCommandResult;

function systemEvent(
  state: Readonly<MatchState>,
  commandId: CommandId,
  type: string,
  payload: Readonly<Record<string, unknown>>,
  causationEventId: string | null = null,
): DomainEvent {
  return {
    eventId: `${state.matchId}:event:${state.eventSequence + 1}`,
    sequence: state.eventSequence + 1,
    matchId: state.matchId,
    causationCommandId: commandId,
    causationEventId,
    rulesetVersion: state.rulesetVersion,
    type,
    payload: {
      ...payload,
      matchVersion: state.version + (causationEventId ? 0 : 1),
    },
  };
}

function effectiveDeadline(
  state: Readonly<MatchState>,
  playerId: PlayerId,
  openedAt: number,
  deadlineAt: number,
): number {
  return state.connections[playerId]?.status === "auto" ? openedAt : deadlineAt;
}

/** Pure scheduling projection. Timers may enqueue only these stable targets. */
export function collectSystemDeadlines(
  state: Readonly<MatchState>,
): readonly SystemDeadline[] {
  const deadlines: SystemDeadline[] = [];
  for (const [playerId, connection] of Object.entries(state.connections)) {
    if (connection.status === "grace" && connection.disconnectedAt !== null) {
      const deadlineAt = connection.disconnectedAt + DISCONNECT_GRACE_MS;
      deadlines.push({
        id: `auto:${playerId}:${connection.disconnectedAt}`,
        origin: "system-auto",
        deadlineAt,
        targetId: `connection:${playerId}:${connection.disconnectedAt}`,
        playerId,
        disconnectedAt: connection.disconnectedAt,
      });
    }
  }

  if (state.phase === "setup" && state.setup?.status === "selecting-heroes") {
    for (const playerId of state.turnOrder) {
      if (state.setup.offers[playerId]?.selectedHeroId !== null) continue;
      const deadlineAt = effectiveDeadline(
        state,
        playerId,
        state.setup.openedAt,
        state.setup.deadlineAt,
      );
      deadlines.push({
        id: `timeout:setup:${playerId}:${deadlineAt}`,
        origin: "system-timeout",
        deadlineAt,
        targetId: `setup:${playerId}`,
        playerId,
      });
    }
    return deadlines;
  }

  if (state.phase !== "playing") return deadlines;
  const batch = state.dyingBatch;
  const choice = state.pendingChoice;
  if (batch !== null && choice !== null && batch.status === "awaiting-rescue") {
    const playerId = batch.priorityOrder[batch.priorityIndex];
    if (playerId !== undefined) {
      const deadlineAt = effectiveDeadline(
        state,
        playerId,
        choice.openedAt,
        choice.deadlineAt,
      );
      deadlines.push({
        id: `timeout:rescue:${choice.choiceId}:${playerId}:${deadlineAt}`,
        origin: "system-timeout",
        deadlineAt,
        targetId: `rescue:${choice.choiceId}:${playerId}`,
        playerId,
      });
    }
    return deadlines;
  }
  if (
    batch?.status === "distributing-loot" &&
    choice !== null &&
    choice.status === "open"
  ) {
    const playerId = choice.playerIds[0];
    if (playerId !== undefined) {
      const deadlineAt = effectiveDeadline(
        state,
        playerId,
        choice.openedAt,
        choice.deadlineAt,
      );
      deadlines.push({
        id: `timeout:death-loot:${choice.choiceId}:${playerId}:${deadlineAt}`,
        origin: "system-timeout",
        deadlineAt,
        targetId: `death-loot:${choice.choiceId}:${playerId}`,
        playerId,
      });
    }
    return deadlines;
  }
  if (choice !== null && choice.status === "open") {
    const playerId = choice.playerIds[0];
    if (playerId !== undefined) {
      const deadlineAt = effectiveDeadline(
        state,
        playerId,
        choice.openedAt,
        choice.deadlineAt,
      );
      deadlines.push({
        id: `timeout:choice:${choice.choiceId}:${playerId}:${deadlineAt}`,
        origin: "system-timeout",
        deadlineAt,
        targetId: `choice:${choice.choiceId}:${playerId}`,
        playerId,
      });
    }
    return deadlines;
  }
  const reaction = state.reactionWindow;
  if (reaction?.status === "open") {
    const playerId = reaction.priorityOrder[reaction.priorityIndex];
    if (playerId !== undefined) {
      const deadlineAt = effectiveDeadline(
        state,
        playerId,
        reaction.openedAt,
        reaction.deadlineAt,
      );
      deadlines.push({
        id: `timeout:reaction:${reaction.windowId}:${playerId}:${deadlineAt}`,
        origin: "system-timeout",
        deadlineAt,
        targetId: `reaction:${reaction.windowId}:${playerId}`,
        playerId,
      });
    }
    return deadlines;
  }
  const battleWindow = state.encounterState.battle?.cardWindow;
  if (state.encounterState.battle?.stage === "card-window" && battleWindow) {
    for (const playerId of battleWindow.playerIds.filter(
      (id) => !battleWindow.passedPlayerIds.includes(id),
    )) {
      const deadlineAt = effectiveDeadline(
        state,
        playerId,
        battleWindow.openedAt,
        battleWindow.deadlineAt,
      );
      deadlines.push({
        id: `timeout:battle:${battleWindow.windowId}:${playerId}:${deadlineAt}`,
        origin: "system-timeout",
        deadlineAt,
        targetId: `battle:${battleWindow.windowId}:${playerId}`,
        playerId,
      });
    }
    return deadlines;
  }
  if (
    state.turn !== null &&
    state.activePlayerId !== null &&
    (state.turn.phase === "action" || state.turn.phase === "discard")
  ) {
    const playerId = state.activePlayerId;
    const deadlineAt = effectiveDeadline(
      state,
      playerId,
      state.turn.openedAt,
      state.turn.deadlineAt,
    );
    deadlines.push({
      id: `timeout:turn:${state.turn.number}:${state.turn.phase}:${playerId}:${deadlineAt}`,
      origin: "system-timeout",
      deadlineAt,
      targetId: `turn:${state.turn.number}:${state.turn.phase}:${playerId}`,
      playerId,
    });
  }
  return deadlines;
}

export function reduceTimeRecoveryEvent(
  state: Readonly<MatchState>,
  event: Readonly<DomainEvent>,
): MatchState {
  if (
    event.matchId !== state.matchId ||
    event.sequence !== state.eventSequence + 1 ||
    event.rulesetVersion !== state.rulesetVersion
  ) {
    throw new Error(
      "Time/recovery event does not extend the current match head.",
    );
  }
  const matchVersion = event.payload.matchVersion;
  const expected =
    event.causationEventId === null ? state.version + 1 : state.version;
  if (matchVersion !== expected) {
    throw new Error("Time/recovery event has an invalid match version.");
  }
  let next = state as MatchState;
  if (event.type === "connection.connected") {
    const playerId = event.payload.playerId as PlayerId;
    if (!(playerId in state.players))
      throw new Error("Unknown connected player.");
    next = {
      ...state,
      connections: {
        ...state.connections,
        [playerId]: { status: "connected", disconnectedAt: null, autoAt: null },
      },
    };
  } else if (event.type === "connection.disconnected") {
    const playerId = event.payload.playerId as PlayerId;
    const disconnectedAt = event.payload.disconnectedAt;
    if (!(playerId in state.players) || typeof disconnectedAt !== "number") {
      throw new Error("Invalid disconnected player event.");
    }
    next = {
      ...state,
      connections: {
        ...state.connections,
        [playerId]: { status: "grace", disconnectedAt, autoAt: null },
      },
    };
  } else if (event.type === "connection.auto-enabled") {
    const playerId = event.payload.playerId as PlayerId;
    const disconnectedAt = event.payload.disconnectedAt;
    const autoAt = event.payload.autoAt;
    const current = state.connections[playerId];
    if (
      current?.status !== "grace" ||
      typeof disconnectedAt !== "number" ||
      current.disconnectedAt !== disconnectedAt ||
      typeof autoAt !== "number"
    ) {
      throw new Error(
        "Auto-mode event no longer matches disconnect generation.",
      );
    }
    next = {
      ...state,
      connections: {
        ...state.connections,
        [playerId]: { status: "auto", disconnectedAt, autoAt },
      },
    };
  } else if (event.type !== "system.timeout-resolved") {
    throw new Error(`Unsupported time/recovery event ${event.type}.`);
  }
  return {
    ...next,
    version: matchVersion as number,
    eventSequence: event.sequence,
  };
}

export function applySystemCommand(
  state: Readonly<MatchState>,
  command: Readonly<Exclude<EngineCommand, { origin: "player" }>>,
  resolveTimeout: TimeoutResolver,
): ApplyCommandResult {
  if (command.matchId !== state.matchId) {
    return {
      accepted: false,
      reason: "forbidden",
      currentVersion: state.version,
    };
  }
  if (command.expectedVersion !== state.version) {
    return {
      accepted: false,
      reason: "stale-version",
      currentVersion: state.version,
    };
  }
  if (command.origin === "system-presence") {
    if (
      !(command.playerId in state.players) ||
      !Number.isSafeInteger(command.occurredAt) ||
      command.occurredAt < 0
    ) {
      return {
        accepted: false,
        reason: "invalid",
        currentVersion: state.version,
      };
    }
    const current = state.connections[command.playerId];
    if (
      (command.status === "connected" && current?.status === "connected") ||
      (command.status === "disconnected" &&
        current?.status !== "connected" &&
        current?.disconnectedAt === command.occurredAt)
    ) {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: state.version,
      };
    }
    const event = systemEvent(
      state,
      command.commandId,
      command.status === "connected"
        ? "connection.connected"
        : "connection.disconnected",
      command.status === "connected"
        ? { playerId: command.playerId, connectedAt: command.occurredAt }
        : { playerId: command.playerId, disconnectedAt: command.occurredAt },
    );
    const next = reduceTimeRecoveryEvent(state, event);
    return { accepted: true, state: next, events: [event] };
  }
  const deadlines = collectSystemDeadlines(state);
  if (command.origin === "system-auto") {
    const target = deadlines.find(
      (candidate) =>
        candidate.origin === "system-auto" &&
        candidate.playerId === command.playerId &&
        candidate.deadlineAt === command.deadlineAt &&
        candidate.disconnectedAt === command.disconnectedAt,
    );
    if (target === undefined) {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: state.version,
      };
    }
    const event = systemEvent(
      state,
      command.commandId,
      "connection.auto-enabled",
      {
        playerId: command.playerId,
        disconnectedAt: command.disconnectedAt,
        autoAt: command.deadlineAt,
      },
    );
    const next = reduceTimeRecoveryEvent(state, event);
    return { accepted: true, state: next, events: [event] };
  }
  const target = deadlines.find(
    (candidate) =>
      candidate.origin === "system-timeout" &&
      candidate.targetId === command.targetId &&
      candidate.deadlineAt === command.deadlineAt,
  );
  if (target === undefined) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: state.version,
    };
  }
  const resolved = resolveTimeout(state, command, target);
  if (!resolved.accepted) return resolved;
  const previous = resolved.events.at(-1)?.eventId ?? null;
  const marker = systemEvent(
    resolved.state,
    command.commandId,
    "system.timeout-resolved",
    { targetId: command.targetId, deadlineAt: command.deadlineAt },
    previous,
  );
  const next = reduceTimeRecoveryEvent(resolved.state, marker);
  return { accepted: true, state: next, events: [...resolved.events, marker] };
}
