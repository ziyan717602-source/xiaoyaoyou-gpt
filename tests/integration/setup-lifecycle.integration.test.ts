import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { PlayerView } from "@xiaoyaoyou/engine";
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

describe("M02 six-player setup over the real network", () => {
  it("survives restart and preserves idempotency, privacy, teams, hands, and first player", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-setup-integration-"));
    roots.push(root);
    const databasePath = join(root, "setup.sqlite");
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
      version += 1;
      for (const client of clients) await waitForVersion(client, version);
    }

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
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
      version: 2,
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
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });
});
