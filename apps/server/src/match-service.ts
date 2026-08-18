import { createHash } from "node:crypto";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type MatchState,
  type EngineCommand,
  type SystemDeadline,
} from "@xiaoyaoyou/engine";
import type {
  CommandEnvelope,
  CommandRejectionReason,
  ErrorCategory,
  MatchId,
  PlayerId,
  ServerMessage,
} from "@xiaoyaoyou/protocol";
import { DeadlineScheduler, MatchActor } from "./match-actor.js";
import { SqliteEventStore } from "./persistence.js";
import type { MatchPresence } from "./room-store.js";

type ActorResult = ServerMessage;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function commandHash(command: Readonly<EngineCommand>): string {
  const value = (() => {
    if (command.origin === "player") {
      return {
        matchId: command.envelope.matchId,
        playerId: command.envelope.playerId,
        command: command.envelope.command,
      };
    }
    const { expectedVersion: _expectedVersion, ...stable } = command;
    return stable;
  })();
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function commandIdentity(command: Readonly<EngineCommand>): {
  readonly commandId: string;
  readonly matchId: MatchId;
  readonly playerId: PlayerId | "system";
} {
  return command.origin === "player"
    ? {
        commandId: command.envelope.commandId,
        matchId: command.envelope.matchId,
        playerId: command.envelope.playerId,
      }
    : {
        commandId: command.commandId,
        matchId: command.matchId,
        playerId: "system",
      };
}

function category(reason: CommandRejectionReason): ErrorCategory {
  switch (reason) {
    case "invalid":
      return "invalid";
    case "forbidden":
      return "forbidden";
    case "stale-version":
    case "stale-sequence":
      return "conflict";
    case "expired-window":
      return "expired";
    case "not-available":
    case "match-finished":
      return "unavailable";
  }
}

export class MatchService {
  readonly #store: SqliteEventStore;
  readonly #actors = new Map<
    MatchId,
    MatchActor<MatchState, EngineCommand, ActorResult>
  >();
  readonly #onChanged: (matchId: MatchId) => Promise<void> | void;
  readonly #now: () => number;
  readonly #scheduler: DeadlineScheduler<EngineCommand>;
  readonly #scheduledByMatch = new Map<MatchId, Set<string>>();

  constructor(
    databasePath: string,
    onChanged: (matchId: MatchId) => Promise<void> | void,
    now: () => number = Date.now,
  ) {
    this.#store = new SqliteEventStore(databasePath);
    this.#onChanged = onChanged;
    this.#now = now;
    this.#scheduler = new DeadlineScheduler(async (command) => {
      await this.#dispatch(command);
    }, now);
  }

  #recover(matchId: MatchId): MatchState {
    const recovery = this.#store.recover<MatchState>(matchId);
    let state = migrateMatchState(recovery.snapshot.state);
    for (const persisted of recovery.events) {
      state = reduceEvent(state, {
        eventId: persisted.eventId,
        sequence: persisted.sequence,
        matchId,
        causationCommandId: persisted.commandId,
        causationEventId: persisted.causationEventId,
        rulesetVersion: persisted.rulesetVersion,
        type: persisted.type,
        payload: persisted.payload,
      });
    }
    if (
      state.version !== recovery.currentVersion ||
      state.eventSequence !== recovery.lastEventSequence
    ) {
      throw new Error(`Recovered match head mismatch for ${matchId}.`);
    }
    return state;
  }

  #actor(matchId: MatchId): MatchActor<MatchState, EngineCommand, ActorResult> {
    const existing = this.#actors.get(matchId);
    if (existing !== undefined) return existing;
    const actor = new MatchActor<MatchState, EngineCommand, ActorResult>({
      initialState: this.#recover(matchId),
      process: async (state, command) => {
        const identity = commandIdentity(command);
        const duplicate = this.#store.getReceipt(matchId, identity.commandId);
        if (duplicate !== null) {
          if (duplicate.playerId !== identity.playerId) {
            return {
              state: state as MatchState,
              result: {
                type: "command-rejected",
                commandId: identity.commandId,
                category: "forbidden",
                reason: "forbidden",
                currentVersion: state.version,
                retryable: false,
              },
            };
          }
          if (duplicate.result.commandHash !== commandHash(command)) {
            return {
              state: state as MatchState,
              result: {
                type: "command-rejected",
                commandId: identity.commandId,
                category: "invalid",
                reason: "invalid",
                currentVersion: state.version,
                retryable: false,
              },
            };
          }
          const receiptVersion = duplicate.result.version;
          return {
            state: state as MatchState,
            result: {
              type: "command-accepted",
              commandId: identity.commandId,
              version:
                typeof receiptVersion === "number"
                  ? receiptVersion
                  : state.version,
              duplicate: true,
            },
          };
        }
        const applied = applyCommand(state, command);
        if (!applied.accepted) {
          return {
            state: state as MatchState,
            result: {
              type: "command-rejected",
              commandId: identity.commandId,
              category: category(applied.reason),
              reason: applied.reason,
              currentVersion: applied.currentVersion,
              retryable:
                applied.reason === "stale-version" ||
                applied.reason === "stale-sequence",
            },
          };
        }
        const committed = this.#store.commitAccepted({
          matchId,
          commandId: identity.commandId,
          playerId: identity.playerId,
          expectedVersion: state.version,
          nextVersion: applied.state.version,
          rulesetVersion: applied.state.rulesetVersion,
          persistenceVersion: applied.state.persistenceVersion,
          events: applied.events.map((domainEvent) => ({
            eventId: domainEvent.eventId,
            sequence: domainEvent.sequence,
            type: domainEvent.type,
            rulesetVersion: domainEvent.rulesetVersion,
            payload: domainEvent.payload,
            causationEventId: domainEvent.causationEventId,
          })),
          state: applied.state,
          result: {
            version: applied.state.version,
            commandHash: commandHash(command),
          },
          snapshotReason: "wait-point",
          now: this.#now(),
        });
        if (committed.status === "conflict") {
          throw new Error(
            `Actor lost single-writer ownership for ${matchId} at ${committed.currentVersion}.`,
          );
        }
        return {
          state: applied.state,
          result: {
            type: "command-accepted",
            commandId: identity.commandId,
            version: applied.state.version,
            duplicate: committed.status === "duplicate",
          },
        };
      },
      saveFinalSnapshot: async (state) => {
        const recovery = this.#store.recover<MatchState>(matchId);
        const eventHash =
          recovery.events.at(-1)?.eventHash ?? recovery.snapshot.eventHash;
        const stateJson = JSON.stringify(state);
        this.#store.saveSnapshot({
          matchId,
          matchVersion: state.version,
          eventSequence: state.eventSequence,
          persistenceVersion: state.persistenceVersion,
          rulesetVersion: state.rulesetVersion,
          state,
          stateHash: createHash("sha256").update(stateJson).digest("hex"),
          eventHash,
          savedAt: this.#now(),
        });
      },
    });
    this.#actors.set(matchId, actor);
    this.#scheduleState(actor.state);
    return actor;
  }

  #engineCommand(
    state: Readonly<MatchState>,
    deadline: Readonly<SystemDeadline>,
  ): EngineCommand {
    if (deadline.origin === "system-auto") {
      if (deadline.disconnectedAt === undefined) {
        throw new Error("Auto deadline is missing its disconnect generation.");
      }
      return {
        origin: "system-auto",
        commandId: deadline.id,
        matchId: state.matchId,
        expectedVersion: state.version,
        playerId: deadline.playerId,
        disconnectedAt: deadline.disconnectedAt,
        deadlineAt: deadline.deadlineAt,
      };
    }
    return {
      origin: "system-timeout",
      commandId: deadline.id,
      matchId: state.matchId,
      expectedVersion: state.version,
      deadlineAt: deadline.deadlineAt,
      targetId: deadline.targetId,
    };
  }

  #scheduleState(state: Readonly<MatchState>): void {
    const previous = this.#scheduledByMatch.get(state.matchId) ?? new Set();
    const current = new Set<string>();
    for (const deadline of collectSystemDeadlines(state)) {
      const scheduleId = `${state.matchId}\0${deadline.id}`;
      current.add(scheduleId);
      this.#scheduler.schedule({
        id: scheduleId,
        deadlineAt: deadline.deadlineAt,
        command: this.#engineCommand(state, deadline),
      });
    }
    for (const scheduleId of previous) {
      if (!current.has(scheduleId)) this.#scheduler.cancel(scheduleId);
    }
    this.#scheduledByMatch.set(state.matchId, current);
  }

  async #dispatch(command: EngineCommand): Promise<ServerMessage> {
    const identity = commandIdentity(command);
    const actor = this.#actor(identity.matchId);
    let attempted = command;
    let response = await actor.dispatch(attempted);
    while (
      attempted.origin !== "player" &&
      response.type === "command-rejected" &&
      response.reason === "stale-version"
    ) {
      attempted = { ...attempted, expectedVersion: actor.state.version };
      response = await actor.dispatch(attempted);
    }
    this.#scheduleState(actor.state);
    if (response.type === "command-accepted" && !response.duplicate) {
      await this.#onChanged(identity.matchId);
    }
    return response;
  }

  view(
    matchId: MatchId,
    playerId: PlayerId,
  ): {
    readonly version: number;
    readonly view: unknown;
  } {
    const state = this.#actor(matchId).state;
    return { version: state.version, view: createPlayerView(state, playerId) };
  }

  async handleCommand(envelope: CommandEnvelope): Promise<ServerMessage> {
    return this.#dispatch({
      origin: "player",
      envelope,
      serverReceivedAt: this.#now(),
    });
  }

  async setPresence(
    matchId: MatchId,
    playerId: PlayerId,
    status: "connected" | "disconnected",
    occurredAt = this.#now(),
  ): Promise<ServerMessage> {
    const state = this.#actor(matchId).state;
    return this.#dispatch({
      origin: "system-presence",
      commandId: `presence:${status}:${playerId}:${occurredAt}`,
      matchId,
      expectedVersion: state.version,
      playerId,
      status,
      occurredAt,
    });
  }

  async activate(presence: Readonly<MatchPresence>): Promise<void> {
    this.#actor(presence.matchId);
    for (const player of presence.players) {
      const current = this.#actor(presence.matchId).state.connections[
        player.playerId
      ];
      const desiredStatus = player.connected ? "connected" : "disconnected";
      const occurredAt = player.connected
        ? this.#now()
        : (player.disconnectedAt ?? this.#now());
      const alreadySynchronized = player.connected
        ? current?.status === "connected"
        : current?.status !== "connected" &&
          current?.disconnectedAt === occurredAt;
      if (!alreadySynchronized) {
        await this.setPresence(
          presence.matchId,
          player.playerId,
          desiredStatus,
          occurredAt,
        );
      }
    }
    this.#scheduleState(this.#actor(presence.matchId).state);
  }

  async close(): Promise<void> {
    this.#scheduler.close();
    this.#scheduledByMatch.clear();
    await Promise.all([...this.#actors.values()].map((actor) => actor.stop()));
    this.#actors.clear();
    this.#store.close();
  }
}
