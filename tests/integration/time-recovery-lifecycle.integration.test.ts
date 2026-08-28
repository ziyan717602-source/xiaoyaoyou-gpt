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
  beginNpcAction,
  collectSystemDeadlines,
  type MatchState,
  type PlayerView,
} from "@xiaoyaoyou/engine";
import {
  npcFixture,
  grantPets,
} from "../../packages/engine/src/testing/npc-fixture.js";
import {
  buildRoomServer,
  type RoomAppServer,
} from "../../apps/server/src/room-server.js";
import { startFetchableServer } from "../helpers/fetchable-server.js";

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
  const { server, httpUrl: address } = await startFetchableServer(() =>
    buildRoomServer({ databasePath, logger: false }),
  );
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
  it.each([
    "xyy.npc-action.nj01",
    "xyy.npc-action.nj06",
    "xyy.npc-action.nj07",
  ] as const)(
    "preserves %s choices through SQLite restart, rejects other players and deduplicates the transfer",
    async (actionId) => {
      const petExchange = actionId === "xyy.npc-action.nj07";
      const heroJoin = actionId === "xyy.npc-action.nj01";
      const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-npc-integration-"));
      roots.push(root);
      const databasePath = join(root, "npc.sqlite");
      let running = await start(databasePath);
      let clients: Client[] = [];
      let stopped = false;
      const stop = async () => {
        for (const client of clients) client.socket.close();
        await running.server.closeGracefully();
        stopped = true;
        clients = [];
      };
      try {
        const created = await createPlaying(running);
        clients = [...created.clients];
        await stop();
        const base = latestSnapshotState(databasePath, created.roomId);
        let input = npcFixture(actionId, "npc-network", {
          base,
          at: Date.now(),
          ...(heroJoin ? { npcId: "xyy.npc.nc106" as const } : {}),
        });
        const actor = input.activePlayerId!;
        const donor = input.turnOrder.find(
          (id) =>
            id !== actor &&
            (!heroJoin ||
              input.players[id]!.team === input.players[actor]!.team),
        )!;
        const recipient = input.turnOrder.find(
          (id) =>
            id !== donor &&
            (!heroJoin || id !== actor) &&
            input.players[id]!.team === input.players[donor]!.team,
        )!;
        const hand = input.drawPile.slice(0, 2);
        input = {
          ...input,
          drawPile: input.drawPile.slice(2),
          players: {
            ...input.players,
            [donor]: { ...input.players[donor]!, hand },
          },
        };
        if (petExchange) {
          input = grantPets(input, donor, [
            "xyy.monster.gs04",
            "xyy.monster.gl04",
          ]);
          input = grantPets(input, recipient, ["xyy.monster.gs01"]);
        }
        if (heroJoin) {
          input = grantPets(input, donor, ["xyy.monster.gs04"]);
          input = {
            ...input,
            players: {
              ...input.players,
              [recipient]: {
                ...input.players[recipient]!,
                alive: false,
                hp: 0,
              },
            },
          };
        }
        const prepared = beginNpcAction(
          input,
          "npc-fixture-entry",
          input.turn!.openedAt + 1,
        ).state;
        // Only the starting scenario is injected. All following selections,
        // disconnects, persistence, restart and deduplication use the real actor.
        const stateJson = JSON.stringify({
          ...prepared,
          version: base.version,
          eventSequence: base.eventSequence,
        });
        const database = new Database(databasePath);
        try {
          database
            .prepare(
              "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE match_id = ? AND event_sequence = ?",
            )
            .run(
              stateJson,
              createHash("sha256").update(stateJson).digest("hex"),
              created.roomId,
              base.eventSequence,
            );
        } finally {
          database.close();
        }
        const reconnect = async () => {
          running = await start(databasePath);
          stopped = false;
          clients = await Promise.all(
            created.sessions.map((session) => connect(running.wsUrl, session)),
          );
          const version = Math.max(...clients.map((c) => c.latestView.version));
          await waitUntil(() =>
            clients.every((c) => c.latestView.version === version),
          );
        };
        const indexOf = (id: PlayerId) =>
          created.sessions.findIndex((s) => s.playerId === id);
        const submit = async (
          id: PlayerId,
          commandId: string,
          selections: readonly string[],
          choiceId?: string,
        ) => {
          const i = indexOf(id),
            client = clients[i]!;
          const response = await send(client, created.sessions[i]!, commandId, {
            type: "submit-choice",
            choiceId: choiceId ?? client.latestView.pendingChoice!.choiceId,
            selections,
          });
          if (response.type === "command-accepted") {
            await waitUntil(() =>
              clients.every((c) => c.latestView.version >= response.version),
            );
          }
          return response;
        };
        await reconnect();
        expect((await submit(actor, "npc-donor", [donor])).type).toBe(
          "command-accepted",
        );
        if (!heroJoin)
          expect((await submit(actor, "npc-recipient", [recipient])).type).toBe(
            "command-accepted",
          );
        const choiceOwner = petExchange || heroJoin ? actor : donor;
        const options = heroJoin
          ? Object.values(input.players)
              .filter((p) => p.team === input.players[actor]!.team)
              .sort((a, b) => a.seat - b.seat)
              .map((p) => p.id)
          : petExchange
            ? ["xyy.monster.gl04", "xyy.monster.gs04"]
            : hand;
        const checkPrivacy = () => {
          for (const [i, client] of clients.entries()) {
            if (created.sessions[i]!.playerId === choiceOwner) {
              expect(client.latestView.pendingChoice!.optionIds).toEqual(
                options,
              );
              expect(
                client.latestView.availableActions.some(
                  (a) => a.type === "submit-choice",
                ),
              ).toBe(true);
            } else {
              expect(client.latestView.pendingChoice).toBeNull();
              expect(client.latestView.availableActions).toEqual([]);
            }
            if (created.sessions[i]!.playerId !== donor)
              for (const card of hand)
                expect(JSON.stringify(client.latestView)).not.toContain(card);
          }
        };
        checkPrivacy();
        const choice = clients[indexOf(choiceOwner)]!.latestView.pendingChoice!;
        const stateBefore = latestSnapshotState(databasePath, created.roomId);
        await stop();
        await reconnect();
        checkPrivacy();
        expect(clients[indexOf(choiceOwner)]!.latestView.pendingChoice).toEqual(
          choice,
        );
        expect(latestSnapshotState(databasePath, created.roomId).rng).toEqual(
          stateBefore.rng,
        );
        const denied = await submit(
          petExchange || heroJoin ? donor : actor,
          "npc-forged-owner",
          [options[0]!],
          choice.choiceId,
        );
        expect(denied.type).toBe("command-rejected");
        const selected = heroJoin ? recipient : options[1]!;
        const receipt = await submit(choiceOwner, "npc-transfer", [selected]);
        expect(receipt.type).toBe("command-accepted");
        const finished = latestSnapshotState(databasePath, created.roomId);
        expect(finished.players[donor]!.hand).toEqual(
          heroJoin ? [] : petExchange ? hand : [hand[0]],
        );
        expect(finished.players[recipient]!.hand).toEqual(
          petExchange || heroJoin ? [] : [hand[1]],
        );
        if (petExchange) {
          expect(finished.encounterState.pets[donor]).toEqual([
            "xyy.monster.gs01",
            "xyy.monster.gl04",
          ]);
          expect(finished.encounterState.pets[recipient]).toEqual([
            "xyy.monster.gs04",
          ]);
          expect(finished.players[donor]!.dexterity).toBe(
            input.players[donor]!.dexterity - 1,
          );
          expect(finished.players[recipient]!.dexterity).toBe(
            input.players[recipient]!.dexterity + 1,
          );
          expect(finished.encounterState.weaponDisabledReasons).toEqual(
            input.encounterState.weaponDisabledReasons,
          );
        }
        if (heroJoin) {
          expect(finished.players[recipient]).toMatchObject({
            heroId: "xyy.hero.xj106",
            alive: true,
            hp: 4,
          });
          expect(finished.encounterState.heroDiscards).toContain(
            input.players[recipient]!.heroId,
          );
          expect(finished.discardPile).toEqual(hand);
          expect(finished.encounterState.pets).toEqual(
            input.encounterState.pets,
          );
          expect(finished.players[donor]!.strength).toBe(
            input.players[donor]!.strength,
          );
          expect(finished.players[donor]!.dexterity).toBe(
            input.players[donor]!.dexterity,
          );
        }
        expect(finished.encounterState.npc).toBeNull();
        expect(finished.encounterDiscard).toEqual([
          input.encounterState.resolution!.heldCardId,
        ]);
        expect(finished.drawPile).toEqual(input.drawPile);
        const duplicate = await submit(
          choiceOwner,
          "npc-transfer",
          [selected],
          choice.choiceId,
        );
        expect(duplicate).toMatchObject({
          type: "command-accepted",
          duplicate: true,
        });
        expect(latestSnapshotState(databasePath, created.roomId)).toEqual(
          finished,
        );
        await stop();
        await reconnect();
        const afterRestart = latestSnapshotState(databasePath, created.roomId);
        expect(afterRestart.players).toEqual(finished.players);
        expect(afterRestart.encounterState).toEqual(finished.encounterState);
        expect(afterRestart.encounterDiscard).toEqual(
          finished.encounterDiscard,
        );
        expect(afterRestart.drawPile).toEqual(finished.drawPile);
        expect(afterRestart.rng).toEqual(finished.rng);
      } finally {
        if (!stopped) await stop();
      }
    },
  );
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
