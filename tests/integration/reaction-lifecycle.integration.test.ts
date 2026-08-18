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
      [first]: ["xyy.card.tp01@33"],
      [second]: ["xyy.card.tp01@34"],
    };
    const claimed = new Set(Object.values(hands).flat());
    const fixture: MatchState = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          { ...player, hand: hands[player.id] ?? [] },
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

describe("M04 reaction lifecycle over six real WebSockets", () => {
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
    ).toEqual(["xyy.card.tp01@33"]);

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
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
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
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
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
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
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
  });
});
