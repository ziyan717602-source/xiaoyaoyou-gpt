import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SETUP_CARD_INSTANCES,
  type MatchState,
  type PlayerView,
} from "@xiaoyaoyou/engine";
import type {
  ClientCommand,
  PlayerId,
  RoomSession,
  RoomView,
  ServerMessage,
} from "@xiaoyaoyou/protocol";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRoomServer,
  type RoomAppServer,
} from "../../apps/server/src/room-server.js";

const require = createRequire(import.meta.url);
const Database =
  require("../../apps/server/node_modules/better-sqlite3") as typeof import("better-sqlite3").default;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function start(path: string): Promise<{
  server: RoomAppServer;
  httpUrl: string;
  wsUrl: string;
}> {
  const server = await buildRoomServer({
    databasePath: path,
    logger: false,
    allowedOrigins: ["https://game.local"],
  });
  await server.listen(0, "127.0.0.1");
  const address = server.app.server.address() as AddressInfo;
  return {
    server,
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
  };
}

async function request<T>(
  url: string,
  method: "POST",
  body: unknown,
  token?: string,
): Promise<{ status: number; body: T }> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

interface ReactionClient {
  readonly socket: WebSocket;
  latestView: PlayerView;
  waitFor: (
    predicate: (message: ServerMessage) => boolean,
  ) => Promise<ServerMessage>;
}

function connect(wsUrl: string, session: RoomSession): Promise<ReactionClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { origin: "https://game.local" });
    const waiters = new Set<{
      predicate: (message: ServerMessage) => boolean;
      resolve: (message: ServerMessage) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();
    const client: ReactionClient = {
      socket,
      latestView: null as unknown as PlayerView,
      waitFor: (predicate) =>
        new Promise((resolveMessage, rejectMessage) => {
          const waiter = {
            predicate,
            resolve: resolveMessage,
            reject: rejectMessage,
            timer: setTimeout(() => {
              waiters.delete(waiter);
              rejectMessage(new Error("reaction websocket message timeout"));
            }, 5_000),
          };
          waiters.add(waiter);
        }),
    };
    const connectTimer = setTimeout(
      () => reject(new Error("reaction websocket connection timeout")),
      5_000,
    );
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "hello") {
        socket.send(
          JSON.stringify({
            type: "authenticate",
            protocolVersion: 1,
            matchId: session.room.roomId,
            playerId: session.playerId,
            reconnectToken: session.reconnectToken,
            clientInstanceId: `reaction-${session.playerId}`,
          }),
        );
      }
      if (message.type === "player-view") {
        client.latestView = message.view as PlayerView;
        if (
          client.latestView.phase === "setup" ||
          client.latestView.phase === "playing"
        ) {
          clearTimeout(connectTimer);
          resolve(client);
        }
      }
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(connectTimer);
      reject(error);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      waiters.clear();
    });
  });
}

async function sendCommand(
  client: ReactionClient,
  session: RoomSession,
  commandId: string,
  expectedVersion: number,
  command: ClientCommand,
): Promise<
  Extract<ServerMessage, { type: "command-accepted" | "command-rejected" }>
> {
  const result = client.waitFor(
    (message) =>
      (message.type === "command-accepted" ||
        message.type === "command-rejected") &&
      message.commandId === commandId,
  );
  client.socket.send(
    JSON.stringify({
      type: "command",
      envelope: {
        protocolVersion: 1,
        commandId,
        matchId: session.room.roomId,
        playerId: session.playerId,
        clientSequence: expectedVersion,
        expectedVersion,
        clientIssuedAt: 1,
        command,
      },
    }),
  );
  return (await result) as Extract<
    ServerMessage,
    { type: "command-accepted" | "command-rejected" }
  >;
}

async function waitForVersion(
  clients: readonly ReactionClient[],
  version: number,
): Promise<void> {
  await Promise.all(
    clients.map(async (client) => {
      if (client.latestView.version >= version) return;
      await client.waitFor(
        (message) =>
          message.type === "player-view" && message.version >= version,
      );
    }),
  );
}

function injectReactionFixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
  first: PlayerId,
  second: PlayerId,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string } | undefined;
    if (row === undefined) throw new Error("Missing playing-state snapshot.");
    const state = JSON.parse(row.state_json) as MatchState;
    const hands: Readonly<Record<PlayerId, readonly string[]>> = {
      [actor]: ["xyy.card.jp04@7"],
      [first]: ["xyy.card.tp02@36"],
      [second]: ["xyy.card.tp01@34"],
    };
    const claimed = new Set(Object.values(hands).flat());
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            heroId: player.id === first ? "xyy.hero.xj202" : player.heroId,
            hand: hands[player.id] ?? [],
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
      effectStack: [],
      reactionWindow: null,
    };
    const stateJson = JSON.stringify(fixture);
    const stateHash = createHash("sha256")
      .update(stateJson, "utf8")
      .digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

function injectJp02Fixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
): MatchState {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        "SELECT rowid, state_json FROM snapshots WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1",
      )
      .get(matchId) as { rowid: number; state_json: string };
    const state = JSON.parse(row.state_json) as MatchState;
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((p) => [
          p.id,
          { ...p, hand: p.id === actor ? ["xyy.card.jp02@3"] : [] },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((id) => id !== "xyy.card.jp02@3"),
      discardPile: [],
    };
    const json = JSON.stringify(fixture);
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(json, createHash("sha256").update(json).digest("hex"), row.rowid);
    return fixture;
  } finally {
    database.close();
  }
}

function injectTp02Fixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
  first: PlayerId,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string } | undefined;
    if (row === undefined) throw new Error("Missing TP02 fixture snapshot.");
    const state = JSON.parse(row.state_json) as MatchState;
    const hands: Readonly<Record<PlayerId, readonly string[]>> = {
      [actor]: ["xyy.card.tp02@36", "xyy.card.tp02@37"],
      [first]: ["xyy.card.tp01@33"],
    };
    const claimed = new Set([
      ...Object.values(hands).flat(),
      "xyy.card.wq02@48",
    ]);
    const now = Date.now();
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            hp: player.id === actor ? player.maxHp - 3 : player.hp,
            hand: hands[player.id] ?? [],
            equipment:
              player.id === actor
                ? { weapon: "xyy.card.wq02@48", armor: null }
                : { weapon: null, armor: null },
          },
        ]),
      ),
      turn:
        state.turn === null
          ? null
          : {
              ...state.turn,
              phase: "action",
              openedAt: now,
              deadlineAt: now + 15_000,
            },
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
      effectStack: [],
      reactionWindow: null,
      pendingChoice: null,
      dyingBatch: null,
    };
    const stateJson = JSON.stringify(fixture);
    const stateHash = createHash("sha256")
      .update(stateJson, "utf8")
      .digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

function injectJp03Fixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string } | undefined;
    if (row === undefined) throw new Error("Missing JP03 fixture snapshot.");
    const state = JSON.parse(row.state_json) as MatchState;
    const cards = ["xyy.card.jp03@5", "xyy.card.jp03@6"] as const;
    const now = Date.now();
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            hp: player.maxHp - 1,
            hand: player.id === actor ? cards : [],
          },
        ]),
      ),
      turn:
        state.turn === null
          ? null
          : {
              ...state.turn,
              phase: "action",
              openedAt: now,
              deadlineAt: now + 15_000,
            },
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !cards.includes(card)),
      discardPile: [],
      effectStack: [],
      reactionWindow: null,
      pendingChoice: null,
      dyingBatch: null,
    };
    const stateJson = JSON.stringify(fixture);
    const stateHash = createHash("sha256")
      .update(stateJson, "utf8")
      .digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

function injectJp01Fixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
  target: PlayerId,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string } | undefined;
    if (row === undefined) throw new Error("Missing JP01 fixture snapshot.");
    const state = JSON.parse(row.state_json) as MatchState;
    const hands: Readonly<Record<PlayerId, readonly string[]>> = {
      [actor]: ["xyy.card.jp01@1"],
      [target]: ["xyy.card.jp04@7", "xyy.card.jp05@10"],
    };
    const claimed = new Set(Object.values(hands).flat());
    const now = Date.now();
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          { ...player, hand: hands[player.id] ?? [] },
        ]),
      ),
      turn:
        state.turn === null
          ? null
          : {
              ...state.turn,
              phase: "action",
              openedAt: now,
              deadlineAt: now + 15_000,
            },
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
      effectStack: [],
      reactionWindow: null,
      pendingChoice: null,
      dyingBatch: null,
    };
    const stateJson = JSON.stringify(fixture);
    const stateHash = createHash("sha256")
      .update(stateJson, "utf8")
      .digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

function injectJp06Fixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
  target: PlayerId,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string } | undefined;
    if (row === undefined) throw new Error("Missing JP06 fixture snapshot.");
    const state = JSON.parse(row.state_json) as MatchState;
    const hands: Readonly<Record<PlayerId, readonly string[]>> = {
      [actor]: ["xyy.card.jp06@13", "xyy.card.jp06@14"],
      [target]: ["xyy.card.jp04@8"],
    };
    const claimed = new Set([
      ...Object.values(hands).flat(),
      "xyy.card.wq01@47",
    ]);
    const now = Date.now();
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            hand: hands[player.id] ?? [],
            equipment:
              player.id === target
                ? { weapon: "xyy.card.wq01@47", armor: null }
                : { weapon: null, armor: null },
          },
        ]),
      ),
      turn:
        state.turn === null
          ? null
          : {
              ...state.turn,
              phase: "action",
              openedAt: now,
              deadlineAt: now + 15_000,
            },
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
      effectStack: [],
      reactionWindow: null,
      pendingChoice: null,
      dyingBatch: null,
    };
    const stateJson = JSON.stringify(fixture);
    const stateHash = createHash("sha256")
      .update(stateJson, "utf8")
      .digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

function injectJn50201Fixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
  target: PlayerId,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string } | undefined;
    if (row === undefined) throw new Error("Missing JN50201 fixture snapshot.");
    const state = JSON.parse(row.state_json) as MatchState;
    const claimed = new Set([
      "xyy.card.zp01@16",
      "xyy.card.jp04@7",
      "xyy.card.fj03@54",
    ]);
    const now = Date.now();
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            heroId: player.id === actor ? "xyy.hero.xj402" : player.heroId,
            hand:
              player.id === actor
                ? ["xyy.card.zp01@16"]
                : player.id === target
                  ? ["xyy.card.jp04@7"]
                  : [],
            equipment:
              player.id === target
                ? { weapon: null, armor: "xyy.card.fj03@54" }
                : { weapon: null, armor: null },
          },
        ]),
      ),
      turn:
        state.turn === null
          ? null
          : {
              ...state.turn,
              phase: "action",
              openedAt: now,
              deadlineAt: now + 15_000,
              usedSkillIds: [],
            },
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
      effectStack: [],
      reactionWindow: null,
      pendingChoice: null,
      dyingBatch: null,
    };
    const stateJson = JSON.stringify(fixture);
    const stateHash = createHash("sha256")
      .update(stateJson, "utf8")
      .digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

function injectJn50202Fixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string } | undefined;
    if (row === undefined) throw new Error("Missing JN50202 fixture snapshot.");
    const state = JSON.parse(row.state_json) as MatchState;
    const originalCard = "xyy.card.jp01@1";
    const now = Date.now();
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            heroId: player.id === actor ? "xyy.hero.xj402" : player.heroId,
            hand: player.id === actor ? [originalCard] : [],
            equipment: { weapon: null, armor: null },
          },
        ]),
      ),
      turn:
        state.turn === null
          ? null
          : {
              ...state.turn,
              phase: "action",
              openedAt: now,
              deadlineAt: now + 15_000,
              usedSkillIds: [],
            },
      drawPile: SETUP_CARD_INSTANCES.filter((card) => card !== originalCard),
      discardPile: [],
      effectStack: [],
      reactionWindow: null,
      pendingChoice: null,
      dyingBatch: null,
    };
    const stateJson = JSON.stringify(fixture);
    const stateHash = createHash("sha256")
      .update(stateJson, "utf8")
      .digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

function injectTp03Fixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
  target: PlayerId,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string } | undefined;
    if (row === undefined) throw new Error("Missing TP03 fixture snapshot.");
    const state = JSON.parse(row.state_json) as MatchState;
    const hands: Readonly<Record<PlayerId, readonly string[]>> = {
      [actor]: ["xyy.card.jp05@10"],
      [target]: ["xyy.card.tp03@39"],
    };
    const claimed = new Set(Object.values(hands).flat());
    const now = Date.now();
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            hp: player.id === target ? 2 : player.hp,
            hand: hands[player.id] ?? [],
          },
        ]),
      ),
      turn:
        state.turn === null
          ? null
          : {
              ...state.turn,
              phase: "action",
              openedAt: now,
              deadlineAt: now + 15_000,
            },
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
      effectStack: [],
      reactionWindow: null,
      pendingChoice: null,
      dyingBatch: null,
    };
    const stateJson = JSON.stringify(fixture);
    const stateHash = createHash("sha256")
      .update(stateJson, "utf8")
      .digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

function injectWq04Fixture(
  databasePath: string,
  matchId: string,
  actor: PlayerId,
): void {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string } | undefined;
    if (row === undefined) throw new Error("Missing WQ04 fixture snapshot.");
    const state = JSON.parse(row.state_json) as MatchState;
    const now = Date.now();
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            hand: [],
            equipment:
              player.id === actor
                ? { weapon: "xyy.card.wq04@50", armor: null }
                : { weapon: null, armor: null },
          },
        ]),
      ),
      turn:
        state.turn === null
          ? null
          : {
              ...state.turn,
              phase: "action",
              openedAt: now,
              deadlineAt: now + 15_000,
            },
      drawPile: SETUP_CARD_INSTANCES.filter(
        (card) => card !== "xyy.card.wq04@50",
      ),
      discardPile: [],
      effectStack: [],
      reactionWindow: null,
      pendingChoice: null,
      dyingBatch: null,
    };
    const stateJson = JSON.stringify(fixture);
    const stateHash = createHash("sha256")
      .update(stateJson, "utf8")
      .digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

describe("M04 reaction lifecycle over six real WebSockets", () => {
  it("JP02 privately inspects over six sockets, restarts the same choice and applies a duplicate swap only once", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jp02-integration-"));
    roots.push(root);
    const path = join(root, "inspection.sqlite");
    let running: Awaited<ReturnType<typeof start>> | undefined;
    let clients: ReactionClient[] = [];
    try {
      running = await start(path);
      const created = await request<RoomSession>(
        `${running.httpUrl}/api/rooms`,
        "POST",
        { nickname: "JP02 owner" },
      );
      expect(created.status).toBe(201);
      const sessions = [created.body];
      for (let i = 1; i < 6; i++)
        sessions.push(
          (
            await request<RoomSession>(
              `${running.httpUrl}/api/rooms/join`,
              "POST",
              {
                inviteCode: created.body.room.inviteCode,
                nickname: `JP02 ${i}`,
              },
            )
          ).body,
        );
      let room = sessions.at(-1)!.room;
      for (const [i, session] of sessions.entries()) {
        const ready = await request<{ room: RoomView }>(
          `${running.httpUrl}/api/rooms/${room.roomId}/ready`,
          "POST",
          {
            playerId: session.playerId,
            commandId: `jp02-ready-${i}`,
            expectedVersion: room.version,
            ready: true,
          },
          session.reconnectToken,
        );
        expect(ready.status).toBe(200);
        room = ready.body.room;
      }
      const started = await request(
        `${running.httpUrl}/api/rooms/${room.roomId}/start`,
        "POST",
        {
          playerId: created.body.playerId,
          commandId: "jp02-start",
          expectedVersion: room.version,
        },
        created.body.reconnectToken,
      );
      expect(started.status).toBe(200);
      const reconnect = async () => {
        clients = await Promise.all(
          sessions.map((session) => connect(running!.wsUrl, session)),
        );
        // Authentication queues presence events; wait for all six projections at the actual server head.
        await waitForVersion(
          clients,
          running!.server.matchService.view(room.roomId, sessions[0]!.playerId)
            .version,
        );
      };
      await reconnect();
      const send = async (
        playerId: PlayerId,
        id: string,
        command: ClientCommand,
        version = clients[0]!.latestView.version,
      ) => {
        const index = sessions.findIndex((s) => s.playerId === playerId);
        const response = await sendCommand(
          clients[index]!,
          sessions[index]!,
          id,
          version,
          command,
        );
        if (response.type === "command-accepted")
          await waitForVersion(clients, response.version);
        return response;
      };
      for (const [i, session] of sessions.entries()) {
        expect(
          (
            await send(session.playerId, `jp02-hero-${i}`, {
              type: "choose-hero",
              heroId:
                clients[i]!.latestView.setup!.ownOffer!.candidateHeroIds[0]!,
            })
          ).type,
        ).toBe("command-accepted");
      }
      const actor = clients[0]!.latestView.activePlayerId!;
      const actorIndex = sessions.findIndex((s) => s.playerId === actor);
      await running.server.closeGracefully();
      running = undefined;
      const fixture = injectJp02Fixture(path, room.roomId, actor);
      running = await start(path);
      await reconnect();
      expect(
        (
          await send(actor, "network-jp02-play", {
            type: "play-card",
            cardInstanceId: "xyy.card.jp02@3",
            targetPlayerIds: [actor],
          })
        ).type,
      ).toBe("command-accepted");
      for (const client of clients)
        expect(client.latestView.encounter.lastInspection).toBeNull();
      let guard = 0;
      while (clients[0]!.latestView.reactionWindow !== null) {
        if (++guard > 6) throw new Error("JP02 response failed to terminate");
        const w = clients[0]!.latestView.reactionWindow!;
        expect(
          (
            await send(w.priorityPlayerId!, `jp02-pass-${guard}`, {
              type: "pass-reaction",
              windowId: w.windowId,
            })
          ).type,
        ).toBe("command-accepted");
      }
      const assertPrivate = () => {
        for (const [i, client] of clients.entries()) {
          if (i === actorIndex) {
            expect(client.latestView.encounter.lastInspection?.cardIds).toEqual(
              fixture.encounterDeck.slice(0, 2),
            );
          } else {
            expect(client.latestView.encounter.lastInspection).toBeNull();
            expect(client.latestView.pendingChoice).toBeNull();
            for (const id of fixture.encounterDeck)
              expect(JSON.stringify(client.latestView)).not.toContain(id);
          }
        }
      };
      assertPrivate();
      const pending = clients[actorIndex]!.latestView.pendingChoice!;
      expect(pending.deadlineAt - pending.openedAt).toBe(15_000);
      const choose: ClientCommand = {
        type: "submit-choice",
        choiceId: pending.choiceId,
        selections: ["swap-top-two"],
      };
      const intruder = sessions.find((s) => s.playerId !== actor)!;
      expect(
        (await send(intruder.playerId, "network-jp02-forbidden", choose)).type,
      ).toBe("command-rejected");
      await running.server.closeGracefully();
      running = undefined;
      running = await start(path);
      await reconnect();
      expect(clients[actorIndex]!.latestView.pendingChoice).toEqual(pending);
      assertPrivate();
      const beforeSwap = clients[0]!.latestView.version;
      const first = await send(actor, "network-jp02-swap", choose);
      expect(first).toMatchObject({
        type: "command-accepted",
        duplicate: false,
      });
      expect(
        await send(actor, "network-jp02-swap", choose, beforeSwap),
      ).toMatchObject({ type: "command-accepted", duplicate: true });
      expect(
        await send(actor, "network-jp02-stale-choice", choose),
      ).toMatchObject({ type: "command-rejected" });
      expect(clients[actorIndex]!.latestView.pendingChoice).toBeNull();
      assertPrivate();
      await running.server.closeGracefully();
      running = undefined;
      const database = new Database(path, { readonly: true });
      try {
        const row = database
          .prepare(
            "SELECT state_json FROM snapshots WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1",
          )
          .get(room.roomId) as { state_json: string };
        const persisted = JSON.parse(row.state_json) as MatchState;
        expect(persisted.encounterDeck).toEqual([
          fixture.encounterDeck[1],
          fixture.encounterDeck[0],
          ...fixture.encounterDeck.slice(2),
        ]);
        expect(persisted.rng).toEqual(fixture.rng);
        expect(persisted.discardPile).toEqual(["xyy.card.jp02@3"]);
      } finally {
        database.close();
      }
    } finally {
      if (running !== undefined) await running.server.closeGracefully();
      for (const client of clients) client.socket.terminate();
    }
  });

  it("persists a child window across restart and completes a counter-chain", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "xiaoyaoyou-reaction-integration-"),
    );
    roots.push(root);
    const databasePath = join(root, "reaction.sqlite");
    let running = await start(databasePath);
    const created = await request<RoomSession>(
      `${running.httpUrl}/api/rooms`,
      "POST",
      { nickname: "房主" },
    );
    const sessions = [created.body];
    for (let index = 1; index < 6; index += 1) {
      const joined = await request<RoomSession>(
        `${running.httpUrl}/api/rooms/join`,
        "POST",
        {
          inviteCode: created.body.room.inviteCode,
          nickname: `玩家 ${index + 1}`,
        },
      );
      sessions.push(joined.body);
    }
    let room = sessions.at(-1)!.room;
    for (const [index, session] of sessions.entries()) {
      const ready = await request<{ room: RoomView }>(
        `${running.httpUrl}/api/rooms/${room.roomId}/ready`,
        "POST",
        {
          playerId: session.playerId,
          commandId: `reaction-ready-${index}`,
          expectedVersion: room.version,
          ready: true,
        },
        session.reconnectToken,
      );
      room = ready.body.room;
    }
    await request<{ room: RoomView }>(
      `${running.httpUrl}/api/rooms/${room.roomId}/start`,
      "POST",
      {
        playerId: created.body.playerId,
        commandId: "reaction-start",
        expectedVersion: room.version,
      },
      created.body.reconnectToken,
    );

    let clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    let version = clients[0]!.latestView.version;
    for (const [index, client] of clients.entries()) {
      const heroId = client.latestView.setup!.ownOffer!.candidateHeroIds[0]!;
      const response = await sendCommand(
        client,
        sessions[index]!,
        `reaction-choose-${index}`,
        version,
        { type: "choose-hero", heroId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
    }
    const actor = clients[0]!.latestView.activePlayerId!;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const actorIndex = ordered.findIndex((player) => player.id === actor);
    const first = ordered[(actorIndex + 1) % ordered.length]!.id;
    const second = ordered[(actorIndex + 2) % ordered.length]!.id;
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    injectReactionFixture(databasePath, room.roomId, actor, first, second);

    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const clientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    const sessionByPlayer = new Map(
      sessions.map((session) => [session.playerId, session]),
    );
    expect(
      clientByPlayer
        .get(actor)!
        .latestView.players.find((player) => player.id === actor)!.hand,
    ).toEqual(["xyy.card.jp04@7"]);
    expect(
      clientByPlayer
        .get(first)!
        .latestView.players.find((player) => player.id === first)!.hand,
    ).toEqual(["xyy.card.tp02@36"]);

    const original = await sendCommand(
      clientByPlayer.get(actor)!,
      sessionByPlayer.get(actor)!,
      "network-play-original",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp04@7",
        targetPlayerIds: [actor],
      },
    );
    expect(original).toMatchObject({
      type: "command-accepted",
      duplicate: false,
      version: version + 1,
    });
    version += 1;
    await waitForVersion(clients, version);
    const originalEffectId = clients[0]!.latestView.effectStack[0]!.effectId;
    expect(clientByPlayer.get(first)!.latestView.availableActions).toEqual([
      {
        type: "play-skill-converted-reaction-card",
        cardInstanceId: "xyy.card.tp02@36",
        skillId: "xyy.skill.jn20202",
        targetEffectId: originalEffectId,
      },
      {
        type: "pass-reaction",
        windowId: clients[0]!.latestView.reactionWindow!.windowId,
      },
    ]);
    expect(
      clients
        .filter((client) => client !== clientByPlayer.get(first))
        .every((client) => client.latestView.availableActions.length === 0),
    ).toBe(true);

    const firstReactionVersion = version;
    const firstReaction = await sendCommand(
      clientByPlayer.get(first)!,
      sessionByPlayer.get(first)!,
      "network-first-bingxin",
      version,
      {
        type: "play-skill-converted-reaction-card",
        cardInstanceId: "xyy.card.tp02@36",
        skillId: "xyy.skill.jn20202",
        targetEffectId: originalEffectId,
      },
    );
    expect(firstReaction.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    const persistedWindow = JSON.parse(
      JSON.stringify(clients[0]!.latestView.reactionWindow),
    ) as PlayerView["reactionWindow"];
    const firstBingxinId = clients[0]!.latestView.effectStack.at(-1)!.effectId;

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    for (const client of clients) {
      expect(client.latestView.reactionWindow).toEqual(persistedWindow);
      expect(client.latestView.version).toBe(version);
    }
    const restartedClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    const duplicate = await sendCommand(
      restartedClientByPlayer.get(first)!,
      sessionByPlayer.get(first)!,
      "network-first-bingxin",
      version,
      {
        type: "play-skill-converted-reaction-card",
        cardInstanceId: "xyy.card.tp02@36",
        skillId: "xyy.skill.jn20202",
        targetEffectId: originalEffectId,
      },
    );
    expect(duplicate).toMatchObject({
      type: "command-accepted",
      duplicate: true,
      version: firstReactionVersion + 1,
    });

    const secondReaction = await sendCommand(
      restartedClientByPlayer.get(second)!,
      sessionByPlayer.get(second)!,
      "network-second-bingxin",
      version,
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@34",
        targetEffectId: firstBingxinId,
      },
    );
    expect(secondReaction.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);

    let passSequence = 0;
    while (clients[0]!.latestView.reactionWindow !== null) {
      const window = clients[0]!.latestView.reactionWindow!;
      const priority = window.priorityPlayerId;
      const priorityClient = restartedClientByPlayer.get(priority)!;
      expect(
        priorityClient.latestView.availableActions.some(
          (action) => action.type === "pass-reaction",
        ),
      ).toBe(true);
      expect(
        clients
          .filter((client) => client !== priorityClient)
          .every((client) => client.latestView.availableActions.length === 0),
      ).toBe(true);
      const response = await sendCommand(
        priorityClient,
        sessionByPlayer.get(priority)!,
        `network-reaction-pass-${passSequence}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      passSequence += 1;
      if (passSequence > 12)
        throw new Error("Network reaction did not converge.");
    }

    expect(clients[0]!.latestView.effectStack).toEqual([]);
    expect(
      restartedClientByPlayer
        .get(actor)!
        .latestView.players.find((player) => player.id === actor)!.hand,
    ).toHaveLength(2);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    injectTp02Fixture(databasePath, room.roomId, actor, first);
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const tp02ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    const actorClient = tp02ClientByPlayer.get(actor)!;
    expect(actorClient.latestView.availableActions).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.tp02@36",
      targetPlayerIds: [actor],
    });
    expect(
      clients
        .filter((client) => client !== actorClient)
        .every(
          (client) =>
            !JSON.stringify(client.latestView).includes("xyy.card.tp02@36"),
        ),
    ).toBe(true);
    const hpBefore = actorClient.latestView.players.find(
      (player) => player.id === actor,
    )!.hp;

    const cancelledHeal = await sendCommand(
      actorClient,
      sessionByPlayer.get(actor)!,
      "network-tp02-cancelled",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.tp02@36",
        targetPlayerIds: [actor],
      },
    );
    expect(cancelledHeal.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    const tp02EffectId = clients[0]!.latestView.effectStack[0]!.effectId;
    const cancel = await sendCommand(
      tp02ClientByPlayer.get(first)!,
      sessionByPlayer.get(first)!,
      "network-tp02-bingxin",
      version,
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: tp02EffectId,
      },
    );
    expect(cancel.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    let tp02Pass = 0;
    while (clients[0]!.latestView.reactionWindow !== null) {
      const window = clients[0]!.latestView.reactionWindow!;
      const response = await sendCommand(
        tp02ClientByPlayer.get(window.priorityPlayerId)!,
        sessionByPlayer.get(window.priorityPlayerId)!,
        `network-tp02-cancel-pass-${tp02Pass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      tp02Pass += 1;
      if (tp02Pass > 6) throw new Error("TP02 cancellation did not close.");
    }
    expect(
      actorClient.latestView.players.find((player) => player.id === actor)!.hp,
    ).toBe(hpBefore);

    const successfulHeal = await sendCommand(
      actorClient,
      sessionByPlayer.get(actor)!,
      "network-tp02-heal",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.tp02@37",
        targetPlayerIds: [actor],
      },
    );
    expect(successfulHeal.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    tp02Pass = 0;
    while (clients[0]!.latestView.reactionWindow !== null) {
      const window = clients[0]!.latestView.reactionWindow!;
      const response = await sendCommand(
        tp02ClientByPlayer.get(window.priorityPlayerId)!,
        sessionByPlayer.get(window.priorityPlayerId)!,
        `network-tp02-heal-pass-${tp02Pass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      tp02Pass += 1;
      if (tp02Pass > 6) throw new Error("TP02 healing did not close.");
    }
    const actorAfterHeal = actorClient.latestView.players.find(
      (player) => player.id === actor,
    )!;
    expect(actorAfterHeal.hp).toBe(actorAfterHeal.maxHp);
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    injectJp03Fixture(databasePath, room.roomId, actor);
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const jp03ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    const jp03Actor = jp03ClientByPlayer.get(actor)!;
    const actorTeam = jp03Actor.latestView.players.find(
      (player) => player.id === actor,
    )!.team;
    const allies = jp03Actor.latestView.players
      .filter((player) => player.alive && player.team === actorTeam)
      .sort((left, right) => left.seat - right.seat)
      .map((player) => player.id);
    expect(jp03Actor.latestView.availableActions).toEqual(
      expect.arrayContaining([
        {
          type: "play-card",
          cardInstanceId: "xyy.card.jp03@5",
          targetPlayerIds: allies,
          mode: "primary",
        },
        {
          type: "play-card",
          cardInstanceId: "xyy.card.jp03@6",
          targetPlayerIds: [],
          mode: "pawn",
        },
      ]),
    );
    expect(
      clients
        .filter((client) => client !== jp03Actor)
        .every(
          (client) =>
            !JSON.stringify(client.latestView).includes("xyy.card.jp03@5") &&
            !JSON.stringify(client.latestView).includes("xyy.card.jp03@6"),
        ),
    ).toBe(true);

    const teamHeal = await sendCommand(
      jp03Actor,
      sessionByPlayer.get(actor)!,
      "network-jp03-team-heal",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp03@5",
        targetPlayerIds: allies,
        mode: "primary",
      },
    );
    expect(teamHeal.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    let jp03Pass = 0;
    while (clients[0]!.latestView.reactionWindow !== null) {
      const window = clients[0]!.latestView.reactionWindow!;
      const response = await sendCommand(
        jp03ClientByPlayer.get(window.priorityPlayerId)!,
        sessionByPlayer.get(window.priorityPlayerId)!,
        `network-jp03-pass-${jp03Pass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      jp03Pass += 1;
      if (jp03Pass > 6) throw new Error("JP03 team healing did not close.");
    }
    for (const player of jp03Actor.latestView.players) {
      expect(player.hp).toBe(
        allies.includes(player.id) ? player.maxHp : player.maxHp - 1,
      );
    }

    const handBeforePawn = jp03Actor.latestView.players.find(
      (player) => player.id === actor,
    )!.hand;
    const pawned = await sendCommand(
      jp03Actor,
      sessionByPlayer.get(actor)!,
      "network-jp03-pawn",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp03@6",
        targetPlayerIds: [],
        mode: "pawn",
      },
    );
    expect(pawned.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    expect(jp03Actor.latestView.reactionWindow).toBeNull();
    const handAfterPawn = jp03Actor.latestView.players.find(
      (player) => player.id === actor,
    )!.hand;
    expect(handAfterPawn).toHaveLength(handBeforePawn.length);
    expect(handAfterPawn).not.toContain("xyy.card.jp03@6");
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    injectJp01Fixture(databasePath, room.roomId, actor, first);
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    let jp01ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    let jp01Actor = jp01ClientByPlayer.get(actor)!;
    expect(jp01Actor.latestView.availableActions).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.jp01@1",
      targetPlayerIds: [first],
    });
    expect(JSON.stringify(jp01Actor.latestView)).not.toContain(
      "xyy.card.jp04@7",
    );
    expect(JSON.stringify(jp01Actor.latestView)).not.toContain(
      "xyy.card.jp05@10",
    );
    const steal = await sendCommand(
      jp01Actor,
      sessionByPlayer.get(actor)!,
      "network-jp01-play",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp01@1",
        targetPlayerIds: [first],
      },
    );
    expect(steal.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    let jp01Pass = 0;
    while (clients[0]!.latestView.reactionWindow !== null) {
      const window = clients[0]!.latestView.reactionWindow!;
      const response = await sendCommand(
        jp01ClientByPlayer.get(window.priorityPlayerId)!,
        sessionByPlayer.get(window.priorityPlayerId)!,
        `network-jp01-pass-${jp01Pass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      jp01Pass += 1;
      if (jp01Pass > 6) throw new Error("JP01 response did not close.");
    }
    const persistedChoice = JSON.parse(
      JSON.stringify(jp01Actor.latestView.pendingChoice),
    ) as PlayerView["pendingChoice"];
    expect(persistedChoice?.optionIds).toEqual([
      "opaque-hand-slot-1",
      "opaque-hand-slot-2",
    ]);
    expect(jp01Actor.latestView.availableActions).toEqual([
      {
        type: "submit-choice",
        choiceId: persistedChoice!.choiceId,
        optionIds: ["opaque-hand-slot-1", "opaque-hand-slot-2"],
        minSelections: 1,
        maxSelections: 1,
      },
    ]);
    expect(JSON.stringify(jp01Actor.latestView)).not.toContain(
      "xyy.card.jp04@7",
    );
    expect(JSON.stringify(jp01Actor.latestView)).not.toContain(
      "xyy.card.jp05@10",
    );
    for (const [playerId, client] of jp01ClientByPlayer) {
      if (playerId !== actor)
        expect(client.latestView.pendingChoice).toBeNull();
    }

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    jp01ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    jp01Actor = jp01ClientByPlayer.get(actor)!;
    expect(jp01Actor.latestView.pendingChoice).toEqual(persistedChoice);
    const selected = await sendCommand(
      jp01Actor,
      sessionByPlayer.get(actor)!,
      "network-jp01-select",
      version,
      {
        type: "submit-choice",
        choiceId: persistedChoice!.choiceId,
        selections: ["opaque-hand-slot-2"],
      },
    );
    expect(selected.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    expect(jp01Actor.latestView.pendingChoice).toBeNull();
    expect(
      jp01Actor.latestView.players.find((player) => player.id === actor)!.hand,
    ).toEqual(["xyy.card.jp05@10"]);
    expect(
      jp01ClientByPlayer
        .get(first)!
        .latestView.players.find((player) => player.id === first)!.hand,
    ).toEqual(["xyy.card.jp04@7"]);
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    injectJp06Fixture(databasePath, room.roomId, actor, first);
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const jp06ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    const jp06Actor = jp06ClientByPlayer.get(actor)!;
    const jp06Action = jp06Actor.latestView.availableActions.find(
      (action) =>
        action.type === "play-card" &&
        action.cardInstanceId === "xyy.card.jp06@13",
    );
    expect(jp06Action).toMatchObject({
      type: "play-card",
      targetPlayerIds: expect.arrayContaining([actor, first]),
    });
    expect(JSON.stringify(jp06Actor.latestView)).not.toContain(
      "xyy.card.jp04@8",
    );
    expect(JSON.stringify(jp06Actor.latestView)).toContain("xyy.card.wq01@47");

    const discardEquipment = await sendCommand(
      jp06Actor,
      sessionByPlayer.get(actor)!,
      "network-jp06-equipment-play",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp06@13",
        targetPlayerIds: [first],
      },
    );
    expect(discardEquipment.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    let jp06Pass = 0;
    while (clients[0]!.latestView.reactionWindow !== null) {
      const window = clients[0]!.latestView.reactionWindow!;
      const response = await sendCommand(
        jp06ClientByPlayer.get(window.priorityPlayerId)!,
        sessionByPlayer.get(window.priorityPlayerId)!,
        `network-jp06-equipment-pass-${jp06Pass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      jp06Pass += 1;
      if (jp06Pass > 6)
        throw new Error("JP06 equipment response did not close.");
    }
    expect(jp06Actor.latestView.pendingChoice?.optionIds).toEqual([
      "opaque-hand-slot-1",
      "equipment:weapon",
    ]);
    const equipmentSelected = await sendCommand(
      jp06Actor,
      sessionByPlayer.get(actor)!,
      "network-jp06-equipment-select",
      version,
      {
        type: "submit-choice",
        choiceId: jp06Actor.latestView.pendingChoice!.choiceId,
        selections: ["equipment:weapon"],
      },
    );
    expect(equipmentSelected.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    expect(
      jp06Actor.latestView.players.find((player) => player.id === first)!
        .equipment.weapon,
    ).toBeNull();

    const discardHand = await sendCommand(
      jp06Actor,
      sessionByPlayer.get(actor)!,
      "network-jp06-hand-play",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp06@14",
        targetPlayerIds: [first],
      },
    );
    expect(discardHand.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    jp06Pass = 0;
    while (clients[0]!.latestView.reactionWindow !== null) {
      const window = clients[0]!.latestView.reactionWindow!;
      const response = await sendCommand(
        jp06ClientByPlayer.get(window.priorityPlayerId)!,
        sessionByPlayer.get(window.priorityPlayerId)!,
        `network-jp06-hand-pass-${jp06Pass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      jp06Pass += 1;
      if (jp06Pass > 6) throw new Error("JP06 hand response did not close.");
    }
    expect(jp06Actor.latestView.pendingChoice?.optionIds).toEqual([
      "opaque-hand-slot-1",
    ]);
    expect(JSON.stringify(jp06Actor.latestView)).not.toContain(
      "xyy.card.jp04@8",
    );
    const handSelected = await sendCommand(
      jp06Actor,
      sessionByPlayer.get(actor)!,
      "network-jp06-hand-select",
      version,
      {
        type: "submit-choice",
        choiceId: jp06Actor.latestView.pendingChoice!.choiceId,
        selections: ["opaque-hand-slot-1"],
      },
    );
    expect(handSelected.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    expect(
      jp06Actor.latestView.players.find((player) => player.id === first)!
        .handCount,
    ).toBe(0);
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    injectTp03Fixture(databasePath, room.roomId, actor, first);
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    let tp03ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    const tp03Actor = tp03ClientByPlayer.get(actor)!;
    expect(tp03Actor.latestView.availableActions).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.jp05@10",
      targetPlayerIds: expect.arrayContaining([first]),
    });
    const jp05 = await sendCommand(
      tp03Actor,
      sessionByPlayer.get(actor)!,
      "network-tp03-jp05",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [first],
      },
    );
    expect(jp05.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    let tp03Pass = 0;
    while (clients[0]!.latestView.effectStack.at(-1)?.kind !== "damage-batch") {
      const window = clients[0]!.latestView.reactionWindow!;
      const priority = window.priorityPlayerId!;
      const response = await sendCommand(
        tp03ClientByPlayer.get(priority)!,
        sessionByPlayer.get(priority)!,
        `network-tp03-original-pass-${tp03Pass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      tp03Pass += 1;
      if (tp03Pass > 6) throw new Error("TP03 original window did not close.");
    }
    const damageWindow = JSON.parse(
      JSON.stringify(clients[0]!.latestView.reactionWindow),
    ) as PlayerView["reactionWindow"];
    const damageEffectId = clients[0]!.latestView.effectStack.at(-1)!.effectId;
    expect(damageWindow?.priorityPlayerId).toBe(first);
    expect(tp03ClientByPlayer.get(first)!.latestView.availableActions).toEqual([
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp03@39",
        targetEffectId: damageEffectId,
      },
      { type: "pass-reaction", windowId: damageWindow!.windowId },
    ]);
    expect(
      clients
        .filter((client) => client !== tp03ClientByPlayer.get(first))
        .every((client) => client.latestView.availableActions.length === 0),
    ).toBe(true);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    tp03ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    version = clients[0]!.latestView.version;
    for (const client of clients) {
      expect(client.latestView.reactionWindow).toEqual(damageWindow);
      expect(client.latestView.version).toBe(version);
    }
    const prevention = await sendCommand(
      tp03ClientByPlayer.get(first)!,
      sessionByPlayer.get(first)!,
      "network-tp03-prevent",
      version,
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp03@39",
        targetEffectId: damageEffectId,
      },
    );
    expect(prevention.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    tp03Pass = 0;
    while (clients[0]!.latestView.reactionWindow !== null) {
      const window = clients[0]!.latestView.reactionWindow!;
      const priority = window.priorityPlayerId!;
      const response = await sendCommand(
        tp03ClientByPlayer.get(priority)!,
        sessionByPlayer.get(priority)!,
        `network-tp03-child-pass-${tp03Pass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      tp03Pass += 1;
      if (tp03Pass > 6) throw new Error("TP03 child window did not close.");
    }
    expect(
      tp03ClientByPlayer
        .get(first)!
        .latestView.players.find((player) => player.id === first),
    ).toMatchObject({ hp: 2, alive: true, handCount: 0 });
    expect(tp03ClientByPlayer.get(first)!.latestView.dyingBatch).toBeNull();
    expect(tp03ClientByPlayer.get(first)!.latestView.effectStack).toEqual([]);
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    injectWq04Fixture(databasePath, room.roomId, actor);
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const wq04ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    const wq04Actor = wq04ClientByPlayer.get(actor)!;
    expect(wq04Actor.latestView.availableActions).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.wq04@50",
      targetPlayerIds: [],
      mode: "pawn",
    });
    expect(
      clients
        .filter((client) => client !== wq04Actor)
        .every((client) => client.latestView.availableActions.length === 0),
    ).toBe(true);
    const pawn = await sendCommand(
      wq04Actor,
      sessionByPlayer.get(actor)!,
      "network-wq04-equipped-pawn",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.wq04@50",
        targetPlayerIds: [],
        mode: "pawn",
      },
    );
    expect(pawn.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    expect(
      wq04Actor.latestView.players.find((player) => player.id === actor),
    ).toMatchObject({
      handCount: 2,
      equipment: { weapon: null, armor: null },
    });
    expect(wq04Actor.latestView.reactionWindow).toBeNull();
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = Math.max(...clients.map((client) => client.latestView.version));
    await waitForVersion(clients, version);
    const restartedWq04Actor =
      clients[sessions.findIndex((session) => session.playerId === actor)]!;
    expect(
      restartedWq04Actor.latestView.players.find(
        (player) => player.id === actor,
      ),
    ).toMatchObject({
      handCount: 2,
      equipment: { weapon: null, armor: null },
    });
    expect(restartedWq04Actor.latestView.reactionWindow).toBeNull();
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    injectJn50201Fixture(databasePath, room.roomId, actor, first);
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    let jn50201ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    let jn50201Actor = jn50201ClientByPlayer.get(actor)!;
    expect(jn50201Actor.latestView.availableActions).toContainEqual({
      type: "play-skill-converted-card",
      cardInstanceIds: ["xyy.card.zp01@16"],
      requiredCardCount: 1,
      skillId: "xyy.skill.jn50201",
      convertedCardId: "xyy.card.jp06",
      targetPlayerIds: [first],
    });
    expect(
      clients
        .filter((client) => client !== jn50201Actor)
        .every(
          (client) =>
            client.latestView.availableActions.length === 0 &&
            !JSON.stringify(client.latestView).includes("xyy.card.zp01@16"),
        ),
    ).toBe(true);
    const converted = await sendCommand(
      jn50201Actor,
      sessionByPlayer.get(actor)!,
      "network-jn50201-convert-jp06",
      version,
      {
        type: "play-skill-converted-card",
        cardInstanceIds: ["xyy.card.zp01@16"],
        skillId: "xyy.skill.jn50201",
        convertedCardId: "xyy.card.jp06",
        targetPlayerIds: [first],
      },
    );
    expect(converted.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    expect(jn50201Actor.latestView.turn?.usedSkillIds).toEqual([
      "xyy.skill.jn50201",
    ]);
    const jn50201Window = JSON.parse(
      JSON.stringify(clients[0]!.latestView.reactionWindow),
    ) as PlayerView["reactionWindow"];
    expect(jn50201Window).not.toBeNull();
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    jn50201ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    expect(clients[0]!.latestView.reactionWindow).toEqual(jn50201Window);
    let jn50201Pass = 0;
    while (clients[0]!.latestView.reactionWindow !== null) {
      const window = clients[0]!.latestView.reactionWindow!;
      const priority = window.priorityPlayerId;
      const priorityClient = jn50201ClientByPlayer.get(priority)!;
      expect(
        clients
          .filter((client) => client !== priorityClient)
          .every((client) => client.latestView.availableActions.length === 0),
      ).toBe(true);
      const passed = await sendCommand(
        priorityClient,
        sessionByPlayer.get(priority)!,
        `network-jn50201-pass-${jn50201Pass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(passed.type).toBe("command-accepted");
      version += 1;
      await waitForVersion(clients, version);
      jn50201Pass += 1;
      if (jn50201Pass > 6) throw new Error("JN50201 window did not close.");
    }
    jn50201Actor = jn50201ClientByPlayer.get(actor)!;
    expect(jn50201Actor.latestView.pendingChoice).toMatchObject({
      playerIds: [actor],
      optionIds: ["opaque-hand-slot-1", "equipment:armor"],
      fallback: "deterministic-random",
    });
    for (const [playerId, client] of jn50201ClientByPlayer) {
      if (playerId !== actor) {
        expect(client.latestView.pendingChoice).toBeNull();
        expect(client.latestView.availableActions).toEqual([]);
      }
    }
    const persistedJn50201Choice = JSON.parse(
      JSON.stringify(jn50201Actor.latestView.pendingChoice),
    ) as PlayerView["pendingChoice"];
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    jn50201ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    jn50201Actor = jn50201ClientByPlayer.get(actor)!;
    expect(jn50201Actor.latestView.pendingChoice).toEqual(
      persistedJn50201Choice,
    );
    const resolvedJn50201 = await sendCommand(
      jn50201Actor,
      sessionByPlayer.get(actor)!,
      "network-jn50201-discard-armor",
      version,
      {
        type: "submit-choice",
        choiceId: jn50201Actor.latestView.pendingChoice!.choiceId,
        selections: ["equipment:armor"],
      },
    );
    expect(resolvedJn50201.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    expect(
      jn50201Actor.latestView.players.find((player) => player.id === first),
    ).toMatchObject({
      handCount: 1,
      equipment: { weapon: null, armor: null },
    });
    expect(jn50201Actor.latestView.pendingChoice).toBeNull();
    expect(
      jn50201Actor.latestView.availableActions.some(
        (action) =>
          action.type === "play-skill-converted-card" &&
          action.skillId === "xyy.skill.jn50201",
      ),
    ).toBe(false);
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = Math.max(...clients.map((client) => client.latestView.version));
    await waitForVersion(clients, version);
    jn50201Actor =
      clients[sessions.findIndex((session) => session.playerId === actor)]!;
    expect(
      jn50201Actor.latestView.players.find((player) => player.id === first),
    ).toMatchObject({
      handCount: 1,
      equipment: { weapon: null, armor: null },
    });
    expect(jn50201Actor.latestView.turn?.usedSkillIds).toEqual([
      "xyy.skill.jn50201",
    ]);
    expect(jn50201Actor.latestView.pendingChoice).toBeNull();
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    injectJn50202Fixture(databasePath, room.roomId, actor);
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    let jn50202ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    let jn50202Actor = jn50202ClientByPlayer.get(actor)!;
    expect(jn50202Actor.latestView.availableActions).toContainEqual({
      type: "activate-hero-skill",
      cardInstanceIds: [],
      requiredCardCount: 0,
      skillId: "xyy.skill.jn50202",
      targetPlayerIds: [],
      requiredTargetCount: 0,
    });
    const activatedJn50202 = await sendCommand(
      jn50202Actor,
      sessionByPlayer.get(actor)!,
      "network-jn50202-activate",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: [],
        skillId: "xyy.skill.jn50202",
        targetPlayerIds: [],
      },
    );
    expect(activatedJn50202.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    const actorHand = jn50202Actor.latestView.players.find(
      (player) => player.id === actor,
    )!.hand!;
    expect(actorHand).toHaveLength(2);
    expect(jn50202Actor.latestView.reactionWindow).toBeNull();
    expect(jn50202Actor.latestView.pendingChoice).toMatchObject({
      playerIds: [actor],
      prompt: "jn50202-discard-one",
      optionIds: actorHand,
      fallback: "deterministic-random",
    });
    for (const [playerId, client] of jn50202ClientByPlayer) {
      if (playerId === actor) continue;
      expect(client.latestView.pendingChoice).toBeNull();
      expect(client.latestView.availableActions).toEqual([]);
      expect(JSON.stringify(client.latestView)).not.toContain(actorHand[0]!);
      expect(JSON.stringify(client.latestView)).not.toContain(actorHand[1]!);
    }
    const persistedJn50202Choice = JSON.parse(
      JSON.stringify(jn50202Actor.latestView.pendingChoice),
    ) as PlayerView["pendingChoice"];
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    jn50202ClientByPlayer = new Map(
      sessions.map((session, index) => [session.playerId, clients[index]!]),
    );
    jn50202Actor = jn50202ClientByPlayer.get(actor)!;
    expect(jn50202Actor.latestView.pendingChoice).toEqual(
      persistedJn50202Choice,
    );
    const resolvedJn50202 = await sendCommand(
      jn50202Actor,
      sessionByPlayer.get(actor)!,
      "network-jn50202-discard",
      version,
      {
        type: "submit-choice",
        choiceId: jn50202Actor.latestView.pendingChoice!.choiceId,
        selections: [actorHand[0]!],
      },
    );
    expect(resolvedJn50202.type).toBe("command-accepted");
    version += 1;
    await waitForVersion(clients, version);
    expect(
      jn50202Actor.latestView.players.find((player) => player.id === actor),
    ).toMatchObject({ handCount: 1 });
    expect(jn50202Actor.latestView.pendingChoice).toBeNull();
    expect(jn50202Actor.latestView.effectStack).toEqual([]);
    expect(jn50202Actor.latestView.turn?.usedSkillIds).toEqual([
      "xyy.skill.jn50202",
    ]);
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();

    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = Math.max(...clients.map((client) => client.latestView.version));
    await waitForVersion(clients, version);
    jn50202Actor =
      clients[sessions.findIndex((session) => session.playerId === actor)]!;
    expect(
      jn50202Actor.latestView.players.find((player) => player.id === actor),
    ).toMatchObject({ handCount: 1 });
    expect(jn50202Actor.latestView.pendingChoice).toBeNull();
    expect(jn50202Actor.latestView.turn?.usedSkillIds).toEqual([
      "xyy.skill.jn50202",
    ]);
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });
});
