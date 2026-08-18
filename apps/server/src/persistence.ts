import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type {
  CommandId,
  EventId,
  MatchId,
  PlayerId,
} from "@xiaoyaoyou/protocol";

export const DATABASE_SCHEMA_VERSION = 2 as const;
export const SNAPSHOT_INTERVAL_COMMANDS = 25 as const;

export interface PersistedEvent {
  readonly eventId: EventId;
  readonly sequence: number;
  readonly type: string;
  readonly rulesetVersion: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly causationEventId: EventId | null;
}

export interface CommandReceipt {
  readonly matchId: MatchId;
  readonly commandId: CommandId;
  readonly playerId: PlayerId | "system";
  readonly accepted: boolean;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface SnapshotRecord<State> {
  readonly matchId: MatchId;
  readonly matchVersion: number;
  readonly eventSequence: number;
  readonly persistenceVersion: number;
  readonly rulesetVersion: string;
  readonly state: State;
  readonly stateHash: string;
  readonly eventHash: string;
  readonly savedAt: number;
}

export interface CreatePersistedMatch<State> {
  readonly matchId: MatchId;
  readonly rulesetVersion: string;
  readonly persistenceVersion: number;
  readonly state: State;
  readonly now: number;
}

export interface CommitAcceptedCommand<State> {
  readonly matchId: MatchId;
  readonly commandId: CommandId;
  readonly playerId: PlayerId | "system";
  readonly expectedVersion: number;
  readonly nextVersion: number;
  readonly rulesetVersion: string;
  readonly persistenceVersion: number;
  readonly events: readonly PersistedEvent[];
  readonly state: State;
  readonly result: Readonly<Record<string, unknown>>;
  readonly snapshotReason: "interval" | "wait-point" | "finished" | null;
  readonly now: number;
}

export type CommitResult =
  | { readonly status: "committed"; readonly receipt: CommandReceipt }
  | { readonly status: "duplicate"; readonly receipt: CommandReceipt }
  | { readonly status: "conflict"; readonly currentVersion: number };

export interface RecoveryRecord<State> {
  readonly snapshot: SnapshotRecord<State>;
  readonly events: readonly (PersistedEvent & {
    readonly commandId: CommandId;
    readonly priorHash: string;
    readonly eventHash: string;
  })[];
  readonly currentVersion: number;
  readonly lastEventSequence: number;
}

interface MatchRow {
  version: number;
  last_event_sequence: number;
  ruleset_version: string;
  persistence_version: number;
}

interface ReceiptRow {
  match_id: string;
  command_id: string;
  player_id: string;
  accepted: number;
  result_json: string;
}

interface SnapshotRow {
  match_id: string;
  match_version: number;
  event_sequence: number;
  persistence_version: number;
  ruleset_version: string;
  state_json: string;
  state_hash: string;
  event_hash: string;
  saved_at: number;
}

const migration1 = `
CREATE TABLE matches (
  match_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  ruleset_version TEXT NOT NULL,
  persistence_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE events (
  match_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  command_id TEXT NOT NULL,
  causation_event_id TEXT,
  type TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prior_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, sequence),
  FOREIGN KEY (match_id) REFERENCES matches(match_id)
);
CREATE INDEX events_command_idx ON events(match_id, command_id);
CREATE TABLE command_receipts (
  match_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, command_id),
  FOREIGN KEY (match_id) REFERENCES matches(match_id)
);
CREATE TABLE snapshots (
  match_id TEXT NOT NULL,
  match_version INTEGER NOT NULL,
  event_sequence INTEGER NOT NULL,
  persistence_version INTEGER NOT NULL,
  ruleset_version TEXT NOT NULL,
  state_json TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, event_sequence),
  FOREIGN KEY (match_id) REFERENCES matches(match_id)
);
`;

const migration2 = `
CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  invite_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('open', 'started', 'ended')),
  version INTEGER NOT NULL,
  host_player_id TEXT NOT NULL,
  match_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE TABLE room_seats (
  room_id TEXT NOT NULL,
  seat_index INTEGER NOT NULL CHECK (seat_index >= 0 AND seat_index < 6),
  player_id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  reconnect_token_hash TEXT NOT NULL,
  ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
  connected INTEGER NOT NULL CHECK (connected IN (0, 1)),
  joined_at INTEGER NOT NULL,
  last_connected_at INTEGER,
  disconnected_at INTEGER,
  PRIMARY KEY (room_id, seat_index),
  FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);
CREATE INDEX room_seats_room_idx ON room_seats(room_id);
CREATE TABLE room_commands (
  room_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, command_id),
  FOREIGN KEY (room_id) REFERENCES rooms(room_id) ON DELETE CASCADE
);
`;

export function openSqliteDatabase(filename: string): Database.Database {
  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
  let version = database.pragma("user_version", { simple: true }) as number;
  if (version > DATABASE_SCHEMA_VERSION) {
    database.close();
    throw new Error(
      `Database schema ${version} is newer than supported ${DATABASE_SCHEMA_VERSION}.`,
    );
  }
  if (version === 0) {
    database.transaction(() => {
      database.exec(migration1);
      database.pragma("user_version = 1");
    })();
    version = 1;
  }
  if (version === 1) {
    database.transaction(() => {
      database.exec(migration2);
      database.pragma("user_version = 2");
    })();
  }
  return database;
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function calculateEventHash(input: {
  readonly matchId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly commandId: string;
  readonly causationEventId: string | null;
  readonly type: string;
  readonly rulesetVersion: string;
  readonly payloadJson: string;
  readonly priorHash: string;
}): string {
  return hashText(JSON.stringify(input));
}

function parseReceipt(row: ReceiptRow): CommandReceipt {
  return {
    matchId: row.match_id,
    commandId: row.command_id,
    playerId: row.player_id,
    accepted: row.accepted === 1,
    result: JSON.parse(row.result_json) as Record<string, unknown>,
  };
}

export function insertPersistedMatch<State>(
  database: Database.Database,
  input: CreatePersistedMatch<State>,
  supportedPersistenceVersion = 1,
): void {
  if (input.persistenceVersion !== supportedPersistenceVersion) {
    throw new Error(
      `Unsupported match persistence version ${input.persistenceVersion}.`,
    );
  }
  const stateJson = JSON.stringify(input.state);
  const stateHash = hashText(stateJson);
  database
    .prepare(
      `INSERT INTO matches
       (match_id, version, last_event_sequence, ruleset_version, persistence_version, created_at, updated_at)
       VALUES (?, 0, 0, ?, ?, ?, ?)`,
    )
    .run(
      input.matchId,
      input.rulesetVersion,
      input.persistenceVersion,
      input.now,
      input.now,
    );
  database
    .prepare(
      `INSERT INTO snapshots
      (match_id, match_version, event_sequence, persistence_version, ruleset_version, state_json, state_hash, event_hash, saved_at)
       VALUES (?, 0, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.matchId,
      input.persistenceVersion,
      input.rulesetVersion,
      stateJson,
      stateHash,
      "0".repeat(64),
      input.now,
    );
}

export class SqliteEventStore {
  readonly #database: Database.Database;
  readonly #supportedPersistenceVersion: number;

  constructor(filename: string, supportedPersistenceVersion = 1) {
    this.#supportedPersistenceVersion = supportedPersistenceVersion;
    this.#database = openSqliteDatabase(filename);
  }

  close(): void {
    this.#database.close();
  }

  createMatch<State>(input: CreatePersistedMatch<State>): void {
    this.#database.transaction(() => {
      insertPersistedMatch(
        this.#database,
        input,
        this.#supportedPersistenceVersion,
      );
    })();
  }

  getReceipt(matchId: MatchId, commandId: CommandId): CommandReceipt | null {
    const row = this.#database
      .prepare(
        `SELECT match_id, command_id, player_id, accepted, result_json
         FROM command_receipts WHERE match_id = ? AND command_id = ?`,
      )
      .get(matchId, commandId) as ReceiptRow | undefined;
    return row === undefined ? null : parseReceipt(row);
  }

  commitAccepted<State>(input: CommitAcceptedCommand<State>): CommitResult {
    return this.#database.transaction((): CommitResult => {
      const duplicate = this.getReceipt(input.matchId, input.commandId);
      if (duplicate !== null) {
        return { status: "duplicate", receipt: duplicate };
      }

      const match = this.#database
        .prepare(
          "SELECT version, last_event_sequence, ruleset_version, persistence_version FROM matches WHERE match_id = ?",
        )
        .get(input.matchId) as MatchRow | undefined;
      if (match === undefined) {
        throw new Error(`Unknown match ${input.matchId}.`);
      }
      if (match.persistence_version !== this.#supportedPersistenceVersion) {
        throw new Error(
          `Unsupported match persistence version ${match.persistence_version}; data preserved.`,
        );
      }
      if (match.version !== input.expectedVersion) {
        return { status: "conflict", currentVersion: match.version };
      }
      if (input.nextVersion !== input.expectedVersion + 1) {
        throw new Error(
          "An accepted command must advance match version exactly once.",
        );
      }
      if (input.events.length === 0) {
        throw new Error(
          "An accepted command must append at least one domain event.",
        );
      }
      if (input.persistenceVersion !== this.#supportedPersistenceVersion) {
        throw new Error(
          `Unsupported match persistence version ${input.persistenceVersion}.`,
        );
      }

      let sequence = match.last_event_sequence;
      let priorHash =
        (this.#database
          .prepare(
            "SELECT event_hash FROM events WHERE match_id = ? ORDER BY sequence DESC LIMIT 1",
          )
          .pluck()
          .get(input.matchId) as string | undefined) ?? "0".repeat(64);

      for (const event of input.events) {
        sequence += 1;
        if (event.sequence !== sequence) {
          throw new Error(
            `Expected event sequence ${sequence}, received ${event.sequence}.`,
          );
        }
        if (event.rulesetVersion !== input.rulesetVersion) {
          throw new Error(
            "Event ruleset version differs from the command ruleset.",
          );
        }
        const payloadJson = JSON.stringify(event.payload);
        const eventHash = calculateEventHash({
          matchId: input.matchId,
          sequence,
          eventId: event.eventId,
          commandId: input.commandId,
          causationEventId: event.causationEventId,
          type: event.type,
          rulesetVersion: event.rulesetVersion,
          payloadJson,
          priorHash,
        });
        this.#database
          .prepare(
            `INSERT INTO events
             (match_id, sequence, event_id, command_id, causation_event_id, type, ruleset_version, payload_json, prior_hash, event_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.matchId,
            sequence,
            event.eventId,
            input.commandId,
            event.causationEventId,
            event.type,
            event.rulesetVersion,
            payloadJson,
            priorHash,
            eventHash,
            input.now,
          );
        priorHash = eventHash;
      }

      const receipt: CommandReceipt = {
        matchId: input.matchId,
        commandId: input.commandId,
        playerId: input.playerId,
        accepted: true,
        result: input.result,
      };
      this.#database
        .prepare(
          `INSERT INTO command_receipts
           (match_id, command_id, player_id, accepted, result_json, created_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run(
          input.matchId,
          input.commandId,
          input.playerId,
          JSON.stringify(input.result),
          input.now,
        );
      this.#database
        .prepare(
          `UPDATE matches SET version = ?, last_event_sequence = ?, ruleset_version = ?,
           persistence_version = ?, updated_at = ? WHERE match_id = ?`,
        )
        .run(
          input.nextVersion,
          sequence,
          input.rulesetVersion,
          input.persistenceVersion,
          input.now,
          input.matchId,
        );

      if (input.snapshotReason !== null) {
        const stateJson = JSON.stringify(input.state);
        this.#database
          .prepare(
            `INSERT INTO snapshots
            (match_id, match_version, event_sequence, persistence_version, ruleset_version, state_json, state_hash, event_hash, saved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.matchId,
            input.nextVersion,
            sequence,
            input.persistenceVersion,
            input.rulesetVersion,
            stateJson,
            hashText(stateJson),
            priorHash,
            input.now,
          );
      }
      return { status: "committed", receipt };
    })();
  }

  saveSnapshot<State>(input: SnapshotRecord<State>): void {
    if (input.persistenceVersion !== this.#supportedPersistenceVersion) {
      throw new Error(
        `Unsupported snapshot persistence version ${input.persistenceVersion}.`,
      );
    }
    const stateJson = JSON.stringify(input.state);
    if (hashText(stateJson) !== input.stateHash) {
      throw new Error("Snapshot state hash does not match serialized state.");
    }
    this.#database.transaction(() => {
      const match = this.#database
        .prepare(
          "SELECT version, last_event_sequence, ruleset_version, persistence_version FROM matches WHERE match_id = ?",
        )
        .get(input.matchId) as MatchRow | undefined;
      if (
        match === undefined ||
        match.version !== input.matchVersion ||
        match.last_event_sequence !== input.eventSequence ||
        match.persistence_version !== input.persistenceVersion ||
        match.ruleset_version !== input.rulesetVersion
      ) {
        throw new Error(
          "Snapshot version does not match the committed match head.",
        );
      }
      const committedEventHash =
        input.eventSequence === 0
          ? "0".repeat(64)
          : (this.#database
              .prepare(
                "SELECT event_hash FROM events WHERE match_id = ? AND sequence = ?",
              )
              .pluck()
              .get(input.matchId, input.eventSequence) as string | undefined);
      if (committedEventHash !== input.eventHash) {
        throw new Error(
          "Snapshot event hash does not match the committed event head.",
        );
      }
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO snapshots
           (match_id, match_version, event_sequence, persistence_version, ruleset_version, state_json, state_hash, event_hash, saved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.matchId,
          input.matchVersion,
          input.eventSequence,
          input.persistenceVersion,
          input.rulesetVersion,
          stateJson,
          input.stateHash,
          input.eventHash,
          input.savedAt,
        );
    })();
  }

  recover<State>(matchId: MatchId): RecoveryRecord<State> {
    const match = this.#database
      .prepare(
        "SELECT version, last_event_sequence, ruleset_version, persistence_version FROM matches WHERE match_id = ?",
      )
      .get(matchId) as MatchRow | undefined;
    if (match === undefined) {
      throw new Error(`Unknown match ${matchId}.`);
    }
    if (match.persistence_version !== this.#supportedPersistenceVersion) {
      throw new Error(
        `Unsupported match persistence version ${match.persistence_version}; data preserved.`,
      );
    }
    const snapshotRow = this.#database
      .prepare(
        `SELECT match_id, match_version, event_sequence, persistence_version,
         ruleset_version, state_json, state_hash, event_hash, saved_at
         FROM snapshots WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as SnapshotRow;
    if (snapshotRow.persistence_version !== this.#supportedPersistenceVersion) {
      throw new Error(
        `Unsupported snapshot persistence version ${snapshotRow.persistence_version}; data preserved.`,
      );
    }
    if (
      snapshotRow.match_version > match.version ||
      snapshotRow.event_sequence > match.last_event_sequence
    ) {
      throw new Error(
        `Snapshot is ahead of committed match head for ${matchId}.`,
      );
    }
    if (hashText(snapshotRow.state_json) !== snapshotRow.state_hash) {
      throw new Error(`Snapshot hash mismatch for match ${matchId}.`);
    }
    const committedSnapshotEventHash =
      snapshotRow.event_sequence === 0
        ? "0".repeat(64)
        : (this.#database
            .prepare(
              "SELECT event_hash FROM events WHERE match_id = ? AND sequence = ?",
            )
            .pluck()
            .get(matchId, snapshotRow.event_sequence) as string | undefined);
    if (committedSnapshotEventHash !== snapshotRow.event_hash) {
      throw new Error(`Snapshot event anchor mismatch for match ${matchId}.`);
    }
    const eventRows = this.#database
      .prepare(
        `SELECT sequence, event_id, command_id, causation_event_id, type,
         ruleset_version, payload_json, prior_hash, event_hash
         FROM events WHERE match_id = ? AND sequence > ? ORDER BY sequence`,
      )
      .all(matchId, snapshotRow.event_sequence) as Array<{
      sequence: number;
      event_id: string;
      command_id: string;
      causation_event_id: string | null;
      type: string;
      ruleset_version: string;
      payload_json: string;
      prior_hash: string;
      event_hash: string;
    }>;
    if (
      eventRows.length !==
      match.last_event_sequence - snapshotRow.event_sequence
    ) {
      throw new Error(
        `Event sequence gap after snapshot for match ${matchId}.`,
      );
    }
    let expectedSequence = snapshotRow.event_sequence + 1;
    let expectedPriorHash = snapshotRow.event_hash;
    for (const row of eventRows) {
      if (row.sequence !== expectedSequence) {
        throw new Error(
          `Event sequence gap at ${matchId}:${expectedSequence}.`,
        );
      }
      if (row.prior_hash !== expectedPriorHash) {
        throw new Error(
          `Event hash chain prior mismatch at ${matchId}:${row.sequence}.`,
        );
      }
      const expectedHash = calculateEventHash({
        matchId,
        sequence: row.sequence,
        eventId: row.event_id,
        commandId: row.command_id,
        causationEventId: row.causation_event_id,
        type: row.type,
        rulesetVersion: row.ruleset_version,
        payloadJson: row.payload_json,
        priorHash: row.prior_hash,
      });
      if (row.event_hash !== expectedHash) {
        throw new Error(`Event hash mismatch at ${matchId}:${row.sequence}.`);
      }
      expectedPriorHash = row.event_hash;
      expectedSequence += 1;
    }
    return {
      snapshot: {
        matchId: snapshotRow.match_id,
        matchVersion: snapshotRow.match_version,
        eventSequence: snapshotRow.event_sequence,
        persistenceVersion: snapshotRow.persistence_version,
        rulesetVersion: snapshotRow.ruleset_version,
        state: JSON.parse(snapshotRow.state_json) as State,
        stateHash: snapshotRow.state_hash,
        eventHash: snapshotRow.event_hash,
        savedAt: snapshotRow.saved_at,
      },
      events: eventRows.map((row) => ({
        eventId: row.event_id,
        sequence: row.sequence,
        commandId: row.command_id,
        causationEventId: row.causation_event_id,
        type: row.type,
        rulesetVersion: row.ruleset_version,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        priorHash: row.prior_hash,
        eventHash: row.event_hash,
      })),
      currentVersion: match.version,
      lastEventSequence: match.last_event_sequence,
    };
  }
}
