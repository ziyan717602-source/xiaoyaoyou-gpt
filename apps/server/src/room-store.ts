import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type Database from "better-sqlite3";
import { createSetupMatch } from "@xiaoyaoyou/engine";
import type {
  MatchId,
  PlayerId,
  RoomId,
  RoomSession,
  RoomStatus,
  RoomView,
} from "@xiaoyaoyou/protocol";
import { insertPersistedMatch, openSqliteDatabase } from "./persistence.js";

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CAPACITY = 6;
const RULESET_VERSION = "standard-fengmingyushi@1";

export type RoomErrorCode =
  | "invalid-nickname"
  | "room-not-found"
  | "room-full"
  | "room-not-open"
  | "not-seated"
  | "forbidden"
  | "not-all-ready"
  | "room-not-started"
  | "room-ended"
  | "stale-version"
  | "rate-limited"
  | "command-id-reused";

export class RoomError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    readonly statusCode: number,
  ) {
    super(code);
  }
}

interface RoomRow {
  room_id: string;
  invite_code: string;
  status: RoomStatus;
  version: number;
  host_player_id: string;
  match_id: string | null;
}

interface SeatRow {
  room_id: string;
  seat_index: number;
  player_id: string;
  nickname: string;
  reconnect_token_hash: string;
  ready: number;
  connected: number;
  disconnected_at: number | null;
}

export interface PlayerPresence {
  readonly playerId: PlayerId;
  readonly connected: boolean;
  readonly disconnectedAt: number | null;
}

export interface MatchPresence {
  readonly matchId: MatchId;
  readonly players: readonly PlayerPresence[];
}

interface CommandRow {
  player_id: string;
  command_type: string;
  result_json: string;
}

export interface RoomMutationResult {
  readonly duplicate: boolean;
  readonly room: RoomView;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(token: string, expectedHex: string): boolean {
  const actual = Buffer.from(tokenHash(token), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return (
    actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
  );
}

function nickname(value: string): string {
  const normalized = value.trim().replaceAll(/\s+/gu, " ");
  if (normalized.length < 1 || normalized.length > 24) {
    throw new RoomError("invalid-nickname", 400);
  }
  return normalized;
}

function inviteCode(): string {
  return Array.from(
    { length: 8 },
    () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)] ?? "A",
  ).join("");
}

function reconnectToken(): string {
  return randomBytes(32).toString("base64url");
}

export class SqliteRoomStore {
  readonly #database: Database.Database;

  constructor(filename: string, now = Date.now()) {
    this.#database = openSqliteDatabase(filename);
    this.#database.transaction(() => {
      const connectedRoomIds = this.#database
        .prepare("SELECT DISTINCT room_id FROM room_seats WHERE connected = 1")
        .pluck()
        .all() as string[];
      this.#database
        .prepare(
          "UPDATE room_seats SET connected = 0, disconnected_at = ? WHERE connected = 1",
        )
        .run(now);
      const updateRoom = this.#database.prepare(
        "UPDATE rooms SET version = version + 1, updated_at = ? WHERE room_id = ?",
      );
      for (const roomId of connectedRoomIds) updateRoom.run(now, roomId);
    })();
  }

  close(): void {
    this.#database.close();
  }

  #room(roomId: RoomId): RoomRow {
    const row = this.#database
      .prepare(
        `SELECT room_id, invite_code, status, version, host_player_id, match_id
         FROM rooms WHERE room_id = ?`,
      )
      .get(roomId) as RoomRow | undefined;
    if (row === undefined) throw new RoomError("room-not-found", 404);
    return row;
  }

  #seat(roomId: RoomId, playerId: PlayerId): SeatRow {
    const row = this.#database
      .prepare(
        `SELECT room_id, seat_index, player_id, nickname, reconnect_token_hash, ready, connected, disconnected_at
         FROM room_seats WHERE room_id = ? AND player_id = ?`,
      )
      .get(roomId, playerId) as SeatRow | undefined;
    if (row === undefined) throw new RoomError("not-seated", 403);
    return row;
  }

  #authenticate(roomId: RoomId, playerId: PlayerId, token: string): SeatRow {
    const seat = this.#seat(roomId, playerId);
    if (!tokenMatches(token, seat.reconnect_token_hash)) {
      throw new RoomError("forbidden", 403);
    }
    return seat;
  }

  #view(roomId: RoomId): RoomView {
    const room = this.#room(roomId);
    const seats = this.#database
      .prepare(
        `SELECT room_id, seat_index, player_id, nickname, reconnect_token_hash, ready, connected, disconnected_at
         FROM room_seats WHERE room_id = ? ORDER BY seat_index`,
      )
      .all(roomId) as SeatRow[];
    return {
      roomId: room.room_id,
      inviteCode: room.invite_code,
      status: room.status,
      version: room.version,
      matchId: room.match_id,
      seats: seats.map((seat) => ({
        seatIndex: seat.seat_index,
        playerId: seat.player_id,
        nickname: seat.nickname,
        ready: seat.ready === 1,
        connected: seat.connected === 1,
        host: seat.player_id === room.host_player_id,
      })),
    };
  }

  #newInviteCode(): string {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = inviteCode();
      const exists = this.#database
        .prepare("SELECT 1 FROM rooms WHERE invite_code = ?")
        .get(candidate);
      if (exists === undefined) return candidate;
    }
    throw new Error("Unable to allocate a unique invite code.");
  }

  matchPresence(roomId: RoomId): MatchPresence {
    const room = this.#room(roomId);
    if (room.status !== "started" || room.match_id === null) {
      throw new RoomError("room-not-started", 409);
    }
    const players = this.#database
      .prepare(
        `SELECT room_id, seat_index, player_id, nickname, reconnect_token_hash, ready, connected, disconnected_at
         FROM room_seats WHERE room_id = ? ORDER BY seat_index`,
      )
      .all(roomId) as SeatRow[];
    return {
      matchId: room.match_id,
      players: players.map((seat) => ({
        playerId: seat.player_id,
        connected: seat.connected === 1,
        disconnectedAt: seat.disconnected_at,
      })),
    };
  }

  activeMatchPresences(): readonly MatchPresence[] {
    const roomIds = this.#database
      .prepare(
        "SELECT room_id FROM rooms WHERE status = 'started' ORDER BY room_id",
      )
      .pluck()
      .all() as string[];
    return roomIds.map((roomId) => this.matchPresence(roomId));
  }

  createRoom(rawNickname: string, now = Date.now()): RoomSession {
    const displayName = nickname(rawNickname);
    const roomId = randomUUID();
    const playerId = randomUUID();
    const token = reconnectToken();
    const code = this.#newInviteCode();
    return this.#database.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO rooms
           (room_id, invite_code, status, version, host_player_id, match_id, created_at, updated_at)
           VALUES (?, ?, 'open', 1, ?, NULL, ?, ?)`,
        )
        .run(roomId, code, playerId, now, now);
      this.#database
        .prepare(
          `INSERT INTO room_seats
           (room_id, seat_index, player_id, nickname, reconnect_token_hash, ready, connected, joined_at, last_connected_at, disconnected_at)
           VALUES (?, 0, ?, ?, ?, 0, 0, ?, NULL, ?)`,
        )
        .run(roomId, playerId, displayName, tokenHash(token), now, now);
      return {
        room: this.#view(roomId),
        playerId,
        seatIndex: 0,
        reconnectToken: token,
      };
    })();
  }

  joinRoom(
    rawInviteCode: string,
    rawNickname: string,
    now = Date.now(),
  ): RoomSession {
    const displayName = nickname(rawNickname);
    const code = rawInviteCode.trim().toUpperCase();
    const playerId = randomUUID();
    const token = reconnectToken();
    return this.#database.transaction(() => {
      const room = this.#database
        .prepare(
          `SELECT room_id, invite_code, status, version, host_player_id, match_id
           FROM rooms WHERE invite_code = ?`,
        )
        .get(code) as RoomRow | undefined;
      if (room === undefined) throw new RoomError("room-not-found", 404);
      if (room.status !== "open") throw new RoomError("room-not-open", 409);
      const occupied = this.#database
        .prepare(
          "SELECT seat_index FROM room_seats WHERE room_id = ? ORDER BY seat_index",
        )
        .pluck()
        .all(room.room_id) as number[];
      const seatIndex = Array.from(
        { length: ROOM_CAPACITY },
        (_, index) => index,
      ).find((index) => !occupied.includes(index));
      if (seatIndex === undefined) throw new RoomError("room-full", 409);
      this.#database
        .prepare(
          `INSERT INTO room_seats
           (room_id, seat_index, player_id, nickname, reconnect_token_hash, ready, connected, joined_at, last_connected_at, disconnected_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?, NULL, ?)`,
        )
        .run(
          room.room_id,
          seatIndex,
          playerId,
          displayName,
          tokenHash(token),
          now,
          now,
        );
      this.#database
        .prepare(
          "UPDATE rooms SET version = version + 1, updated_at = ? WHERE room_id = ?",
        )
        .run(now, room.room_id);
      return {
        room: this.#view(room.room_id),
        playerId,
        seatIndex,
        reconnectToken: token,
      };
    })();
  }

  authenticate(roomId: RoomId, playerId: PlayerId, token: string): boolean {
    try {
      this.#authenticate(roomId, playerId, token);
      return true;
    } catch (error) {
      if (error instanceof RoomError) return false;
      throw error;
    }
  }

  privateView(roomId: RoomId, playerId: PlayerId, token: string): RoomView {
    this.#authenticate(roomId, playerId, token);
    return this.#view(roomId);
  }

  seatedView(roomId: RoomId, playerId: PlayerId): RoomView {
    this.#seat(roomId, playerId);
    return this.#view(roomId);
  }

  hostPlayerId(roomId: RoomId): PlayerId {
    return this.#room(roomId).host_player_id;
  }

  #duplicate(
    roomId: RoomId,
    playerId: PlayerId,
    commandId: string,
    commandType: string,
  ): RoomMutationResult | null {
    const row = this.#database
      .prepare(
        `SELECT player_id, command_type, result_json FROM room_commands
         WHERE room_id = ? AND command_id = ?`,
      )
      .get(roomId, commandId) as CommandRow | undefined;
    if (row === undefined) return null;
    if (row.player_id !== playerId || row.command_type !== commandType) {
      throw new RoomError("command-id-reused", 409);
    }
    return {
      duplicate: true,
      room: JSON.parse(row.result_json) as RoomView,
    };
  }

  #receipt(
    roomId: RoomId,
    playerId: PlayerId,
    commandId: string,
    commandType: string,
    room: RoomView,
    now: number,
  ): RoomMutationResult {
    this.#database
      .prepare(
        `INSERT INTO room_commands
         (room_id, command_id, player_id, command_type, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(roomId, commandId, playerId, commandType, JSON.stringify(room), now);
    return { duplicate: false, room };
  }

  setReady(input: {
    roomId: RoomId;
    playerId: PlayerId;
    token: string;
    commandId: string;
    expectedVersion: number;
    ready: boolean;
    now?: number;
  }): RoomMutationResult {
    const now = input.now ?? Date.now();
    return this.#database.transaction(() => {
      const duplicate = this.#duplicate(
        input.roomId,
        input.playerId,
        input.commandId,
        "set-ready",
      );
      if (duplicate !== null) return duplicate;
      const seat = this.#authenticate(
        input.roomId,
        input.playerId,
        input.token,
      );
      const room = this.#room(input.roomId);
      if (room.status !== "open") throw new RoomError("room-not-open", 409);
      if (room.version !== input.expectedVersion) {
        throw new RoomError("stale-version", 409);
      }
      if ((seat.ready === 1) !== input.ready) {
        this.#database
          .prepare(
            "UPDATE room_seats SET ready = ? WHERE room_id = ? AND player_id = ?",
          )
          .run(input.ready ? 1 : 0, input.roomId, input.playerId);
        this.#database
          .prepare(
            "UPDATE rooms SET version = version + 1, updated_at = ? WHERE room_id = ?",
          )
          .run(now, input.roomId);
      }
      return this.#receipt(
        input.roomId,
        input.playerId,
        input.commandId,
        "set-ready",
        this.#view(input.roomId),
        now,
      );
    })();
  }

  startRoom(input: {
    roomId: RoomId;
    playerId: PlayerId;
    token: string;
    commandId: string;
    expectedVersion: number;
    seed?: string;
    now?: number;
  }): RoomMutationResult {
    const now = input.now ?? Date.now();
    return this.#database.transaction(() => {
      const duplicate = this.#duplicate(
        input.roomId,
        input.playerId,
        input.commandId,
        "start-room",
      );
      if (duplicate !== null) return duplicate;
      this.#authenticate(input.roomId, input.playerId, input.token);
      const room = this.#room(input.roomId);
      if (room.status !== "open") throw new RoomError("room-not-open", 409);
      if (room.version !== input.expectedVersion) {
        throw new RoomError("stale-version", 409);
      }
      if (room.host_player_id !== input.playerId) {
        throw new RoomError("forbidden", 403);
      }
      const readiness = this.#database
        .prepare(
          "SELECT COUNT(*) AS total, SUM(ready) AS ready FROM room_seats WHERE room_id = ?",
        )
        .get(input.roomId) as { total: number; ready: number };
      if (
        readiness.total !== ROOM_CAPACITY ||
        readiness.ready !== ROOM_CAPACITY
      ) {
        throw new RoomError("not-all-ready", 409);
      }
      const matchId: MatchId = input.roomId;
      const seed = input.seed ?? reconnectToken();
      const setupState = createSetupMatch({
        matchId,
        rulesetVersion: RULESET_VERSION,
        seed,
        openedAt: now,
        players: (
          this.#database
            .prepare(
              "SELECT player_id, nickname FROM room_seats WHERE room_id = ? ORDER BY seat_index",
            )
            .all(input.roomId) as Array<{
            player_id: string;
            nickname: string;
          }>
        ).map((seat) => ({
          id: seat.player_id,
          nickname: seat.nickname,
        })),
      });
      this.#database
        .prepare(
          `UPDATE rooms SET status = 'started', match_id = ?, version = version + 1,
           updated_at = ?, started_at = ? WHERE room_id = ?`,
        )
        .run(matchId, now, now, input.roomId);
      insertPersistedMatch(this.#database, {
        matchId,
        rulesetVersion: RULESET_VERSION,
        persistenceVersion: setupState.persistenceVersion,
        state: setupState,
        now,
      });
      return this.#receipt(
        input.roomId,
        input.playerId,
        input.commandId,
        "start-room",
        this.#view(input.roomId),
        now,
      );
    })();
  }

  endRoom(input: {
    roomId: RoomId;
    playerId: PlayerId;
    token: string;
    commandId: string;
    expectedVersion: number;
    now?: number;
  }): RoomMutationResult {
    const now = input.now ?? Date.now();
    return this.#database.transaction(() => {
      const duplicate = this.#duplicate(
        input.roomId,
        input.playerId,
        input.commandId,
        "end-room",
      );
      if (duplicate !== null) return duplicate;
      this.#authenticate(input.roomId, input.playerId, input.token);
      const room = this.#room(input.roomId);
      if (room.host_player_id !== input.playerId) {
        throw new RoomError("forbidden", 403);
      }
      if (room.status === "ended") throw new RoomError("room-ended", 409);
      if (room.status !== "started") {
        throw new RoomError("room-not-started", 409);
      }
      if (room.version !== input.expectedVersion) {
        throw new RoomError("stale-version", 409);
      }
      this.#database
        .prepare(
          `UPDATE rooms SET status = 'ended', version = version + 1,
           updated_at = ?, ended_at = ? WHERE room_id = ?`,
        )
        .run(now, now, input.roomId);
      return this.#receipt(
        input.roomId,
        input.playerId,
        input.commandId,
        "end-room",
        this.#view(input.roomId),
        now,
      );
    })();
  }

  markConnected(
    roomId: RoomId,
    playerId: PlayerId,
    token: string,
    now = Date.now(),
  ): RoomView {
    return this.#database.transaction(() => {
      const seat = this.#authenticate(roomId, playerId, token);
      if (seat.connected === 0) {
        this.#database
          .prepare(
            `UPDATE room_seats SET connected = 1, last_connected_at = ?, disconnected_at = NULL
             WHERE room_id = ? AND player_id = ?`,
          )
          .run(now, roomId, playerId);
        this.#database
          .prepare(
            "UPDATE rooms SET version = version + 1, updated_at = ? WHERE room_id = ?",
          )
          .run(now, roomId);
      }
      return this.#view(roomId);
    })();
  }

  markDisconnected(
    roomId: RoomId,
    playerId: PlayerId,
    now = Date.now(),
  ): RoomView {
    return this.#database.transaction(() => {
      const seat = this.#seat(roomId, playerId);
      if (seat.connected === 1) {
        this.#database
          .prepare(
            `UPDATE room_seats SET connected = 0, disconnected_at = ?
             WHERE room_id = ? AND player_id = ?`,
          )
          .run(now, roomId, playerId);
        this.#database
          .prepare(
            "UPDATE rooms SET version = version + 1, updated_at = ? WHERE room_id = ?",
          )
          .run(now, roomId);
      }
      return this.#view(roomId);
    })();
  }
}
