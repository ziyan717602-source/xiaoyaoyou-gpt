import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

const playerIds = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
type PlayerId = (typeof playerIds)[number];

interface Snapshot {
  version: number;
  activePlayerId: PlayerId;
  hands: Record<PlayerId, string[]>;
}

interface CommandEnvelope {
  commandId: string;
  playerId: PlayerId;
  expectedVersion: number;
  action: "pass" | "play-response";
}

class VerificationServer {
  readonly database: DatabaseSync;
  private httpServer: HttpServer | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private sockets = new Set<WebSocket>();

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        snapshot_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        result_json TEXT NOT NULL
      );
    `);
    const existing = this.database
      .prepare("SELECT 1 FROM matches WHERE match_id = ?")
      .get("verification-match");
    if (existing === undefined) {
      const hands = Object.fromEntries(
        playerIds.map((id) => [id, [`secret:${id}:a`, `secret:${id}:b`]]),
      ) as Record<PlayerId, string[]>;
      const snapshot: Snapshot = { version: 0, activePlayerId: "p1", hands };
      this.database
        .prepare("INSERT INTO matches(match_id, snapshot_json) VALUES (?, ?)")
        .run("verification-match", JSON.stringify(snapshot));
    }
  }

  private loadSnapshot(): Snapshot {
    const row = this.database
      .prepare("SELECT snapshot_json FROM matches WHERE match_id = ?")
      .get("verification-match") as { snapshot_json: string };
    return JSON.parse(row.snapshot_json) as Snapshot;
  }

  private project(snapshot: Snapshot, viewerId: PlayerId) {
    return {
      type: "player-view",
      matchId: "verification-match",
      version: snapshot.version,
      activePlayerId: snapshot.activePlayerId,
      players: playerIds.map((id) => ({
        id,
        handCount: snapshot.hands[id].length,
        hand: id === viewerId ? snapshot.hands[id] : null,
      })),
      availableActions:
        snapshot.activePlayerId === viewerId
          ? [{ id: `pass:${snapshot.version}`, kind: "pass" }]
          : [],
    };
  }

  private handleCommand(
    socket: WebSocket,
    authenticatedPlayerId: PlayerId,
    command: CommandEnvelope,
  ): void {
    const duplicate = this.database
      .prepare("SELECT result_json FROM command_receipts WHERE command_id = ?")
      .get(command.commandId) as { result_json: string } | undefined;
    if (duplicate !== undefined) {
      socket.send(duplicate.result_json);
      return;
    }

    const snapshot = this.loadSnapshot();
    if (
      command.playerId !== authenticatedPlayerId ||
      snapshot.activePlayerId !== authenticatedPlayerId
    ) {
      socket.send(
        JSON.stringify({
          type: "command-rejected",
          commandId: command.commandId,
          reason: "forbidden",
          currentVersion: snapshot.version,
        }),
      );
      return;
    }
    if (command.expectedVersion !== snapshot.version) {
      socket.send(
        JSON.stringify({
          type: "command-rejected",
          commandId: command.commandId,
          reason: "stale-version",
          currentVersion: snapshot.version,
        }),
      );
      return;
    }

    const currentIndex = playerIds.indexOf(snapshot.activePlayerId);
    const next: Snapshot = {
      ...snapshot,
      version: snapshot.version + 1,
      activePlayerId: playerIds[(currentIndex + 1) % playerIds.length]!,
    };
    const result = JSON.stringify({
      type: "command-accepted",
      commandId: command.commandId,
      version: next.version,
    });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare("UPDATE matches SET snapshot_json = ? WHERE match_id = ?")
        .run(JSON.stringify(next), "verification-match");
      this.database
        .prepare(
          "INSERT INTO command_receipts(command_id, result_json) VALUES (?, ?)",
        )
        .run(command.commandId, result);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    socket.send(result);
  }

  async start(): Promise<number> {
    this.httpServer = createServer((request, response) => {
      if (request.url === "/health") {
        const snapshot = this.loadSnapshot();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ status: "ok", version: snapshot.version }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    this.webSocketServer = new WebSocketServer({
      server: this.httpServer,
      path: "/ws",
    });
    this.webSocketServer.on("connection", (socket, request) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      const token = new URL(
        request.url ?? "/",
        "http://localhost",
      ).searchParams.get("token");
      const playerId = playerIds.find((id) => token === `token:${id}`);
      if (playerId === undefined) {
        socket.close(1008, "unauthorized");
        return;
      }
      socket.send(JSON.stringify(this.project(this.loadSnapshot(), playerId)));
      socket.on("message", (bytes) =>
        this.handleCommand(
          socket,
          playerId,
          JSON.parse(bytes.toString()) as CommandEnvelope,
        ),
      );
    });
    await new Promise<void>((resolve) =>
      this.httpServer!.listen(0, "127.0.0.1", resolve),
    );
    const address = this.httpServer.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing test server address.");
    return address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    await Promise.all(
      [...this.sockets].map(
        (socket) =>
          new Promise<void>((resolve) => socket.once("close", resolve)),
      ),
    );
    await new Promise<void>((resolve) =>
      this.webSocketServer?.close(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      this.httpServer?.close(() => resolve()),
    );
    this.database.close();
  }
}

function connect(
  port: number,
  playerId: PlayerId,
): Promise<{ socket: WebSocket; view: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=token:${playerId}`,
    );
    socket.once("error", reject);
    socket.once("message", (bytes) =>
      resolve({
        socket,
        view: JSON.parse(bytes.toString()) as Record<string, unknown>,
      }),
    );
  });
}

function send(
  socket: WebSocket,
  command: CommandEnvelope,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("message", (bytes) =>
      resolve(JSON.parse(bytes.toString()) as Record<string, unknown>),
    );
    socket.send(JSON.stringify(command));
  });
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("real HTTP/WebSocket six-connection verification", () => {
  it("isolates six views, deduplicates commands, reconnects, and restores from SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "xiaoyaoyou-p07-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "verification.sqlite");
    let server = new VerificationServer(databasePath);
    let port = await server.start();
    const health = (await fetch(`http://127.0.0.1:${port}/health`).then(
      (response) => response.json(),
    )) as { status: string; version: number };
    expect(health).toEqual({ status: "ok", version: 0 });

    const clients = await Promise.all(
      playerIds.map((playerId) => connect(port, playerId)),
    );
    for (const [index, client] of clients.entries()) {
      const viewerId = playerIds[index]!;
      const players = client.view.players as Array<{
        id: PlayerId;
        hand: string[] | null;
      }>;
      for (const player of players)
        expect(player.hand).toEqual(
          player.id === viewerId
            ? [`secret:${viewerId}:a`, `secret:${viewerId}:b`]
            : null,
        );
      expect((client.view.availableActions as unknown[]).length > 0).toBe(
        viewerId === "p1",
      );
    }

    const command: CommandEnvelope = {
      commandId: "command:p1:1",
      playerId: "p1",
      expectedVersion: 0,
      action: "pass",
    };
    const first = await send(clients[0]!.socket, command);
    const duplicate = await send(clients[0]!.socket, command);
    expect(duplicate).toEqual(first);
    expect(
      server.database
        .prepare("SELECT COUNT(*) AS count FROM command_receipts")
        .get(),
    ).toEqual({ count: 1 });

    const forgedA = await send(clients[2]!.socket, {
      commandId: "guess:a",
      playerId: "p2",
      expectedVersion: 1,
      action: "play-response",
    });
    const forgedB = await send(clients[3]!.socket, {
      commandId: "guess:b",
      playerId: "p2",
      expectedVersion: 1,
      action: "play-response",
    });
    expect({ ...forgedA, commandId: "same" }).toEqual({
      ...forgedB,
      commandId: "same",
    });

    clients[0]!.socket.close();
    await new Promise<void>((resolve) =>
      clients[0]!.socket.once("close", resolve),
    );
    const reconnected = await connect(port, "p1");
    expect(reconnected.view.version).toBe(1);
    expect(
      (
        reconnected.view.players as Array<{
          id: PlayerId;
          hand: string[] | null;
        }>
      ).find((player) => player.id === "p1")?.hand,
    ).toEqual(["secret:p1:a", "secret:p1:b"]);
    reconnected.socket.close();
    for (const client of clients.slice(1)) client.socket.close();
    await server.stop();

    server = new VerificationServer(databasePath);
    port = await server.start();
    const restored = await connect(port, "p2");
    expect(restored.view.version).toBe(1);
    expect(restored.view.activePlayerId).toBe("p2");
    expect(restored.view.availableActions).toEqual([
      { id: "pass:1", kind: "pass" },
    ]);
    restored.socket.close();
    await server.stop();
  });
});
