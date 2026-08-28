import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SETUP_MONSTER_IDS,
  SETUP_NPC_IDS,
  type PlayerView,
} from "@xiaoyaoyou/engine";
import type {
  ClientCommand,
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
import { startFetchableServer } from "../helpers/fetchable-server.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function start(
  path: string,
  matchSeed?: string,
): Promise<{
  server: RoomAppServer;
  httpUrl: string;
  wsUrl: string;
}> {
  const { server, httpUrl } = await startFetchableServer(() =>
    buildRoomServer({
      databasePath: path,
      logger: false,
      allowedOrigins: ["https://game.local"],
      ...(matchSeed === undefined ? {} : { matchSeed }),
    }),
  );
  return {
    server,
    httpUrl,
    wsUrl: httpUrl.replace("http", "ws") + "/ws",
  };
}

async function request<T>(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: T }> {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

interface SetupClient {
  readonly socket: WebSocket;
  latestView: PlayerView;
  waitFor: (
    predicate: (message: ServerMessage) => boolean,
  ) => Promise<ServerMessage>;
}

function connect(wsUrl: string, session: RoomSession): Promise<SetupClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { origin: "https://game.local" });
    const waiters = new Set<{
      predicate: (message: ServerMessage) => boolean;
      resolve: (message: ServerMessage) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();
    const client: SetupClient = {
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
              rejectMessage(new Error("setup websocket message timeout"));
            }, 5_000),
          };
          waiters.add(waiter);
        }),
    };
    const connectTimer = setTimeout(
      () => reject(new Error("setup websocket connection timeout")),
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
            clientInstanceId: `setup-${session.playerId}`,
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
  client: SetupClient,
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
  client: SetupClient,
  version: number,
): Promise<void> {
  if (client.latestView.version >= version) return;
  await client.waitFor(
    (message) => message.type === "player-view" && message.version >= version,
  );
}

describe("M02/M03 six-player setup and first turn over the real network", () => {
  it("survives restarts and preserves setup, turn, idempotency, and privacy", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-setup-integration-"));
    roots.push(root);
    const databasePath = join(root, "setup.sqlite");
    let running = await start(databasePath, "jn50402-net-19");
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
          commandId: `setup-ready-${index}`,
          expectedVersion: room.version,
          ready: true,
        },
        session.reconnectToken,
      );
      room = ready.body.room;
    }
    const started = await request<{ room: RoomView }>(
      `${running.httpUrl}/api/rooms/${room.roomId}/start`,
      "POST",
      {
        playerId: created.body.playerId,
        commandId: "setup-start",
        expectedVersion: room.version,
      },
      created.body.reconnectToken,
    );
    expect(started.body.room.matchId).toBe(started.body.room.roomId);

    let clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    const initialViews = clients.map((client) => client.latestView);
    expect(initialViews.every((view) => view.phase === "setup")).toBe(true);
    for (const [viewerIndex, view] of initialViews.entries()) {
      expect(view.encounter).toEqual({
        deckCount: 30,
        discardPile: [],
        lastInspection: null,
      });
      for (const hiddenId of [...SETUP_MONSTER_IDS, ...SETUP_NPC_IDS]) {
        expect(JSON.stringify(view)).not.toContain(hiddenId);
      }
      expect(view.setup?.ownOffer?.candidateHeroIds).toHaveLength(3);
      for (const [otherIndex, otherView] of initialViews.entries()) {
        if (viewerIndex === otherIndex) continue;
        for (const privateHero of otherView.setup!.ownOffer!.candidateHeroIds) {
          expect(JSON.stringify(view)).not.toContain(privateHero);
        }
      }
    }

    let version = initialViews[0]!.version;
    const firstPlayer = initialViews[0]!.players.find(
      (player) => player.turnIndex === 0,
    )!;
    const firstIndex = sessions.findIndex(
      (session) => session.playerId === firstPlayer.id,
    );
    const reroll = await sendCommand(
      clients[firstIndex]!,
      sessions[firstIndex]!,
      "network-reroll",
      version,
      { type: "reroll-hero" },
    );
    expect(reroll).toMatchObject({
      type: "command-accepted",
      duplicate: false,
    });
    version += 1;
    for (const client of clients) await waitForVersion(client, version);

    const selectedCommandIds: string[] = [];
    const selectedHeroIds: string[] = [];
    const selectedReceiptVersions: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const heroId =
        clients[index]!.latestView.setup!.ownOffer!.candidateHeroIds[0]!;
      const commandId = `network-choose-${index}`;
      selectedCommandIds.push(commandId);
      selectedHeroIds.push(heroId);
      const response = await sendCommand(
        clients[index]!,
        sessions[index]!,
        commandId,
        version,
        { type: "choose-hero", heroId },
      );
      expect(response.type).toBe("command-accepted");
      if (response.type === "command-accepted") {
        selectedReceiptVersions.push(response.version);
      }
      version += 1;
      for (const client of clients) await waitForVersion(client, version);
    }

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath, "jn50402-net-19");
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    expect(clients[0]!.latestView.version).toBe(version);
    expect(
      clients
        .slice(0, 3)
        .every((client) => client.latestView.availableActions.length === 0),
    ).toBe(true);

    const duplicate = await sendCommand(
      clients[0]!,
      sessions[0]!,
      selectedCommandIds[0]!,
      version,
      { type: "choose-hero", heroId: selectedHeroIds[0]! },
    );
    expect(duplicate).toMatchObject({
      type: "command-accepted",
      duplicate: true,
      version: selectedReceiptVersions[0],
    });
    const changedDuplicate = await sendCommand(
      clients[0]!,
      sessions[0]!,
      selectedCommandIds[0]!,
      version,
      { type: "choose-hero", heroId: "xyy.hero.not-the-original-command" },
    );
    expect(changedDuplicate).toMatchObject({
      type: "command-rejected",
      reason: "invalid",
    });
    const reusedByAnotherSeat = await sendCommand(
      clients[1]!,
      sessions[1]!,
      selectedCommandIds[0]!,
      version,
      { type: "reroll-hero" },
    );
    expect(reusedByAnotherSeat).toMatchObject({
      type: "command-rejected",
      reason: "forbidden",
    });

    for (let index = 3; index < 6; index += 1) {
      const heroId =
        clients[index]!.latestView.setup!.ownOffer!.candidateHeroIds[0]!;
      const response = await sendCommand(
        clients[index]!,
        sessions[index]!,
        `network-choose-${index}`,
        version,
        { type: "choose-hero", heroId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      for (const client of clients) await waitForVersion(client, version);
    }

    for (const [viewerIndex, client] of clients.entries()) {
      const view = client.latestView;
      expect(view.phase).toBe("playing");
      expect(view.activePlayerId).toBe(firstPlayer.id);
      expect(view.players.filter((player) => player.team === 1)).toHaveLength(
        3,
      );
      expect(view.players.filter((player) => player.team === 2)).toHaveLength(
        3,
      );
      expect(view.players.every((player) => player.heroId !== null)).toBe(true);
      expect(
        view.players.find(
          (player) => player.id === sessions[viewerIndex]!.playerId,
        )?.hand,
      ).toHaveLength(3);
      expect(
        view.players
          .filter((player) => player.id !== sessions[viewerIndex]!.playerId)
          .every((player) => player.hand === null && player.handCount === 3),
      ).toBe(true);
    }

    const endAction = await sendCommand(
      clients[firstIndex]!,
      sessions[firstIndex]!,
      "network-end-action",
      version,
      { type: "end-action" },
    );
    expect(endAction).toMatchObject({
      type: "command-accepted",
      duplicate: false,
      version: version + 1,
    });
    version += 1;
    for (const client of clients) await waitForVersion(client, version);
    expect(clients[firstIndex]!.latestView.turn).toMatchObject({
      number: 1,
      phase: "discard",
    });
    expect(clients[firstIndex]!.latestView.availableActions).toEqual([
      {
        type: "discard-cards",
        count: 1,
        cardInstanceIds: clients[firstIndex]!.latestView.players.find(
          (player) => player.id === firstPlayer.id,
        )!.hand,
      },
    ]);
    expect(
      clients
        .filter((_, index) => index !== firstIndex)
        .every((client) => client.latestView.availableActions.length === 0),
    ).toBe(true);

    const discardCard = clients[firstIndex]!.latestView.players.find(
      (player) => player.id === firstPlayer.id,
    )!.hand![0]!;
    const discard = await sendCommand(
      clients[firstIndex]!,
      sessions[firstIndex]!,
      "network-discard",
      version,
      { type: "discard-cards", cardInstanceIds: [discardCard] },
    );
    expect(discard).toMatchObject({
      type: "command-accepted",
      duplicate: false,
      version: version + 1,
    });
    version += 1;
    for (const client of clients) await waitForVersion(client, version);
    const secondPlayer = clients[0]!.latestView.players.find(
      (player) => player.turnIndex === 1,
    )!;
    expect(secondPlayer).toMatchObject({
      heroId: "xyy.hero.xj404",
      handLimit: 5,
      handCount: 3,
    });
    expect(
      clients.every(
        (client) => client.latestView.activePlayerId === secondPlayer.id,
      ),
    ).toBe(true);
    expect(
      clients.every((client) => client.latestView.turn?.number === 2),
    ).toBe(true);
    expect(
      clients.every((client) => client.latestView.turn?.phase === "action"),
    ).toBe(true);
    const endActionReceiptVersion = version - 1;

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath, "jn50402-net-19");
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = Math.max(...clients.map((client) => client.latestView.version));
    for (const client of clients) await waitForVersion(client, version);
    expect(
      clients.every((client) => client.latestView.version === version),
    ).toBe(true);
    expect(
      clients.every(
        (client) =>
          client.latestView.encounter.deckCount === 30 &&
          client.latestView.encounter.discardPile.length === 0,
      ),
    ).toBe(true);
    for (const client of clients) {
      for (const hiddenId of [...SETUP_MONSTER_IDS, ...SETUP_NPC_IDS]) {
        expect(JSON.stringify(client.latestView)).not.toContain(hiddenId);
      }
    }
    expect(
      clients.every(
        (client) => client.latestView.activePlayerId === secondPlayer.id,
      ),
    ).toBe(true);
    const duplicateEnd = await sendCommand(
      clients[firstIndex]!,
      sessions[firstIndex]!,
      "network-end-action",
      version,
      { type: "end-action" },
    );
    expect(duplicateEnd).toMatchObject({
      type: "command-accepted",
      duplicate: true,
      version: endActionReceiptVersion,
    });
    expect(
      clients.every(
        (client) =>
          client.latestView.players.find(
            (player) => player.id === secondPlayer.id,
          )?.handLimit === 5,
      ),
    ).toBe(true);

    const secondIndex = sessions.findIndex(
      (session) => session.playerId === secondPlayer.id,
    );
    const secondEnd = await sendCommand(
      clients[secondIndex]!,
      sessions[secondIndex]!,
      "network-jn50402-end-action",
      version,
      { type: "end-action" },
    );
    expect(secondEnd).toMatchObject({
      type: "command-accepted",
      duplicate: false,
      version: version + 1,
    });
    version += 1;
    for (const client of clients) await waitForVersion(client, version);
    expect(
      clients.every(
        (client) => client.latestView.activePlayerId !== secondPlayer.id,
      ),
    ).toBe(true);
    expect(
      clients.every((client) => client.latestView.turn?.number === 3),
    ).toBe(true);
    expect(
      clients.every((client) => client.latestView.turn?.phase === "action"),
    ).toBe(true);
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });
});
