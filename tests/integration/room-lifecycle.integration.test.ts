import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
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

async function startRoomServer(path: string): Promise<{
  server: RoomAppServer;
  httpUrl: string;
  wsUrl: string;
}> {
  const { server, httpUrl } = await startFetchableServer(() =>
    buildRoomServer({
      databasePath: path,
      logger: false,
      allowedOrigins: ["https://game.local"],
    }),
  );
  return {
    server,
    httpUrl,
    wsUrl: httpUrl.replace("http", "ws") + "/ws",
  };
}

async function jsonRequest<T>(
  url: string,
  options: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  if (options.token !== undefined) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  const response = await fetch(url, { ...options, headers });
  return { status: response.status, body: (await response.json()) as T };
}

function connect(
  wsUrl: string,
  session: RoomSession,
): Promise<{ socket: WebSocket; view: RoomView }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { origin: "https://game.local" });
    const timer = setTimeout(
      () => reject(new Error("room websocket timeout")),
      5_000,
    );
    let authenticated = false;
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
            clientInstanceId: `integration-${session.playerId}`,
          }),
        );
      } else if (message.type === "authenticated") {
        authenticated = true;
      } else if (message.type === "player-view" && authenticated) {
        clearTimeout(timer);
        resolve({ socket, view: message.view as RoomView });
      }
    });
    socket.on("error", reject);
  });
}

describe("M01 real room lifecycle", () => {
  it("runs six seats through ready, start, reconnect, restart, replacement, and end", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-room-integration-"));
    roots.push(root);
    const databasePath = join(root, "room.sqlite");
    let running = await startRoomServer(databasePath);

    const created = await jsonRequest<RoomSession>(
      `${running.httpUrl}/api/rooms`,
      {
        method: "POST",
        body: JSON.stringify({ nickname: "房主" }),
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.reconnectToken).toHaveLength(43);
    const sessions = [created.body];
    for (let index = 1; index < 6; index += 1) {
      const joined = await jsonRequest<RoomSession>(
        `${running.httpUrl}/api/rooms/join`,
        {
          method: "POST",
          body: JSON.stringify({
            inviteCode: created.body.room.inviteCode,
            nickname: `玩家 ${index + 1}`,
          }),
        },
      );
      expect(joined.status).toBe(201);
      sessions.push(joined.body);
    }

    const connections = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(connections).toHaveLength(6);
    let current = await jsonRequest<RoomView>(
      `${running.httpUrl}/api/rooms/${created.body.room.roomId}?playerId=${created.body.playerId}`,
      { token: created.body.reconnectToken },
    );
    expect(current.body.seats).toHaveLength(6);
    expect(current.body.seats.every((seat) => seat.connected)).toBe(true);

    let firstReadyRequest: {
      playerId: string;
      commandId: string;
      expectedVersion: number;
      ready: boolean;
    } | null = null;
    for (const [index, session] of sessions.entries()) {
      const body = {
        playerId: session.playerId,
        commandId: `network-ready-${index}`,
        expectedVersion: current.body.version,
        ready: true,
      };
      if (index === 0) firstReadyRequest = body;
      const ready = await jsonRequest<{ duplicate: boolean; room: RoomView }>(
        `${running.httpUrl}/api/rooms/${session.room.roomId}/ready`,
        {
          method: "POST",
          token: session.reconnectToken,
          body: JSON.stringify(body),
        },
      );
      expect(ready.status).toBe(200);
      current = { status: 200, body: ready.body.room };
    }

    const duplicateReady = await jsonRequest<{
      duplicate: boolean;
      room: RoomView;
    }>(`${running.httpUrl}/api/rooms/${created.body.room.roomId}/ready`, {
      method: "POST",
      token: created.body.reconnectToken,
      body: JSON.stringify(firstReadyRequest),
    });
    expect(duplicateReady.body.duplicate).toBe(true);

    const started = await jsonRequest<{ duplicate: boolean; room: RoomView }>(
      `${running.httpUrl}/api/rooms/${created.body.room.roomId}/start`,
      {
        method: "POST",
        token: created.body.reconnectToken,
        body: JSON.stringify({
          playerId: created.body.playerId,
          commandId: "network-start",
          expectedVersion: current.body.version,
        }),
      },
    );
    expect(started.status).toBe(200);
    expect(started.body.room.status).toBe("started");

    for (const connection of connections) connection.socket.close();
    await running.server.closeGracefully();
    running = await startRoomServer(databasePath);

    current = await jsonRequest<RoomView>(
      `${running.httpUrl}/api/rooms/${created.body.room.roomId}?playerId=${created.body.playerId}`,
      { token: created.body.reconnectToken },
    );
    expect(current.body.status).toBe("started");
    expect(current.body.matchId).toBe(started.body.room.matchId);

    const firstReconnect = await connect(running.wsUrl, created.body);
    const firstClosed = new Promise<number>((resolve) =>
      firstReconnect.socket.once("close", (code) => resolve(code)),
    );
    const replacement = await connect(running.wsUrl, created.body);
    await expect(firstClosed).resolves.toBe(4000);

    current = await jsonRequest<RoomView>(
      `${running.httpUrl}/api/rooms/${created.body.room.roomId}?playerId=${created.body.playerId}`,
      { token: created.body.reconnectToken },
    );
    const ended = await jsonRequest<{ duplicate: boolean; room: RoomView }>(
      `${running.httpUrl}/api/rooms/${created.body.room.roomId}/end`,
      {
        method: "POST",
        token: created.body.reconnectToken,
        body: JSON.stringify({
          playerId: created.body.playerId,
          commandId: "network-end",
          expectedVersion: current.body.version,
        }),
      },
    );
    expect(ended.body.room.status).toBe("ended");
    replacement.socket.close();
    await running.server.closeGracefully();
  });

  it("rejects hostile origins and wrong reconnect tokens without a room view", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-room-security-"));
    roots.push(root);
    const running = await startRoomServer(join(root, "room.sqlite"));
    const created = await jsonRequest<RoomSession>(
      `${running.httpUrl}/api/rooms`,
      {
        method: "POST",
        body: JSON.stringify({ nickname: "房主" }),
      },
    );

    const hostileStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(running.wsUrl, {
        origin: "https://evil.example",
      });
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      socket.once("error", (error) => {
        if ((error as Error).message.includes("403")) return;
        reject(error);
      });
    });
    expect(hostileStatus).toBe(403);

    const missingOriginStatus = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(running.wsUrl);
      socket.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
      });
      socket.once("error", (error) => {
        if ((error as Error).message.includes("403")) return;
        reject(error);
      });
    });
    expect(missingOriginStatus).toBe(403);

    const messages: ServerMessage[] = [];
    const closed = new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(running.wsUrl, {
        origin: "https://game.local",
      });
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as ServerMessage;
        messages.push(message);
        if (message.type === "hello") {
          socket.send(
            JSON.stringify({
              type: "authenticate",
              protocolVersion: 1,
              matchId: created.body.room.roomId,
              playerId: created.body.playerId,
              reconnectToken: "x".repeat(43),
              clientInstanceId: "wrong-token",
            }),
          );
        }
      });
      socket.once("close", (code) => resolve(code));
      socket.once("error", reject);
    });
    await expect(closed).resolves.toBe(4401);
    expect(messages.some((message) => message.type === "player-view")).toBe(
      false,
    );
    expect(messages.find((message) => message.type === "error")).toMatchObject({
      category: "unauthenticated",
      code: "authentication-failed",
    });
    await running.server.closeGracefully();
  });
});
