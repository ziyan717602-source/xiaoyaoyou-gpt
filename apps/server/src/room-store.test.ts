import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createPlayerView, type MatchState } from "@xiaoyaoyou/engine";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteEventStore } from "./persistence.js";
import { RoomError, SqliteRoomStore } from "./room-store.js";

const temporaryRoots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-room-store-"));
  temporaryRoots.push(root);
  return join(root, "rooms.sqlite");
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("M01 room lifecycle store", () => {
  it("persists exactly six seats, readiness, start, duplicate receipts, and end", () => {
    const path = databasePath();
    const store = new SqliteRoomStore(path, 1);
    const sessions = [store.createRoom(" 房主 ", 2)];
    for (let index = 1; index < 6; index += 1) {
      sessions.push(
        store.joinRoom(
          sessions[0]!.room.inviteCode.toLowerCase(),
          `玩家 ${index + 1}`,
          2 + index,
        ),
      );
    }
    expect(sessions.map((session) => session.seatIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(() =>
      store.joinRoom(sessions[0]!.room.inviteCode, "第七人", 9),
    ).toThrowError(expect.objectContaining({ code: "room-full" }));

    let version = sessions.at(-1)!.room.version;
    expect(() =>
      store.startRoom({
        roomId: sessions[0]!.room.roomId,
        playerId: sessions[0]!.playerId,
        token: sessions[0]!.reconnectToken,
        commandId: "start-too-early",
        expectedVersion: version,
      }),
    ).toThrowError(expect.objectContaining({ code: "not-all-ready" }));
    expect(() =>
      store.endRoom({
        roomId: sessions[0]!.room.roomId,
        playerId: sessions[0]!.playerId,
        token: sessions[0]!.reconnectToken,
        commandId: "end-too-early",
        expectedVersion: version,
      }),
    ).toThrowError(expect.objectContaining({ code: "room-not-started" }));
    for (const [index, session] of sessions.entries()) {
      const result = store.setReady({
        roomId: session.room.roomId,
        playerId: session.playerId,
        token: session.reconnectToken,
        commandId: `ready-${index}`,
        expectedVersion: version,
        ready: true,
        now: 20 + index,
      });
      expect(result.duplicate).toBe(false);
      version = result.room.version;
    }
    expect(version).toBe(12);

    expect(() =>
      store.startRoom({
        roomId: sessions[0]!.room.roomId,
        playerId: sessions[1]!.playerId,
        token: sessions[1]!.reconnectToken,
        commandId: "non-host-start",
        expectedVersion: version,
      }),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));

    const started = store.startRoom({
      roomId: sessions[0]!.room.roomId,
      playerId: sessions[0]!.playerId,
      token: sessions[0]!.reconnectToken,
      commandId: "start",
      expectedVersion: version,
      seed: "room-store-m02-seed",
      now: 30,
    });
    expect(started.room.status).toBe("started");
    expect(started.room.matchId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(started.room.matchId).toBe(started.room.roomId);
    const matchStore = new SqliteEventStore(path);
    const setupState = matchStore.recover<MatchState>(started.room.matchId!)
      .snapshot.state;
    expect(setupState.phase).toBe("setup");
    expect(setupState.turnOrder).toHaveLength(6);
    expect(setupState.setup?.seedCommitment).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      JSON.stringify(createPlayerView(setupState, sessions[0]!.playerId)),
    ).not.toContain("room-store-m02-seed");
    matchStore.close();
    const duplicate = store.startRoom({
      roomId: sessions[0]!.room.roomId,
      playerId: sessions[0]!.playerId,
      token: sessions[0]!.reconnectToken,
      commandId: "start",
      expectedVersion: version,
      now: 31,
    });
    expect(duplicate).toEqual({ duplicate: true, room: started.room });
    expect(() =>
      store.startRoom({
        roomId: sessions[0]!.room.roomId,
        playerId: sessions[0]!.playerId,
        token: sessions[0]!.reconnectToken,
        commandId: "ready-0",
        expectedVersion: started.room.version,
      }),
    ).toThrowError(expect.objectContaining({ code: "command-id-reused" }));
    expect(() =>
      store.joinRoom(sessions[0]!.room.inviteCode, "迟到玩家", 32),
    ).toThrowError(expect.objectContaining({ code: "room-not-open" }));

    const ended = store.endRoom({
      roomId: sessions[0]!.room.roomId,
      playerId: sessions[0]!.playerId,
      token: sessions[0]!.reconnectToken,
      commandId: "end",
      expectedVersion: started.room.version,
      now: 40,
    });
    expect(ended.room.status).toBe("ended");
    store.close();

    const restored = new SqliteRoomStore(path, 50);
    expect(
      restored.privateView(
        sessions[0]!.room.roomId,
        sessions[0]!.playerId,
        sessions[0]!.reconnectToken,
      ).status,
    ).toBe("ended");
    restored.close();
  });

  it("stores only token hashes and rejects wrong tokens and stale versions", () => {
    const path = databasePath();
    const store = new SqliteRoomStore(path, 1);
    const session = store.createRoom("玩家", 2);
    expect(() =>
      store.privateView(session.room.roomId, session.playerId, "x".repeat(43)),
    ).toThrowError(expect.objectContaining({ code: "forbidden" }));
    expect(() =>
      store.setReady({
        roomId: session.room.roomId,
        playerId: session.playerId,
        token: session.reconnectToken,
        commandId: "stale",
        expectedVersion: 0,
        ready: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "stale-version" }));

    const database = new Database(path, { readonly: true });
    const stored = database
      .prepare(
        "SELECT reconnect_token_hash FROM room_seats WHERE player_id = ?",
      )
      .pluck()
      .get(session.playerId) as string;
    expect(stored).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored).not.toContain(session.reconnectToken);
    database.close();
    store.close();
  });

  it("normalizes nicknames and rejects invalid names", () => {
    const store = new SqliteRoomStore(":memory:", 1);
    expect(store.createRoom("  李   逍遥  ", 2).room.seats[0]?.nickname).toBe(
      "李 逍遥",
    );
    expect(() => store.createRoom(" ", 3)).toThrowError(
      expect.objectContaining<Partial<RoomError>>({ code: "invalid-nickname" }),
    );
    store.close();
  });
});
