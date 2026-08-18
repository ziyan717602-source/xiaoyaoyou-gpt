import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type CommandEnvelope,
  type PlayerId,
  type RoomSession,
  type RoomView,
  type ServerMessage,
} from "@xiaoyaoyou/protocol";
import {
  collectSystemDeadlines,
  type MatchState,
  type PlayerView,
} from "@xiaoyaoyou/engine";
import {
  buildRoomServer,
  type RoomAppServer,
} from "../../apps/server/src/room-server.js";

const require = createRequire(import.meta.url);
const Database =
  require("../../apps/server/node_modules/better-sqlite3") as typeof import("better-sqlite3").default;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Running {
  readonly server: RoomAppServer;
  readonly httpUrl: string;
  readonly wsUrl: string;
}

async function start(databasePath: string): Promise<Running> {
  const server = await buildRoomServer({ databasePath, logger: false });
  const address = await server.listen(0);
  return {
    server,
    httpUrl: address,
    wsUrl: address.replace("http", "ws"),
  };
}

async function request<T>(
  url: string,
  method: string,
  body: unknown,
  token?: string,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${method} ${url} failed: ${response.status}`);
  return (await response.json()) as T;
}

interface Client {
  readonly socket: WebSocket;
  latestView: PlayerView;
  waitFor: (
    predicate: (message: ServerMessage) => boolean,
  ) => Promise<ServerMessage>;
}

function connect(wsUrl: string, session: RoomSession): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsUrl}/ws`);
    const waiters: Array<{
      predicate: (message: ServerMessage) => boolean;
      resolve: (message: ServerMessage) => void;
    }> = [];
    let authenticated = false;
    let client: Client | null = null;
    socket.once("error", reject);
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString()) as ServerMessage;
      if (message.type === "hello") {
        socket.send(
          JSON.stringify({
            type: "authenticate",
            protocolVersion: PROTOCOL_VERSION,
            matchId: session.room.roomId,
            playerId: session.playerId,
            reconnectToken: session.reconnectToken,
            clientInstanceId: `m06-${session.playerId}`,
          }),
        );
      } else if (message.type === "authenticated") {
        authenticated = true;
        if (client !== null) resolve(client);
      } else if (message.type === "player-view") {
        if (client === null) {
          client = {
            socket,
            latestView: message.view as PlayerView,
            waitFor: (predicate) =>
              new Promise((resolveWaiter) =>
                waiters.push({ predicate, resolve: resolveWaiter }),
              ),
          };
          if (authenticated) resolve(client);
        } else {
          client.latestView = message.view as PlayerView;
        }
      }
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index]!;
        if (waiter.predicate(message)) {
          waiters.splice(index, 1);
          waiter.resolve(message);
        }
      }
    });
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for M06 state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function send(
  client: Client,
  session: RoomSession,
  commandId: string,
  command: ClientCommand,
): Promise<ServerMessage> {
  const envelope: CommandEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    matchId: session.room.roomId,
    playerId: session.playerId,
    clientSequence: client.latestView.version + 1,
    expectedVersion: client.latestView.version,
    clientIssuedAt: 0,
    command,
  };
  const response = client.waitFor(
    (message) =>
      (message.type === "command-accepted" ||
        message.type === "command-rejected") &&
      message.commandId === commandId,
  );
  client.socket.send(JSON.stringify({ type: "command", envelope }));
  return response;
}

async function createPlaying(running: Running): Promise<{
  readonly roomId: string;
  readonly sessions: readonly RoomSession[];
  readonly clients: readonly Client[];
}> {
  const created = await request<RoomSession>(
    `${running.httpUrl}/api/rooms`,
    "POST",
    { nickname: "时间房主" },
  );
  const sessions = [created];
  for (let index = 1; index < 6; index += 1) {
    sessions.push(
      await request<RoomSession>(`${running.httpUrl}/api/rooms/join`, "POST", {
        inviteCode: created.room.inviteCode,
        nickname: `时间玩家${index + 1}`,
      }),
    );
  }
  let room = sessions.at(-1)!.room;
  for (const [index, session] of sessions.entries()) {
    const ready = await request<{ room: RoomView }>(
      `${running.httpUrl}/api/rooms/${room.roomId}/ready`,
      "POST",
      {
        playerId: session.playerId,
        commandId: `m06-ready-${index}`,
        expectedVersion: room.version,
        ready: true,
      },
      session.reconnectToken,
    );
    room = ready.room;
  }
  const started = await request<{ room: RoomView }>(
    `${running.httpUrl}/api/rooms/${room.roomId}/start`,
    "POST",
    {
      playerId: created.playerId,
      commandId: "m06-start",
      expectedVersion: room.version,
    },
    created.reconnectToken,
  );
  room = started.room;
  const clients = await Promise.all(
    sessions.map((session) => connect(running.wsUrl, session)),
  );
  for (const [index, client] of clients.entries()) {
    const heroId = client.latestView.setup!.ownOffer!.candidateHeroIds[0]!;
    const response = await send(
      client,
      sessions[index]!,
      `m06-choose-${index}`,
      { type: "choose-hero", heroId },
    );
    expect(response.type).toBe("command-accepted");
    await waitUntil(() =>
      clients.every(
        (candidate) =>
          candidate.latestView.version >=
          (response.type === "command-accepted" ? response.version : 0),
      ),
    );
  }
  expect(clients[0]!.latestView.phase).toBe("playing");
  return { roomId: room.roomId, sessions, clients };
}

function rewriteTurnDeadline(
  databasePath: string,
  matchId: string,
  deadlineAt: number,
) {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string };
    const state = JSON.parse(row.state_json) as MatchState;
    if (state.turn === null)
      throw new Error("Missing turn for M06 restart fixture.");
    const rewritten: MatchState = {
      ...state,
      turn: {
        ...state.turn,
        phase: "action",
        openedAt: deadlineAt - 15_000,
        deadlineAt,
      },
      reactionWindow: null,
      pendingChoice: null,
      dyingBatch: null,
      effectStack: [],
    };
    const stateJson = JSON.stringify(rewritten);
    const stateHash = createHash("sha256").update(stateJson).digest("hex");
    database
      .prepare(
        "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE rowid = ?",
      )
      .run(stateJson, stateHash, row.rowid);
  } finally {
    database.close();
  }
}

function latestSnapshotState(
  databasePath: string,
  matchId: string,
): MatchState {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .prepare(
        `SELECT state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { state_json: string };
    return JSON.parse(row.state_json) as MatchState;
  } finally {
    database.close();
  }
}

function systemTimeoutCount(databasePath: string, matchId: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    return (
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM events
           WHERE match_id = ? AND type = 'system.timeout-resolved'`,
        )
        .get(matchId) as { count: number }
    ).count;
  } finally {
    database.close();
  }
}

describe("M06 time/recovery over six real WebSockets", () => {
  it("enters auto, resolves through the actor, reconnects, and times out once after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-time-integration-"));
    roots.push(root);
    const databasePath = join(root, "time.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let clients = [...created.clients];
    const actor = clients[0]!.latestView.activePlayerId!;
    const actorIndex = created.sessions.findIndex(
      (session) => session.playerId === actor,
    );
    const originalDeadline = clients[0]!.latestView.turn!.deadlineAt;

    clients[actorIndex]!.socket.close();
    await new Promise<void>((resolve) =>
      clients[actorIndex]!.socket.once("close", resolve),
    );
    await waitUntil(() =>
      clients.some(
        (client, index) =>
          index !== actorIndex &&
          client.latestView.players.find((player) => player.id === actor)
            ?.connection.status === "grace",
      ),
    );
    const agedDisconnect = await running.server.matchService.setPresence(
      created.roomId,
      actor,
      "disconnected",
      Date.now() - 60_001,
    );
    expect(agedDisconnect.type).toBe("command-accepted");
    await waitUntil(() =>
      clients.some(
        (client, index) =>
          index !== actorIndex &&
          client.latestView.players.find((player) => player.id === actor)
            ?.connection.status === "auto",
      ),
    );
    expect(
      clients
        .find((_client, index) => index !== actorIndex)!
        .latestView.players.find((player) => player.id === actor)!.connection
        .status,
    ).toBe("auto");
    expect(originalDeadline).toBeGreaterThan(0);
    await waitUntil(() =>
      clients.some(
        (client, index) =>
          index !== actorIndex && client.latestView.activePlayerId !== actor,
      ),
    );

    const reconnected = await connect(
      running.wsUrl,
      created.sessions[actorIndex]!,
    );
    clients[actorIndex] = reconnected;
    expect(
      reconnected.latestView.players.find((player) => player.id === actor)!
        .connection.status,
    ).toBe("connected");
    expect(
      reconnected.latestView.players.find((player) => player.id === actor)!
        .hand,
    ).not.toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    const stoppedState = latestSnapshotState(databasePath, created.roomId);
    const stoppedConnections = Object.values(stoppedState.connections);
    expect(stoppedConnections.map((connection) => connection.status)).toEqual(
      Array.from({ length: 6 }, () => "grace"),
    );
    expect(
      stoppedConnections.every(
        (connection) => connection.disconnectedAt !== null,
      ),
    ).toBe(true);
    expect(
      stoppedConnections.every((connection) => connection.autoAt === null),
    ).toBe(true);
    expect(
      collectSystemDeadlines(stoppedState).filter(
        (deadline) => deadline.origin === "system-auto",
      ),
    ).toHaveLength(6);
    rewriteTurnDeadline(databasePath, created.roomId, Date.now() - 1_000);
    const before = systemTimeoutCount(databasePath, created.roomId);

    running = await start(databasePath);
    clients = await Promise.all(
      created.sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(
      clients.every(
        (client, index) =>
          client.latestView.players.find(
            (player) => player.id === created.sessions[index]!.playerId,
          )?.connection.status === "connected",
      ),
    ).toBe(true);
    await waitUntil(
      () => systemTimeoutCount(databasePath, created.roomId) === before + 1,
    );
    const afterFirstRestart = systemTimeoutCount(databasePath, created.roomId);
    expect(afterFirstRestart).toBe(before + 1);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      created.sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(
      clients.every(
        (client, index) =>
          client.latestView.players.find(
            (player) => player.id === created.sessions[index]!.playerId,
          )?.connection.status === "connected",
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(systemTimeoutCount(databasePath, created.roomId)).toBe(
      afterFirstRestart,
    );

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });
});
