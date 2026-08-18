import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginDamageResponse,
  planDamageBatch,
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
  body: unknown,
  token?: string,
): Promise<T> {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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
    const socket = new WebSocket(wsUrl, { origin: "https://game.local" });
    const waiters = new Set<{
      predicate: (message: ServerMessage) => boolean;
      resolve: (message: ServerMessage) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();
    const client: Client = {
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
              rejectMessage(new Error("damage websocket message timeout"));
            }, 5_000),
          };
          waiters.add(waiter);
        }),
    };
    const timer = setTimeout(
      () => reject(new Error("damage websocket connection timeout")),
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
            clientInstanceId: `damage-${session.playerId}`,
          }),
        );
      }
      if (message.type === "player-view") {
        client.latestView = message.view as PlayerView;
        if (
          client.latestView.phase === "setup" ||
          client.latestView.phase === "playing"
        ) {
          clearTimeout(timer);
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
      clearTimeout(timer);
      reject(error);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      waiters.clear();
    });
  });
}

async function send(
  client: Client,
  session: RoomSession,
  commandId: string,
  expectedVersion: number,
  command: ClientCommand,
) {
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
        clientIssuedAt: 0,
        command,
      },
    }),
  );
  return (await result) as Extract<
    ServerMessage,
    { type: "command-accepted" | "command-rejected" }
  >;
}

async function waitVersion(clients: readonly Client[], version: number) {
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

async function createPlaying(running: {
  httpUrl: string;
  wsUrl: string;
}): Promise<{
  sessions: RoomSession[];
  clients: Client[];
  roomId: string;
  version: number;
}> {
  const created = await request<RoomSession>(`${running.httpUrl}/api/rooms`, {
    nickname: "房主",
  });
  const sessions = [created];
  for (let index = 1; index < 6; index += 1) {
    sessions.push(
      await request<RoomSession>(`${running.httpUrl}/api/rooms/join`, {
        inviteCode: created.room.inviteCode,
        nickname: `玩家 ${index + 1}`,
      }),
    );
  }
  let room = sessions.at(-1)!.room;
  for (const [index, session] of sessions.entries()) {
    const result = await request<{ room: RoomView }>(
      `${running.httpUrl}/api/rooms/${room.roomId}/ready`,
      {
        playerId: session.playerId,
        commandId: `damage-ready-${index}`,
        expectedVersion: room.version,
        ready: true,
      },
      session.reconnectToken,
    );
    room = result.room;
  }
  await request<{ room: RoomView }>(
    `${running.httpUrl}/api/rooms/${room.roomId}/start`,
    {
      playerId: created.playerId,
      commandId: "damage-start",
      expectedVersion: room.version,
    },
    created.reconnectToken,
  );
  const clients = await Promise.all(
    sessions.map((session) => connect(running.wsUrl, session)),
  );
  let version = clients[0]!.latestView.version;
  for (const [index, client] of clients.entries()) {
    const heroId = client.latestView.setup!.ownOffer!.candidateHeroIds[0]!;
    const response = await send(
      client,
      sessions[index]!,
      `damage-choose-${index}`,
      version,
      { type: "choose-hero", heroId },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
  }
  return { sessions, clients, roomId: room.roomId, version };
}

function rewriteSnapshot(
  databasePath: string,
  matchId: string,
  rewrite: (state: MatchState) => MatchState,
) {
  const database = new Database(databasePath);
  try {
    const row = database
      .prepare(
        `SELECT rowid, state_json FROM snapshots
         WHERE match_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      )
      .get(matchId) as { rowid: number; state_json: string };
    const stateJson = JSON.stringify(
      rewrite(JSON.parse(row.state_json) as MatchState),
    );
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

function injectCards(
  state: MatchState,
  input: {
    actor: PlayerId;
    target: PlayerId;
    rescuer?: PlayerId;
    winnerFixture?: boolean;
    immuneFixture?: boolean;
    reductionFixture?: boolean;
    reviveFixture?: boolean;
    shoeFixture?: boolean;
    robeFixture?: boolean;
  },
): MatchState {
  const hands: Record<PlayerId, readonly string[]> = {
    [input.actor]: ["xyy.card.jp05@10"],
    [input.target]:
      input.winnerFixture || input.robeFixture ? ["xyy.card.jp01@1"] : [],
    ...(input.rescuer === undefined
      ? {}
      : {
          [input.rescuer]: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
        }),
  };
  const equipment = input.winnerFixture
    ? { weapon: "xyy.card.wq01@47", armor: "xyy.card.fj01@52" }
    : input.immuneFixture
      ? { weapon: null, armor: "xyy.card.fj04@55" }
      : input.reductionFixture
        ? { weapon: null, armor: "xyy.card.fj03@54" }
        : input.reviveFixture
          ? { weapon: "xyy.card.wq02@48", armor: "xyy.card.fj01@52" }
          : input.shoeFixture
            ? { weapon: "xyy.card.wq02@48", armor: "xyy.card.fj05@56" }
            : input.robeFixture
              ? { weapon: null, armor: "xyy.card.fj02@53" }
              : input.rescuer === undefined
                ? { weapon: null, armor: null }
                : { weapon: "xyy.card.wq02@48", armor: null };
  const claimed = new Set([
    ...Object.values(hands).flat(),
    ...[equipment.weapon, equipment.armor].filter(
      (card): card is string => card !== null,
    ),
  ]);
  return {
    ...state,
    phase: "playing",
    activePlayerId: input.actor,
    turn: {
      ...(state.turn ?? {
        number: 1,
        openedAt: 0,
        deadlineAt: 15_000,
      }),
      number: state.turn?.number ?? 1,
      phase: "action",
    },
    winner: null,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => {
        const staysAlive =
          !input.winnerFixture ||
          player.id === input.actor ||
          player.id === input.target;
        return [
          player.id,
          {
            ...player,
            heroId:
              player.id === input.rescuer ? "xyy.hero.x3w03" : player.heroId,
            alive: staysAlive,
            hp: player.id === input.target ? 2 : staysAlive ? player.maxHp : 0,
            hand: hands[player.id] ?? [],
            equipment:
              player.id === input.target
                ? equipment
                : { weapon: null, armor: null },
          },
        ];
      }),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
}

function injectJn50501Damage(
  state: MatchState,
  input: {
    actor: PlayerId;
    target: PlayerId;
    immuneInvao: boolean;
  },
): MatchState {
  const arranged = injectCards(state, {
    actor: input.actor,
    target: input.target,
  });
  const prepared: MatchState = {
    ...arranged,
    players: {
      ...arranged.players,
      [input.target]: {
        ...arranged.players[input.target]!,
        heroId: "xyy.hero.xj405",
        hp: 4,
        maxHp: 6,
        hand: ["xyy.card.tp03@39"],
      },
    },
    drawPile: arranged.drawPile.filter((card) => card !== "xyy.card.tp03@39"),
  };
  return beginDamageResponse(
    prepared,
    input.immuneInvao ? "network-jn50501-bypass" : "network-jn50501-immune",
    input.actor,
    planDamageBatch(prepared, [
      {
        itemId: input.immuneInvao
          ? "network-jn50501-bypass-fire"
          : "network-jn50501-fire",
        sourcePlayerId: input.actor,
        targetPlayerId: input.target,
        amount: 2,
        element: "fire",
        hpEvoMask: input.immuneInvao ? ["immune-inavo"] : [],
      },
    ]),
    Date.now(),
  );
}

function injectJn20302(
  state: MatchState,
  input: { actor: PlayerId; target: PlayerId },
): MatchState {
  const arranged = injectCards(state, input);
  const claimed = new Set(["xyy.card.jp01@1", "xyy.card.wq02@48"]);
  return {
    ...arranged,
    players: Object.fromEntries(
      Object.values(arranged.players).map((player) => [
        player.id,
        {
          ...player,
          heroId: player.id === input.actor ? "xyy.hero.xj203" : player.heroId,
          hp: player.id === input.target ? 1 : player.hp,
          maxHp: player.id === input.target ? 5 : player.maxHp,
          hand: player.id === input.actor ? ["xyy.card.jp01@1"] : [],
          equipment:
            player.id === input.target
              ? { weapon: "xyy.card.wq02@48", armor: null }
              : { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
  };
}

async function passReactions(
  clients: readonly Client[],
  sessions: readonly RoomSession[],
  version: number,
  prefix: string,
): Promise<number> {
  let nextVersion = version;
  let index = 0;
  while (clients[0]!.latestView.reactionWindow !== null) {
    const window = clients[0]!.latestView.reactionWindow!;
    const playerId = window.priorityPlayerId!;
    const clientIndex = sessions.findIndex(
      (session) => session.playerId === playerId,
    );
    const response = await send(
      clients[clientIndex]!,
      sessions[clientIndex]!,
      `${prefix}-${index}`,
      nextVersion,
      { type: "pass-reaction", windowId: window.windowId },
    );
    expect(response.type).toBe("command-accepted");
    nextVersion += 1;
    await waitVersion(clients, nextVersion);
    index += 1;
  }
  return nextVersion;
}

describe("M05 damage/dying over six real WebSockets", () => {
  it("restarts mid-rescue, retries idempotently, rescues, then finishes by death", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-dying-integration-"));
    roots.push(root);
    const databasePath = join(root, "dying.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients, version } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const actor = clients[0]!.latestView.activePlayerId!;
    const actorIndex = ordered.findIndex((player) => player.id === actor);
    const target = ordered[(actorIndex + 1) % ordered.length]!.id;
    const rescuer = ordered[(actorIndex + 2) % ordered.length]!.id;
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectCards(state, { actor, target, rescuer }),
    );

    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);
    let response = await send(
      clients[indexOf(actor)]!,
      sessions[indexOf(actor)]!,
      "network-damage-jp05",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    version = await passReactions(
      clients,
      sessions,
      version,
      "damage-reaction-pass",
    );
    expect(clients[0]!.latestView.dyingBatch?.currentTargetPlayerId).toBe(
      target,
    );
    expect(
      clients
        .filter((_, index) => index !== indexOf(target))
        .every((client) => client.latestView.availableActions.length === 0),
    ).toBe(true);

    const targetPassVersion = version;
    response = await send(
      clients[indexOf(target)]!,
      sessions[indexOf(target)]!,
      "network-target-passes-rescue",
      version,
      {
        type: "pass-rescue",
        choiceId: clients[indexOf(target)]!.latestView.pendingChoice!.choiceId,
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    const persistedBatch = JSON.parse(
      JSON.stringify(clients[0]!.latestView.dyingBatch),
    );
    const persistedChoice = JSON.parse(
      JSON.stringify(clients[indexOf(rescuer)]!.latestView.pendingChoice),
    );

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    expect(clients[0]!.latestView.dyingBatch).toEqual(persistedBatch);
    expect(clients[indexOf(rescuer)]!.latestView.pendingChoice).toEqual(
      persistedChoice,
    );
    response = await send(
      clients[indexOf(target)]!,
      sessions[indexOf(target)]!,
      "network-target-passes-rescue",
      version,
      { type: "pass-rescue", choiceId: persistedChoice.choiceId },
    );
    expect(response).toMatchObject({
      type: "command-accepted",
      duplicate: true,
      version: targetPassVersion + 1,
    });
    expect(clients[indexOf(rescuer)]!.latestView.availableActions).toEqual([
      {
        type: "play-skill-converted-card",
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
        requiredCardCount: 2,
        skillId: "xyy.skill.jn40301",
        targetPlayerIds: [target],
      },
      { type: "pass-rescue", choiceId: persistedChoice.choiceId },
    ]);
    expect(
      clients
        .filter((_, index) => index !== indexOf(rescuer))
        .every((client) => client.latestView.availableActions.length === 0),
    ).toBe(true);
    response = await send(
      clients[indexOf(rescuer)]!,
      sessions[indexOf(rescuer)]!,
      "network-rescue-jn40301",
      version,
      {
        type: "play-skill-converted-card",
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
        skillId: "xyy.skill.jn40301",
        targetPlayerIds: [target],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(clients[0]!.latestView.dyingBatch).toBeNull();
    expect(
      clients[0]!.latestView.players.find((player) => player.id === target),
    ).toMatchObject({ alive: true, hp: 3 });

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectCards(state, { actor, target, reductionFixture: true }),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    response = await send(
      clients[indexOf(actor)]!,
      sessions[indexOf(actor)]!,
      "network-fj03-jp05-reduction",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    version = await passReactions(clients, sessions, version, "fj03-pass");
    expect(
      clients[0]!.latestView.players.find((player) => player.id === target),
    ).toMatchObject({
      alive: true,
      hp: 1,
      equipment: { weapon: null, armor: "xyy.card.fj03@54" },
    });
    expect(clients[0]!.latestView.dyingBatch).toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn50501Damage(state, {
        actor,
        target,
        immuneInvao: false,
      }),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    expect(
      clients[0]!.latestView.players.find((player) => player.id === target),
    ).toMatchObject({
      heroId: "xyy.hero.xj405",
      hp: 4,
      handCount: 1,
    });
    expect(clients[0]!.latestView.reactionWindow).toBeNull();
    expect(
      clients.every((client) =>
        client.latestView.availableActions.every(
          (action) => action.type !== "play-reaction-card",
        ),
      ),
    ).toBe(true);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn50501Damage(state, {
        actor,
        target,
        immuneInvao: true,
      }),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    expect(
      clients[indexOf(target)]!.latestView.availableActions,
    ).toContainEqual({
      type: "play-reaction-card",
      cardInstanceId: "xyy.card.tp03@39",
      targetEffectId: "network-jn50501-bypass:damage-batch",
    });
    expect(
      clients
        .filter((_, index) => index !== indexOf(target))
        .every((client) =>
          client.latestView.availableActions.every(
            (action) => action.type !== "play-reaction-card",
          ),
        ),
    ).toBe(true);
    version = await passReactions(
      clients,
      sessions,
      version,
      "jn50501-bypass-pass",
    );
    expect(
      clients[0]!.latestView.players.find((player) => player.id === target),
    ).toMatchObject({ heroId: "xyy.hero.xj405", hp: 2 });
    expect(clients[0]!.latestView.reactionWindow).toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectCards(state, { actor, target, immuneFixture: true }),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const immuneHp = clients[0]!.latestView.players.find(
      (player) => player.id === target,
    )!.hp;
    response = await send(
      clients[indexOf(actor)]!,
      sessions[indexOf(actor)]!,
      "network-fj04-jp05-immunity",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    version = await passReactions(clients, sessions, version, "fj04-pass");
    expect(
      clients[0]!.latestView.players.find((player) => player.id === target),
    ).toMatchObject({
      alive: true,
      hp: immuneHp,
      equipment: { weapon: null, armor: "xyy.card.fj04@55" },
    });
    expect(clients[0]!.latestView.dyingBatch).toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectCards(state, { actor, target, reviveFixture: true }),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    response = await send(
      clients[indexOf(actor)]!,
      sessions[indexOf(actor)]!,
      "network-fj01-jp05",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    version = await passReactions(clients, sessions, version, "fj01-pass");
    expect(
      clients[indexOf(target)]!.latestView.availableActions,
    ).toContainEqual({
      type: "activate-rescue-equipment",
      cardInstanceId: "xyy.card.fj01@52",
      targetPlayerId: target,
    });
    expect(
      clients
        .filter((_, index) => index !== indexOf(target))
        .every((client) => client.latestView.availableActions.length === 0),
    ).toBe(true);
    response = await send(
      clients[indexOf(target)]!,
      sessions[indexOf(target)]!,
      "network-fj01-activate",
      version,
      {
        type: "activate-rescue-equipment",
        cardInstanceId: "xyy.card.fj01@52",
        targetPlayerId: target,
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(
      clients[0]!.latestView.players.find((player) => player.id === target),
    ).toMatchObject({
      alive: true,
      hp: 3,
      equipment: { weapon: "xyy.card.wq02@48", armor: null },
    });
    expect(clients[0]!.latestView.dyingBatch).toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectCards(state, { actor, target, shoeFixture: true }),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const shoeHpBefore = clients[0]!.latestView.players.find(
      (player) => player.id === target,
    )!.hp;
    response = await send(
      clients[indexOf(actor)]!,
      sessions[indexOf(actor)]!,
      "network-fj05-jp05",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    let originalPass = 0;
    while (clients[0]!.latestView.effectStack.at(-1)?.kind !== "damage-batch") {
      const window = clients[0]!.latestView.reactionWindow!;
      response = await send(
        clients[indexOf(window.priorityPlayerId)]!,
        sessions[indexOf(window.priorityPlayerId)]!,
        `network-fj05-original-pass-${originalPass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitVersion(clients, version);
      originalPass += 1;
      if (originalPass > 6) throw new Error("FJ05 damage gate did not open.");
    }
    const damageEffectId = clients[0]!.latestView.effectStack.at(-1)!.effectId;
    expect(
      clients[indexOf(target)]!.latestView.availableActions,
    ).toContainEqual({
      type: "activate-damage-equipment",
      cardInstanceId: "xyy.card.fj05@56",
      targetEffectId: damageEffectId,
    });
    for (const [clientIndex, client] of clients.entries()) {
      if (clientIndex === indexOf(target)) continue;
      expect(client.latestView.availableActions).not.toContainEqual(
        expect.objectContaining({ type: "activate-damage-equipment" }),
      );
    }
    response = await send(
      clients[indexOf(target)]!,
      sessions[indexOf(target)]!,
      "network-fj05-activate",
      version,
      {
        type: "activate-damage-equipment",
        cardInstanceId: "xyy.card.fj05@56",
        targetEffectId: damageEffectId,
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    const shoeTarget = clients[0]!.latestView.players.find(
      (player) => player.id === target,
    )!;
    expect(shoeTarget).toMatchObject({
      hp: Math.min(shoeTarget.maxHp, shoeHpBefore + 2),
      equipment: { weapon: "xyy.card.wq02@48", armor: null },
    });
    expect(clients[0]!.latestView.reactionWindow).toBeNull();
    expect(clients[0]!.latestView.dyingBatch).toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectCards(state, { actor, target, robeFixture: true }),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const robeHpBefore = clients[0]!.latestView.players.find(
      (player) => player.id === target,
    )!.hp;
    response = await send(
      clients[indexOf(actor)]!,
      sessions[indexOf(actor)]!,
      "network-fj02-jp05",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    originalPass = 0;
    while (clients[0]!.latestView.effectStack.at(-1)?.kind !== "damage-batch") {
      const window = clients[0]!.latestView.reactionWindow!;
      response = await send(
        clients[indexOf(window.priorityPlayerId)]!,
        sessions[indexOf(window.priorityPlayerId)]!,
        `network-fj02-original-pass-${originalPass}`,
        version,
        { type: "pass-reaction", windowId: window.windowId },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitVersion(clients, version);
      originalPass += 1;
      if (originalPass > 6) throw new Error("FJ02 damage gate did not open.");
    }
    const robeDamageEffectId =
      clients[0]!.latestView.effectStack.at(-1)!.effectId;
    const conversion = {
      type: "play-converted-reaction-card" as const,
      cardInstanceId: "xyy.card.jp01@1",
      equipmentCardInstanceId: "xyy.card.fj02@53",
      targetEffectId: robeDamageEffectId,
    };
    expect(
      clients[indexOf(target)]!.latestView.availableActions,
    ).toContainEqual(conversion);
    for (const [clientIndex, client] of clients.entries()) {
      if (clientIndex === indexOf(target)) continue;
      expect(client.latestView.availableActions).not.toContainEqual(
        expect.objectContaining({ type: "play-converted-reaction-card" }),
      );
    }
    response = await send(
      clients[indexOf(target)]!,
      sessions[indexOf(target)]!,
      "network-fj02-convert",
      version,
      conversion,
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(clients[0]!.latestView.effectStack.at(-1)).toMatchObject({
      kind: "card:xyy.card.tp03",
      sourcePlayerId: target,
    });

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(clients[0]!.latestView.version).toBeGreaterThanOrEqual(version);
    version = clients[0]!.latestView.version;
    if (clients[0]!.latestView.reactionWindow !== null) {
      version = await passReactions(
        clients,
        sessions,
        version,
        "fj02-child-pass",
      );
    }
    const robeTarget = clients[indexOf(target)]!.latestView.players.find(
      (player) => player.id === target,
    )!;
    expect(robeTarget).toMatchObject({
      hp: robeHpBefore,
      handCount: 0,
      hand: [],
      equipment: { weapon: null, armor: "xyy.card.fj02@53" },
    });
    expect(clients[0]!.latestView.reactionWindow).toBeNull();
    expect(clients[0]!.latestView.dyingBatch).toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn20302(state, { actor, target }),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const jn20302Action = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn20302",
      targetPlayerIds: [target],
    };
    expect(clients[indexOf(actor)]!.latestView.availableActions).toContainEqual(
      {
        ...jn20302Action,
        requiredCardCount: 1,
        targetPlayerIds: clients[0]!.latestView.players
          .filter((player) => player.alive)
          .sort((left, right) => left.seat - right.seat)
          .map((player) => player.id),
        requiredTargetCount: 1,
      },
    );
    for (const [clientIndex, client] of clients.entries()) {
      if (clientIndex === indexOf(actor)) continue;
      expect(client.latestView.availableActions).not.toContainEqual(
        expect.objectContaining({ type: "activate-hero-skill" }),
      );
    }
    response = await send(
      clients[indexOf(actor)]!,
      sessions[indexOf(actor)]!,
      "network-jn20302-cure",
      version,
      jn20302Action,
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(
      clients[0]!.latestView.players.find((player) => player.id === target),
    ).toMatchObject({ hp: 4, equipment: { weapon: "xyy.card.wq02@48" } });
    expect(
      clients[indexOf(actor)]!.latestView.players.find(
        (player) => player.id === actor,
      ),
    ).toMatchObject({ hand: [], handCount: 0 });
    expect(clients[0]!.latestView.reactionWindow).toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(clients[0]!.latestView.version).toBeGreaterThanOrEqual(version);
    version = clients[0]!.latestView.version;
    expect(
      clients[0]!.latestView.players.find((player) => player.id === target),
    ).toMatchObject({ hp: 4 });
    expect(
      clients[indexOf(actor)]!.latestView.players.find(
        (player) => player.id === actor,
      ),
    ).toMatchObject({ hand: [], handCount: 0 });

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    const latest = clients[0]!.latestView;
    const winnerActor = latest.players.find((player) => player.team === 1)!.id;
    const loser = latest.players.find((player) => player.team === 2)!.id;
    const winnerTeam = latest.players.find(
      (player) => player.id === winnerActor,
    )!.team;
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectCards(state, {
        actor: winnerActor,
        target: loser,
        winnerFixture: true,
      }),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    response = await send(
      clients[indexOf(winnerActor)]!,
      sessions[indexOf(winnerActor)]!,
      "network-winning-jp05",
      version,
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [loser],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    version = await passReactions(
      clients,
      sessions,
      version,
      "winner-reaction-pass",
    );
    let pass = 0;
    while (clients[0]!.latestView.phase === "playing") {
      const batch = clients[0]!.latestView.dyingBatch!;
      const priority = batch.priorityOrder[batch.priorityIndex]!;
      response = await send(
        clients[indexOf(priority)]!,
        sessions[indexOf(priority)]!,
        `winner-rescue-pass-${pass}`,
        version,
        {
          type: "pass-rescue",
          choiceId:
            clients[indexOf(priority)]!.latestView.pendingChoice!.choiceId,
        },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitVersion(clients, version);
      pass += 1;
      if (pass > 2) throw new Error("Winning rescue window did not converge.");
    }
    expect(clients[0]!.latestView.winner).toBe(winnerTeam);
    const loserView = clients[indexOf(loser)]!.latestView.players.find(
      (player) => player.id === loser,
    )!;
    expect(loserView).toMatchObject({
      alive: false,
      hp: 0,
      hand: [],
      equipment: { weapon: null, armor: null },
    });
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });
});
