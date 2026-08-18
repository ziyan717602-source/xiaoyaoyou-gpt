import { createHash } from "node:crypto";
import {
  applyCommand,
  createPlayerView,
  reduceEvent,
  type MatchState,
} from "@xiaoyaoyou/engine";
import type {
  CommandEnvelope,
  CommandRejectionReason,
  ErrorCategory,
  MatchId,
  PlayerId,
  ServerMessage,
} from "@xiaoyaoyou/protocol";
import { MatchActor } from "./match-actor.js";
import { SqliteEventStore } from "./persistence.js";

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

function commandHash(envelope: CommandEnvelope): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        matchId: envelope.matchId,
        playerId: envelope.playerId,
        command: envelope.command,
      }),
    )
    .digest("hex");
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
    MatchActor<MatchState, CommandEnvelope, ActorResult>
  >();
  readonly #onChanged: (matchId: MatchId) => Promise<void> | void;

  constructor(
    databasePath: string,
    onChanged: (matchId: MatchId) => Promise<void> | void,
  ) {
    this.#store = new SqliteEventStore(databasePath);
    this.#onChanged = onChanged;
  }

  #recover(matchId: MatchId): MatchState {
    const recovery = this.#store.recover<MatchState>(matchId);
    let state = recovery.snapshot.state;
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

  #actor(
    matchId: MatchId,
  ): MatchActor<MatchState, CommandEnvelope, ActorResult> {
    const existing = this.#actors.get(matchId);
    if (existing !== undefined) return existing;
    const actor = new MatchActor<MatchState, CommandEnvelope, ActorResult>({
      initialState: this.#recover(matchId),
      process: async (state, envelope) => {
        const duplicate = this.#store.getReceipt(matchId, envelope.commandId);
        if (duplicate !== null) {
          if (duplicate.playerId !== envelope.playerId) {
            return {
              state: state as MatchState,
              result: {
                type: "command-rejected",
                commandId: envelope.commandId,
                category: "forbidden",
                reason: "forbidden",
                currentVersion: state.version,
                retryable: false,
              },
            };
          }
          if (duplicate.result.commandHash !== commandHash(envelope)) {
            return {
              state: state as MatchState,
              result: {
                type: "command-rejected",
                commandId: envelope.commandId,
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
              commandId: envelope.commandId,
              version:
                typeof receiptVersion === "number"
                  ? receiptVersion
                  : state.version,
              duplicate: true,
            },
          };
        }
        const applied = applyCommand(state, { origin: "player", envelope });
        if (!applied.accepted) {
          return {
            state: state as MatchState,
            result: {
              type: "command-rejected",
              commandId: envelope.commandId,
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
          commandId: envelope.commandId,
          playerId: envelope.playerId,
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
            commandHash: commandHash(envelope),
          },
          snapshotReason: "wait-point",
          now: Date.now(),
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
            commandId: envelope.commandId,
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
          savedAt: Date.now(),
        });
      },
    });
    this.#actors.set(matchId, actor);
    return actor;
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
    const response = await this.#actor(envelope.matchId).dispatch(envelope);
    if (response.type === "command-accepted" && !response.duplicate) {
      await this.#onChanged(envelope.matchId);
    }
    return response;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#actors.values()].map((actor) => actor.stop()));
    this.#actors.clear();
    this.#store.close();
  }
}
