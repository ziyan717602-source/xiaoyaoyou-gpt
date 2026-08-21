import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginDamageResponse,
  beginDyingBatch,
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

function injectJn40401(state: MatchState, actor: PlayerId): MatchState {
  const target = state.turnOrder.find((playerId) => playerId !== actor)!;
  const arranged = injectCards(state, { actor, target });
  return {
    ...arranged,
    players: Object.fromEntries(
      Object.values(arranged.players).map((player) => [
        player.id,
        {
          ...player,
          heroId: player.id === actor ? "xyy.hero.x3w04" : player.heroId,
          hp: player.id === actor ? 1 : player.hp,
          maxHp: player.id === actor ? 5 : player.maxHp,
          hand: [],
          equipment:
            player.id === actor
              ? { weapon: "xyy.card.wq02@48", armor: null }
              : { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter(
      (card) => card !== "xyy.card.wq02@48",
    ),
    discardPile: [],
  };
}

function injectJn50203Dying(
  state: MatchState,
  owner: PlayerId,
  victim: PlayerId,
): MatchState {
  const claimed = new Set(["xyy.card.jp01@1", "xyy.card.wq01@47"]);
  const prepared: MatchState = {
    ...state,
    phase: "playing",
    activePlayerId: owner,
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
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          heroId: player.id === owner ? "xyy.hero.xj402" : player.heroId,
          alive: true,
          hp: player.id === victim ? 0 : player.id === owner ? 3 : player.maxHp,
          maxHp: player.id === owner ? 7 : player.maxHp,
          hand: player.id === victim ? ["xyy.card.jp01@1"] : [],
          equipment:
            player.id === victim
              ? { weapon: "xyy.card.wq01@47", armor: null }
              : { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
  return beginDyingBatch(prepared, "network-jn50203-death", Date.now());
}

function injectJn50401(
  state: MatchState,
  owner: PlayerId,
  firstTarget: PlayerId,
): MatchState {
  const claimed = new Set([
    "xyy.card.wq01@47",
    "xyy.card.fj01@52",
    "xyy.card.wq02@48",
  ]);
  return {
    ...state,
    phase: "playing",
    activePlayerId: owner,
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
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          heroId: player.id === owner ? "xyy.hero.xj404" : player.heroId,
          alive: true,
          hp: player.id === owner ? 6 : player.maxHp,
          maxHp: player.id === owner ? 6 : player.maxHp,
          handLimit: player.id === owner ? 5 : player.handLimit,
          hand: [],
          equipment:
            player.id === owner
              ? {
                  weapon: "xyy.card.wq01@47",
                  armor: "xyy.card.fj01@52",
                }
              : player.id === firstTarget
                ? { weapon: "xyy.card.wq02@48", armor: null }
                : { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
}

function injectJn40302(
  state: MatchState,
  owner: PlayerId,
  firstTeammate: PlayerId,
  secondTeammate: PlayerId,
  opponent: PlayerId,
): MatchState {
  const claimed = new Set([
    "xyy.card.jp01@1",
    "xyy.card.jp02@2",
    "xyy.card.zp01@16",
    "xyy.card.jp03@3",
    "xyy.card.jp04@7",
  ]);
  return {
    ...state,
    phase: "playing",
    activePlayerId: owner,
    turn: {
      ...(state.turn ?? {
        number: 1,
        openedAt: 0,
        deadlineAt: 15_000,
      }),
      number: state.turn?.number ?? 1,
      phase: "action",
      usedSkillIds: [],
    },
    winner: null,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          heroId: player.id === owner ? "xyy.hero.x3w03" : player.heroId,
          team:
            player.id === owner ||
            player.id === firstTeammate ||
            player.id === secondTeammate
              ? 1
              : 2,
          alive: true,
          hp: player.maxHp,
          hand:
            player.id === owner
              ? ["xyy.card.jp01@1"]
              : player.id === firstTeammate
                ? ["xyy.card.jp02@2", "xyy.card.zp01@16"]
                : player.id === secondTeammate
                  ? ["xyy.card.jp03@3"]
                  : player.id === opponent
                    ? ["xyy.card.jp04@7"]
                    : [],
          equipment: { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
}

function injectJn10501(
  state: MatchState,
  owner: PlayerId,
  opponent: PlayerId,
): MatchState {
  const claimed = new Set([
    "xyy.card.jp01@1",
    "xyy.card.jp02@2",
    "xyy.card.zp01@16",
    "xyy.card.jp03@3",
  ]);
  return {
    ...state,
    phase: "playing",
    activePlayerId: owner,
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
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          heroId: player.id === owner ? "xyy.hero.xj105" : player.heroId,
          alive: true,
          hp: player.maxHp,
          hand:
            player.id === owner
              ? ["xyy.card.jp01@1", "xyy.card.jp02@2", "xyy.card.zp01@16"]
              : player.id === opponent
                ? ["xyy.card.jp03@3"]
                : [],
          equipment: { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
}

function injectJn10502(state: MatchState, owner: PlayerId): MatchState {
  return {
    ...state,
    phase: "playing",
    activePlayerId: owner,
    turn: {
      ...(state.turn ?? {
        number: 1,
        openedAt: 0,
        deadlineAt: 15_000,
      }),
      number: state.turn?.number ?? 1,
      phase: "action",
      usedSkillIds: [],
    },
    winner: null,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          heroId: player.id === owner ? "xyy.hero.xj105" : player.heroId,
          alive: true,
          hp: player.maxHp,
          hand: [],
          equipment: { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES,
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
}

function injectJn20601(
  state: MatchState,
  owner: PlayerId,
  firstTarget: PlayerId,
  secondTarget: PlayerId,
): MatchState {
  return {
    ...state,
    phase: "playing",
    activePlayerId: owner,
    turn: {
      ...(state.turn ?? {
        number: 1,
        openedAt: 0,
        deadlineAt: 15_000,
      }),
      number: state.turn?.number ?? 1,
      phase: "action",
      usedSkillIds: [],
      usedSkillTargetIds: {},
    },
    winner: null,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          heroId:
            player.id === owner
              ? "xyy.hero.xj206"
              : player.id === firstTarget
                ? "xyy.hero.xj105"
                : player.id === secondTarget
                  ? "xyy.hero.xj202"
                  : "xyy.hero.xj201",
          alive: true,
          hp: 4,
          hand: [],
          equipment: { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES,
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
}

function injectJn20602(state: MatchState, owner: PlayerId): MatchState {
  const transformed: MatchState = {
    ...state,
    phase: "playing",
    activePlayerId: owner,
    turn: {
      ...(state.turn ?? {
        number: 1,
        openedAt: 0,
        deadlineAt: 15_000,
      }),
      number: state.turn?.number ?? 1,
      phase: "action",
      usedSkillIds: [],
      usedSkillTargetIds: {},
    },
    winner: null,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          heroId: player.id === owner ? "xyy.hero.xj206" : "xyy.hero.xj201",
          alive: true,
          hp: player.id === owner ? 0 : 4,
          maxHp: player.id === owner ? 10 : player.maxHp,
          strength: player.id === owner ? 4 : player.strength,
          dexterity: player.id === owner ? 2 : player.dexterity,
          hand: player.id === owner ? ["xyy.card.jp01@1"] : [],
          equipment:
            player.id === owner
              ? { weapon: "xyy.card.wq01@47", armor: null }
              : { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter(
      (card) => card !== "xyy.card.jp01@1" && card !== "xyy.card.wq01@47",
    ),
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
  return beginDyingBatch(transformed, "jn20602-network-dying", 1_000);
}

function injectJn20701(
  state: MatchState,
  actor: PlayerId,
  nextPlayer: PlayerId,
): MatchState {
  const openedAt = Date.now();
  const turnOrder = Object.values(state.players)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  return {
    ...state,
    phase: "playing",
    activePlayerId: actor,
    turnOrder,
    turn: {
      number: 1,
      phase: "action",
      openedAt,
      deadlineAt: openedAt + 15_000,
      usedSkillIds: [],
    },
    winner: null,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          turnIndex: turnOrder.indexOf(player.id),
          heroId:
            player.id === nextPlayer ? "xyy.hero.xj207" : "xyy.hero.xj201",
          alive: true,
          hp: player.id === nextPlayer ? 5 : 4,
          maxHp: player.id === nextPlayer ? 5 : player.maxHp,
          strength: player.id === nextPlayer ? 8 : player.strength,
          dexterity: player.id === nextPlayer ? 2 : player.dexterity,
          handLimit: 3,
          hand: [],
          equipment: { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES,
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
}

function injectJn20702(state: MatchState, actor: PlayerId): MatchState {
  const openedAt = Date.now();
  const turnOrder = Object.values(state.players)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  return {
    ...state,
    phase: "playing",
    activePlayerId: actor,
    turnOrder,
    turn: {
      number: 1,
      phase: "action",
      openedAt,
      deadlineAt: openedAt + 15_000,
      usedSkillIds: [],
    },
    winner: null,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          turnIndex: turnOrder.indexOf(player.id),
          heroId: player.id === actor ? "xyy.hero.xj207" : "xyy.hero.xj201",
          alive: true,
          hp: player.id === actor ? 5 : 4,
          maxHp: player.id === actor ? 5 : player.maxHp,
          strength: player.id === actor ? 8 : player.strength,
          dexterity: player.id === actor ? 2 : player.dexterity,
          handLimit: 3,
          hand: player.id === actor ? ["xyy.card.tp03@39"] : [],
          equipment: { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter(
      (card) => card !== "xyy.card.tp03@39",
    ),
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
  };
}

function injectJn30201(
  state: MatchState,
  actor: PlayerId,
  target: PlayerId,
  owner: PlayerId,
): MatchState {
  const openedAt = Date.now();
  const turnOrder = Object.values(state.players)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  const claimed = new Set(["xyy.card.jp05@10", "xyy.card.jp01@1"]);
  return {
    ...state,
    phase: "playing",
    activePlayerId: actor,
    turnOrder,
    turn: {
      number: 1,
      phase: "action",
      openedAt,
      deadlineAt: openedAt + 15_000,
      usedSkillIds: [],
    },
    winner: null,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          turnIndex: turnOrder.indexOf(player.id),
          heroId: player.id === owner ? "xyy.hero.xj302" : "xyy.hero.xj201",
          alive: true,
          hp: player.id === target ? 4 : player.id === owner ? 6 : 4,
          maxHp: player.id === owner ? 6 : 4,
          strength: player.id === owner ? 2 : player.strength,
          dexterity: player.id === owner ? 4 : player.dexterity,
          handLimit: 3,
          hand:
            player.id === actor
              ? ["xyy.card.jp05@10"]
              : player.id === owner
                ? ["xyy.card.jp01@1"]
                : [],
          equipment: { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
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
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn40401(state, actor),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const jn40401Action = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: ["xyy.card.wq02@48"],
      skillId: "xyy.skill.jn40401",
      targetPlayerIds: [actor],
    };
    expect(clients[indexOf(actor)]!.latestView.availableActions).toContainEqual(
      {
        ...jn40401Action,
        requiredCardCount: 1,
        requiredTargetCount: 0,
      },
    );
    for (const [clientIndex, client] of clients.entries()) {
      if (clientIndex === indexOf(actor)) continue;
      expect(client.latestView.availableActions).not.toContainEqual(
        expect.objectContaining({
          type: "activate-hero-skill",
          skillId: "xyy.skill.jn40401",
        }),
      );
    }
    response = await send(
      clients[indexOf(actor)]!,
      sessions[indexOf(actor)]!,
      "network-jn40401-pay-weapon",
      version,
      jn40401Action,
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(
      clients[0]!.latestView.players.find((player) => player.id === actor),
    ).toMatchObject({
      hp: 3,
      handCount: 0,
      equipment: { weapon: null, armor: null },
    });
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
      clients[0]!.latestView.players.find((player) => player.id === actor),
    ).toMatchObject({
      hp: 3,
      equipment: { weapon: null, armor: null },
    });

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

  it("keeps JN50203 death loot private and deterministic across restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn50203-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn50203.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const owner = ordered[0]!.id;
    const victim = ordered[1]!.id;
    const recipient = ordered[2]!.id;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn50203Dying(state, owner, victim),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    let version = clients[0]!.latestView.version;
    let pass = 0;
    while (clients[0]!.latestView.dyingBatch?.status === "awaiting-rescue") {
      const batch = clients[0]!.latestView.dyingBatch!;
      const priority = batch.priorityOrder[batch.priorityIndex]!;
      const priorityClient = clients[indexOf(priority)]!;
      const response = await send(
        priorityClient,
        sessions[indexOf(priority)]!,
        `jn50203-rescue-pass-${pass}`,
        version,
        {
          type: "pass-rescue",
          choiceId: priorityClient.latestView.pendingChoice!.choiceId,
        },
      );
      expect(response.type).toBe("command-accepted");
      version += 1;
      await waitVersion(clients, version);
      pass += 1;
      if (pass > 6) throw new Error("JN50203 rescue window did not converge.");
    }

    const ownerClient = clients[indexOf(owner)]!;
    expect(ownerClient.latestView.dyingBatch?.status).toBe("distributing-loot");
    expect(ownerClient.latestView.pendingChoice?.optionIds).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.wq01@47",
    ]);
    expect(ownerClient.latestView.availableActions).toContainEqual({
      type: "distribute-death-loot",
      choiceId: ownerClient.latestView.pendingChoice!.choiceId,
      cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.wq01@47"],
      minCardCount: 1,
      maxCardCount: 2,
      targetPlayerIds: ordered
        .map((player) => player.id)
        .filter((playerId) => playerId !== owner && playerId !== victim),
    });
    for (const player of ordered) {
      if (player.id === owner) continue;
      const view = clients[indexOf(player.id)]!.latestView;
      expect(view.pendingChoice).toBeNull();
      expect(view.availableActions).not.toContainEqual(
        expect.objectContaining({ type: "distribute-death-loot" }),
      );
      expect(JSON.stringify(view)).not.toContain("xyy.card.jp01@1");
      expect(JSON.stringify(view)).not.toContain("xyy.card.wq01@47");
    }

    const persistedChoice = JSON.parse(
      JSON.stringify(ownerClient.latestView.pendingChoice),
    );
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    expect(clients[indexOf(owner)]!.latestView.pendingChoice).toEqual(
      persistedChoice,
    );

    let response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn50203-distribute-one",
      version,
      {
        type: "distribute-death-loot",
        choiceId: persistedChoice.choiceId,
        cardInstanceIds: ["xyy.card.jp01@1"],
        targetPlayerId: recipient,
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(
      clients[indexOf(recipient)]!.latestView.players.find(
        (player) => player.id === recipient,
      )?.hand,
    ).toEqual(["xyy.card.jp01@1"]);
    expect(
      clients[indexOf(owner)]!.latestView.pendingChoice?.optionIds,
    ).toEqual(["xyy.card.wq01@47"]);

    response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn50203-finish",
      version,
      {
        type: "finish-death-loot",
        choiceId: clients[indexOf(owner)]!.latestView.pendingChoice!.choiceId,
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    const persistedReaction = JSON.parse(
      JSON.stringify(clients[0]!.latestView.reactionWindow),
    );
    expect(persistedReaction).not.toBeNull();
    expect(clients[0]!.latestView.dyingBatch).toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    expect(clients[0]!.latestView.reactionWindow).toEqual(persistedReaction);
    version = await passReactions(
      clients,
      sessions,
      version,
      "jn50203-self-damage-pass",
    );
    expect(
      clients[0]!.latestView.players.find((player) => player.id === owner),
    ).toMatchObject({ alive: true, hp: 2, handCount: 1 });
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(["xyy.card.wq01@47"]);
    expect(
      clients[0]!.latestView.players.find((player) => player.id === victim),
    ).toMatchObject({
      alive: false,
      hp: 0,
      handCount: 0,
      equipment: { weapon: null, armor: null },
    });

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });

  it("persists repeated JN10501 teammate transfers with six-socket privacy", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn10501-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn10501.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const owner = ordered[0]!.id;
    const ownerTeam = ordered[0]!.team;
    const teammates = ordered
      .filter((player) => player.id !== owner && player.team === ownerTeam)
      .map((player) => player.id);
    const opponent = ordered.find((player) => player.team !== ownerTeam)!.id;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn10501(state, owner, opponent),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    let version = clients[0]!.latestView.version;
    expect(
      clients[indexOf(owner)]!.latestView.availableActions.find(
        (action) =>
          action.type === "activate-hero-skill" &&
          action.skillId === "xyy.skill.jn10501",
      ),
    ).toEqual({
      type: "activate-hero-skill",
      cardInstanceIds: [
        "xyy.card.jp01@1",
        "xyy.card.jp02@2",
        "xyy.card.zp01@16",
      ],
      minCardCount: 1,
      maxCardCount: 3,
      skillId: "xyy.skill.jn10501",
      targetPlayerIds: teammates,
      requiredTargetCount: 1,
    });
    for (const player of ordered) {
      if (player.id === owner) continue;
      expect(
        clients[indexOf(player.id)]!.latestView.availableActions,
      ).not.toContainEqual(
        expect.objectContaining({
          type: "activate-hero-skill",
          skillId: "xyy.skill.jn10501",
        }),
      );
    }

    let response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn10501-give-two",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.jp02@2"],
        skillId: "xyy.skill.jn10501",
        targetPlayerIds: [teammates[0]!],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(
      clients[indexOf(teammates[0]!)]!.latestView.players.find(
        (player) => player.id === teammates[0],
      )?.hand,
    ).toEqual(["xyy.card.jp01@1", "xyy.card.jp02@2"]);
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(["xyy.card.zp01@16"]);
    for (const player of ordered) {
      if (player.id === teammates[0]) continue;
      const serialized = JSON.stringify(
        clients[indexOf(player.id)]!.latestView,
      );
      expect(serialized).not.toContain("xyy.card.jp01@1");
      expect(serialized).not.toContain("xyy.card.jp02@2");
    }

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    expect(
      clients[indexOf(owner)]!.latestView.availableActions.find(
        (action) =>
          action.type === "activate-hero-skill" &&
          action.skillId === "xyy.skill.jn10501",
      ),
    ).toMatchObject({
      cardInstanceIds: ["xyy.card.zp01@16"],
      minCardCount: 1,
      maxCardCount: 1,
      targetPlayerIds: teammates,
    });

    response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn10501-opponent-rejected",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.zp01@16"],
        skillId: "xyy.skill.jn10501",
        targetPlayerIds: [opponent],
      },
    );
    expect(response).toMatchObject({
      type: "command-rejected",
      reason: "forbidden",
      currentVersion: version,
    });
    response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn10501-give-last",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.zp01@16"],
        skillId: "xyy.skill.jn10501",
        targetPlayerIds: [teammates[1]!],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(
      clients[indexOf(teammates[1]!)]!.latestView.players.find(
        (player) => player.id === teammates[1],
      )?.hand,
    ).toEqual(["xyy.card.zp01@16"]);
    expect(
      clients[indexOf(owner)]!.latestView.availableActions.some(
        (action) =>
          action.type === "activate-hero-skill" &&
          action.skillId === "xyy.skill.jn10501",
      ),
    ).toBe(false);
    expect(
      clients[indexOf(opponent)]!.latestView.players.find(
        (player) => player.id === opponent,
      )?.hand,
    ).toEqual(["xyy.card.jp03@3"]);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual([]);
    expect(
      clients[indexOf(owner)]!.latestView.availableActions.some(
        (action) =>
          action.type === "activate-hero-skill" &&
          action.skillId === "xyy.skill.jn10501",
      ),
    ).toBe(false);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });

  it("keeps JN40302 hand distribution private and times it out after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn40302-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn40302.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const owner = ordered[0]!.id;
    const firstTeammate = ordered[1]!.id;
    const secondTeammate = ordered[2]!.id;
    const opponent = ordered[3]!.id;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn40302(state, owner, firstTeammate, secondTeammate, opponent),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    let version = clients[0]!.latestView.version;
    expect(
      clients[indexOf(owner)]!.latestView.availableActions.find(
        (action) =>
          action.type === "activate-hero-skill" &&
          action.skillId === "xyy.skill.jn40302",
      ),
    ).toEqual({
      type: "activate-hero-skill",
      cardInstanceIds: [],
      requiredCardCount: 0,
      skillId: "xyy.skill.jn40302",
      targetPlayerIds: [],
      requiredTargetCount: 0,
    });
    for (const player of ordered) {
      if (player.id === owner) continue;
      expect(
        clients[indexOf(player.id)]!.latestView.availableActions,
      ).not.toContainEqual(
        expect.objectContaining({
          type: "activate-hero-skill",
          skillId: "xyy.skill.jn40302",
        }),
      );
    }

    let response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn40302-collect",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: [],
        skillId: "xyy.skill.jn40302",
        targetPlayerIds: [],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    const collectedCards = [
      "xyy.card.jp01@1",
      "xyy.card.jp02@2",
      "xyy.card.zp01@16",
      "xyy.card.jp03@3",
    ];
    const ownerView = clients[indexOf(owner)]!.latestView;
    expect(
      ownerView.players.find((player) => player.id === owner)?.hand,
    ).toEqual(collectedCards);
    expect(ownerView.pendingChoice?.optionIds).toEqual(collectedCards);
    expect(ownerView.availableActions).toContainEqual({
      type: "distribute-brother-hand",
      choiceId: ownerView.pendingChoice!.choiceId,
      cardInstanceIds: collectedCards,
      minCardCount: 1,
      maxCardCount: 4,
      targetPlayerIds: [firstTeammate, secondTeammate],
    });
    expect(ownerView.availableActions).toContainEqual({
      type: "finish-brother-hand",
      choiceId: ownerView.pendingChoice!.choiceId,
    });
    for (const player of ordered) {
      if (player.id === owner) continue;
      const view = clients[indexOf(player.id)]!.latestView;
      expect(view.pendingChoice).toBeNull();
      expect(view.availableActions).not.toContainEqual(
        expect.objectContaining({ type: "distribute-brother-hand" }),
      );
      const serialized = JSON.stringify(view);
      for (const card of collectedCards) expect(serialized).not.toContain(card);
    }
    expect(
      clients[indexOf(opponent)]!.latestView.players.find(
        (player) => player.id === opponent,
      )?.hand,
    ).toEqual(["xyy.card.jp04@7"]);

    const persistedChoice = JSON.parse(JSON.stringify(ownerView.pendingChoice));
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    expect(clients[indexOf(owner)]!.latestView.pendingChoice).toEqual(
      persistedChoice,
    );

    response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn40302-distribute-two",
      version,
      {
        type: "distribute-brother-hand",
        choiceId: persistedChoice.choiceId,
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.jp02@2"],
        targetPlayerId: secondTeammate,
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(
      clients[indexOf(secondTeammate)]!.latestView.players.find(
        (player) => player.id === secondTeammate,
      )?.hand,
    ).toEqual(["xyy.card.jp01@1", "xyy.card.jp02@2"]);
    expect(
      clients[indexOf(owner)]!.latestView.pendingChoice?.optionIds,
    ).toEqual(["xyy.card.zp01@16", "xyy.card.jp03@3"]);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) => {
      if (state.pendingChoice === null)
        throw new Error("Missing JN40302 choice before timeout restart.");
      return {
        ...state,
        pendingChoice: {
          ...state.pendingChoice,
          openedAt: Date.now() - 15_001,
          deadlineAt: Date.now() - 1,
        },
      };
    });
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    await waitVersion(clients, version + 1);
    version = clients[0]!.latestView.version;
    expect(clients[indexOf(owner)]!.latestView.pendingChoice).toBeNull();
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(["xyy.card.zp01@16", "xyy.card.jp03@3"]);
    expect(
      clients[indexOf(owner)]!.latestView.availableActions.some(
        (action) =>
          action.type === "activate-hero-skill" &&
          action.skillId === "xyy.skill.jn40302",
      ),
    ).toBe(false);

    response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn40302-repeat",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: [],
        skillId: "xyy.skill.jn40302",
        targetPlayerIds: [],
      },
    );
    expect(response).toMatchObject({
      type: "command-rejected",
      reason: "forbidden",
      currentVersion: version,
    });

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(clients[indexOf(owner)]!.latestView.pendingChoice).toBeNull();
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(["xyy.card.zp01@16", "xyy.card.jp03@3"]);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });

  it("restarts JN20601 mid-response and preserves target memory over six sockets", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn20601-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn20601.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const owner = ordered[0]!.id;
    const firstTarget = ordered[1]!.id;
    const secondTarget = ordered[2]!.id;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn20601(state, owner, firstTarget, secondTarget),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    let version = clients[0]!.latestView.version;
    expect(clients[indexOf(owner)]!.latestView.availableActions).toContainEqual(
      {
        type: "activate-hero-skill",
        cardInstanceIds: [],
        requiredCardCount: 0,
        skillId: "xyy.skill.jn20601",
        targetPlayerIds: [firstTarget, secondTarget],
        requiredTargetCount: 1,
      },
    );
    for (const player of ordered) {
      if (player.id === owner) continue;
      expect(
        clients[indexOf(player.id)]!.latestView.availableActions,
      ).not.toContainEqual(
        expect.objectContaining({
          type: "activate-hero-skill",
          skillId: "xyy.skill.jn20601",
        }),
      );
    }
    const hpBefore = Object.fromEntries(
      clients[0]!.latestView.players.map((player) => [player.id, player.hp]),
    );

    const response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn20601-first",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: [],
        skillId: "xyy.skill.jn20601",
        targetPlayerIds: [firstTarget],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(clients[0]!.latestView.reactionWindow).not.toBeNull();
    expect(
      clients[0]!.latestView.turn?.usedSkillTargetIds?.["xyy.skill.jn20601"],
    ).toEqual([firstTarget]);
    const persistedWindow = JSON.parse(
      JSON.stringify(clients[0]!.latestView.reactionWindow),
    );

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    expect(clients[0]!.latestView.reactionWindow).toEqual(persistedWindow);
    expect(
      clients[0]!.latestView.turn?.usedSkillTargetIds?.["xyy.skill.jn20601"],
    ).toEqual([firstTarget]);

    version = await passReactions(clients, sessions, version, "jn20601-pass");
    expect(clients[0]!.latestView.reactionWindow).toBeNull();
    expect(clients[0]!.latestView.turn).toMatchObject({
      number: 1,
      phase: "action",
    });
    for (const player of clients[0]!.latestView.players) {
      expect(player.hp).toBe(
        player.id === owner || player.id === firstTarget
          ? hpBefore[player.id]! - 1
          : hpBefore[player.id],
      );
      expect(player.handCount).toBe(0);
    }
    expect(clients[indexOf(owner)]!.latestView.availableActions).toContainEqual(
      expect.objectContaining({
        type: "activate-hero-skill",
        skillId: "xyy.skill.jn20601",
        targetPlayerIds: [secondTarget],
      }),
    );
    const repeated = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn20601-repeat",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: [],
        skillId: "xyy.skill.jn20601",
        targetPlayerIds: [firstTarget],
      },
    );
    expect(repeated).toMatchObject({
      type: "command-rejected",
      reason: "forbidden",
      currentVersion: version,
    });

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });

  it("restarts JN20602 mid-rescue and preserves its transformed identity and private hand", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn20602-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn20602.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const owner = ordered[0]!.id;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn20602(state, owner),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    let version = clients[0]!.latestView.version;
    expect(clients[0]!.latestView.dyingBatch).toMatchObject({
      currentTargetPlayerId: owner,
      status: "awaiting-rescue",
    });
    expect(
      clients[0]!.latestView.players.find((player) => player.id === owner),
    ).toMatchObject({ heroId: "xyy.hero.xj206", alive: true, hp: 0 });
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(["xyy.card.jp01@1"]);
    for (const player of ordered) {
      if (player.id === owner) continue;
      expect(
        JSON.stringify(clients[indexOf(player.id)]!.latestView),
      ).not.toContain("xyy.card.jp01@1");
    }

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    let pass = 0;
    while (clients[0]!.latestView.dyingBatch !== null) {
      const batch = clients[0]!.latestView.dyingBatch!;
      const priority = batch.priorityOrder[batch.priorityIndex]!;
      const response = await send(
        clients[indexOf(priority)]!,
        sessions[indexOf(priority)]!,
        `jn20602-rescue-pass-${pass}`,
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
      if (pass > 6) throw new Error("JN20602 network rescue did not converge.");
    }

    const transformed = clients[0]!.latestView.players.find(
      (player) => player.id === owner,
    );
    expect(transformed).toMatchObject({
      heroId: "xyy.hero.xj207",
      alive: true,
      hp: 5,
      maxHp: 5,
      handCount: 1,
      equipment: { weapon: "xyy.card.wq01@47", armor: null },
    });
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(["xyy.card.jp01@1"]);
    expect(clients[0]!.latestView.winner).toBeNull();

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(
      clients[0]!.latestView.players.find((player) => player.id === owner),
    ).toEqual(transformed);
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(["xyy.card.jp01@1"]);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });

  it("persists JN20701 private turn-start draw through a six-socket restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn20701-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn20701.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const actor = ordered[0]!.id;
    const nextPlayer = ordered[1]!.id;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);
    let serverOpen = true;
    const closeRunning = async () => {
      for (const client of clients) client.socket.close();
      if (serverOpen) {
        serverOpen = false;
        await running.server.closeGracefully();
      }
    };

    try {
      await closeRunning();
      rewriteSnapshot(databasePath, created.roomId, (state) =>
        injectJn20701(state, actor, nextPlayer),
      );
      running = await start(databasePath);
      serverOpen = true;
      clients = await Promise.all(
        sessions.map((session) => connect(running.wsUrl, session)),
      );
      let version = clients[0]!.latestView.version;
      const rewardCard = SETUP_CARD_INSTANCES[0]!;
      const startCard = SETUP_CARD_INSTANCES[1]!;
      const response = await send(
        clients[indexOf(actor)]!,
        sessions[indexOf(actor)]!,
        "jn20701-end-before-start",
        version,
        { type: "end-action" },
      );
      expect(response).toMatchObject({ type: "command-accepted" });
      version += 1;
      await waitVersion(clients, version);
      expect(clients[0]!.latestView).toMatchObject({
        activePlayerId: nextPlayer,
      });
      expect(clients[0]!.latestView.turn).toMatchObject({
        number: 2,
        phase: "action",
      });
      expect(
        clients[indexOf(actor)]!.latestView.players.find(
          (player) => player.id === actor,
        )?.hand,
      ).toEqual([rewardCard]);
      expect(
        clients[indexOf(nextPlayer)]!.latestView.players.find(
          (player) => player.id === nextPlayer,
        )?.hand,
      ).toEqual([startCard]);
      for (const player of ordered) {
        if (player.id === nextPlayer) continue;
        expect(
          JSON.stringify(clients[indexOf(player.id)]!.latestView),
        ).not.toContain(startCard);
      }

      await closeRunning();
      running = await start(databasePath);
      serverOpen = true;
      clients = await Promise.all(
        sessions.map((session) => connect(running.wsUrl, session)),
      );
      expect(
        clients[indexOf(nextPlayer)]!.latestView.players.find(
          (player) => player.id === nextPlayer,
        )?.hand,
      ).toEqual([startCard]);
      expect(clients[0]!.latestView).toMatchObject({
        activePlayerId: nextPlayer,
      });
      expect(clients[0]!.latestView.turn).toMatchObject({
        number: 2,
        phase: "action",
      });
      for (const player of ordered) {
        if (player.id === nextPlayer) continue;
        expect(
          JSON.stringify(clients[indexOf(player.id)]!.latestView),
        ).not.toContain(startCard);
      }
    } finally {
      await closeRunning();
    }
  });

  it("restarts JN20702 turn-end response and advances once after private TP03 prevention", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn20702-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn20702.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const actor = ordered[0]!.id;
    const nextPlayer = ordered[1]!.id;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);
    let serverOpen = true;
    const closeRunning = async () => {
      for (const client of clients) client.socket.close();
      if (serverOpen) {
        serverOpen = false;
        await running.server.closeGracefully();
      }
    };

    try {
      await closeRunning();
      rewriteSnapshot(databasePath, created.roomId, (state) =>
        injectJn20702(state, actor),
      );
      running = await start(databasePath);
      serverOpen = true;
      clients = await Promise.all(
        sessions.map((session) => connect(running.wsUrl, session)),
      );
      let version = clients[0]!.latestView.version;
      const rewardCard = SETUP_CARD_INSTANCES[0]!;
      let response = await send(
        clients[indexOf(actor)]!,
        sessions[indexOf(actor)]!,
        "jn20702-end-action",
        version,
        { type: "end-action" },
      );
      expect(response).toMatchObject({ type: "command-accepted" });
      version += 1;
      await waitVersion(clients, version);
      expect(clients[0]!.latestView.turn).toMatchObject({
        number: 1,
        phase: "turn-end",
        turnEndContinuation: { kind: "jn20702-damage" },
      });
      expect(clients[0]!.latestView.reactionWindow).not.toBeNull();
      const prevention = clients[
        indexOf(actor)
      ]!.latestView.availableActions.find(
        (action) =>
          action.type === "play-reaction-card" &&
          action.cardInstanceId === "xyy.card.tp03@39",
      );
      expect(prevention).toBeDefined();
      expect(
        clients[indexOf(actor)]!.latestView.players.find(
          (player) => player.id === actor,
        )?.hand,
      ).toEqual(["xyy.card.tp03@39", rewardCard]);
      for (const player of ordered) {
        if (player.id === actor) continue;
        const serialized = JSON.stringify(
          clients[indexOf(player.id)]!.latestView,
        );
        expect(serialized).not.toContain("xyy.card.tp03@39");
        expect(serialized).not.toContain(rewardCard);
      }

      const persistedWindow = JSON.parse(
        JSON.stringify(clients[0]!.latestView.reactionWindow),
      );
      await closeRunning();
      running = await start(databasePath);
      serverOpen = true;
      clients = await Promise.all(
        sessions.map((session) => connect(running.wsUrl, session)),
      );
      expect(clients[0]!.latestView.reactionWindow).toEqual(persistedWindow);
      version = clients[0]!.latestView.version;
      response = await send(
        clients[indexOf(actor)]!,
        sessions[indexOf(actor)]!,
        "jn20702-use-tp03",
        version,
        {
          type: "play-reaction-card",
          cardInstanceId: "xyy.card.tp03@39",
          targetEffectId: prevention!.targetEffectId,
        },
      );
      expect(response).toMatchObject({ type: "command-accepted" });
      version += 1;
      await waitVersion(clients, version);
      version = await passReactions(
        clients,
        sessions,
        version,
        "jn20702-prevention-pass",
      );
      expect(clients[0]!.latestView).toMatchObject({
        activePlayerId: nextPlayer,
      });
      expect(clients[0]!.latestView.turn).toMatchObject({
        number: 2,
        phase: "action",
      });
      expect(
        clients[0]!.latestView.players.find((player) => player.id === actor),
      ).toMatchObject({ hp: 5, handCount: 1 });
      expect(
        clients[indexOf(actor)]!.latestView.players.find(
          (player) => player.id === actor,
        )?.hand,
      ).toEqual([rewardCard]);
      expect(clients[0]!.latestView.reactionWindow).toBeNull();
      expect(clients[0]!.latestView.dyingBatch).toBeNull();

      await closeRunning();
      running = await start(databasePath);
      serverOpen = true;
      clients = await Promise.all(
        sessions.map((session) => connect(running.wsUrl, session)),
      );
      expect(clients[0]!.latestView).toMatchObject({
        activePlayerId: nextPlayer,
      });
      expect(clients[0]!.latestView.turn).toMatchObject({
        number: 2,
        phase: "action",
      });
      expect(
        clients[0]!.latestView.players.find((player) => player.id === actor),
      ).toMatchObject({ hp: 5, handCount: 1 });
    } finally {
      await closeRunning();
    }
  });

  it("restarts JN30201 at private payment and nested damage checkpoints over six sockets", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn30201-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn30201.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const actor = ordered[0]!.id;
    const target = ordered[1]!.id;
    const owner = ordered[2]!.id;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);
    let serverOpen = true;
    const closeRunning = async () => {
      for (const client of clients) client.socket.close();
      if (serverOpen) {
        serverOpen = false;
        await running.server.closeGracefully();
      }
    };

    try {
      await closeRunning();
      rewriteSnapshot(databasePath, created.roomId, (state) =>
        injectJn30201(state, actor, target, owner),
      );
      running = await start(databasePath);
      serverOpen = true;
      clients = await Promise.all(
        sessions.map((session) => connect(running.wsUrl, session)),
      );
      let version = clients[0]!.latestView.version;
      let response = await send(
        clients[indexOf(actor)]!,
        sessions[indexOf(actor)]!,
        "jn30201-play-jp05",
        version,
        {
          type: "play-card",
          cardInstanceId: "xyy.card.jp05@10",
          targetPlayerIds: [target],
        },
      );
      expect(response).toMatchObject({ type: "command-accepted" });
      version += 1;
      await waitVersion(clients, version);
      version = await passReactions(
        clients,
        sessions,
        version,
        "jn30201-original-pass",
      );
      expect(
        clients[0]!.latestView.players.find((player) => player.id === target),
      ).toMatchObject({ hp: 2 });
      expect(clients[indexOf(owner)]!.latestView.pendingChoice).toMatchObject({
        playerIds: [owner],
        prompt: "hero-skill:xyy.skill.jn30201",
        optionIds: ["xyy.card.jp01@1"],
        minSelections: 0,
        maxSelections: 1,
        fallback: "pass",
      });
      const pursuitAction = clients[
        indexOf(owner)
      ]!.latestView.availableActions.find(
        (action) => action.type === "submit-choice",
      );
      expect(pursuitAction).toMatchObject({
        type: "submit-choice",
        optionIds: ["xyy.card.jp01@1"],
      });
      for (const player of ordered) {
        if (player.id === owner) continue;
        expect(
          clients[indexOf(player.id)]!.latestView.pendingChoice,
        ).toBeNull();
        expect(
          JSON.stringify(clients[indexOf(player.id)]!.latestView),
        ).not.toContain("xyy.card.jp01@1");
      }

      const persistedChoice = JSON.parse(
        JSON.stringify(clients[indexOf(owner)]!.latestView.pendingChoice),
      );
      await closeRunning();
      running = await start(databasePath);
      serverOpen = true;
      clients = await Promise.all(
        sessions.map((session) => connect(running.wsUrl, session)),
      );
      expect(clients[indexOf(owner)]!.latestView.pendingChoice).toEqual(
        persistedChoice,
      );
      version = clients[0]!.latestView.version;
      response = await send(
        clients[indexOf(owner)]!,
        sessions[indexOf(owner)]!,
        "jn30201-pay-card",
        version,
        {
          type: "submit-choice",
          choiceId: persistedChoice.choiceId,
          selections: ["xyy.card.jp01@1"],
        },
      );
      expect(response).toMatchObject({ type: "command-accepted" });
      version += 1;
      await waitVersion(clients, version);
      expect(clients[0]!.latestView.reactionWindow).not.toBeNull();
      const persistedWindow = JSON.parse(
        JSON.stringify(clients[0]!.latestView.reactionWindow),
      );

      await closeRunning();
      running = await start(databasePath);
      serverOpen = true;
      clients = await Promise.all(
        sessions.map((session) => connect(running.wsUrl, session)),
      );
      expect(clients[0]!.latestView.reactionWindow).toEqual(persistedWindow);
      version = clients[0]!.latestView.version;
      version = await passReactions(
        clients,
        sessions,
        version,
        "jn30201-pursuit-pass",
      );
      expect(clients[0]!.latestView).toMatchObject({
        activePlayerId: actor,
      });
      expect(clients[0]!.latestView.turn).toMatchObject({
        number: 1,
        phase: "action",
      });
      expect(
        clients[0]!.latestView.players.find((player) => player.id === target),
      ).toMatchObject({ hp: 1 });
      expect(
        clients[0]!.latestView.players.find((player) => player.id === owner),
      ).toMatchObject({ handCount: 0 });
      expect(clients[0]!.latestView.pendingChoice).toBeNull();
      expect(clients[0]!.latestView.reactionWindow).toBeNull();
      expect(clients[0]!.latestView.dyingBatch).toBeNull();

      await closeRunning();
      running = await start(databasePath);
      serverOpen = true;
      clients = await Promise.all(
        sessions.map((session) => connect(running.wsUrl, session)),
      );
      expect(
        clients[0]!.latestView.players.find((player) => player.id === target),
      ).toMatchObject({ hp: 1 });
      expect(clients[0]!.latestView.pendingChoice).toBeNull();
      expect(clients[0]!.latestView.reactionWindow).toBeNull();
    } finally {
      await closeRunning();
    }
  });

  it("restarts JN10502 mid-response and preserves six private team draws", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn10502-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn10502.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const owner = ordered[0]!.id;
    const ownerTeam = ordered[0]!.team;
    const teammates = ordered
      .filter((player) => player.team === ownerTeam)
      .map((player) => player.id);
    const opponents = ordered
      .filter((player) => player.team !== ownerTeam)
      .map((player) => player.id);
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);
    const teamDraws = new Map(
      teammates.map((playerId, index) => [
        playerId,
        SETUP_CARD_INSTANCES[index]!,
      ]),
    );
    const ordinaryReward = SETUP_CARD_INSTANCES[teammates.length]!;

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn10502(state, owner),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    let version = clients[0]!.latestView.version;
    const hpBefore = Object.fromEntries(
      clients[0]!.latestView.players.map((player) => [player.id, player.hp]),
    );

    const response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn10502-end-action",
      version,
      { type: "end-action" },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(clients[0]!.latestView.turn).toMatchObject({
      phase: "reward",
      rewardContinuation: {
        kind: "jn10502-damage",
        step: "resolving-damage",
        pendingTeamDrawPlayerIds: [],
      },
    });
    expect(clients[0]!.latestView.reactionWindow).not.toBeNull();
    for (const playerId of teammates) {
      const ownView = clients[indexOf(playerId)]!.latestView;
      expect(
        ownView.players.find((player) => player.id === playerId)?.hand,
      ).toEqual([teamDraws.get(playerId)]);
      for (const [otherId, card] of teamDraws) {
        if (otherId === playerId) continue;
        expect(JSON.stringify(ownView)).not.toContain(card);
      }
      expect(JSON.stringify(ownView)).not.toContain(ordinaryReward);
    }
    for (const playerId of opponents) {
      const serialized = JSON.stringify(clients[indexOf(playerId)]!.latestView);
      for (const card of teamDraws.values()) {
        expect(serialized).not.toContain(card);
      }
      expect(serialized).not.toContain(ordinaryReward);
    }

    const persistedWindow = JSON.parse(
      JSON.stringify(clients[0]!.latestView.reactionWindow),
    );
    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(clients[0]!.latestView.version).toBeGreaterThanOrEqual(version);
    version = clients[0]!.latestView.version;
    expect(clients[0]!.latestView.reactionWindow).toEqual(persistedWindow);
    expect(clients[0]!.latestView.turn).toMatchObject({
      phase: "reward",
      rewardContinuation: {
        kind: "jn10502-damage",
        step: "resolving-damage",
        pendingTeamDrawPlayerIds: [],
      },
    });

    version = await passReactions(clients, sessions, version, "jn10502-pass");
    expect(clients[0]!.latestView.reactionWindow).toBeNull();
    expect(clients[0]!.latestView.turn).toMatchObject({
      number: 2,
      phase: "action",
    });
    for (const player of clients[0]!.latestView.players) {
      expect(player.hp).toBe(
        player.id === owner ? hpBefore[player.id] : hpBefore[player.id]! - 1,
      );
    }
    for (const playerId of teammates) {
      const ownHand = clients[indexOf(playerId)]!.latestView.players.find(
        (player) => player.id === playerId,
      )?.hand;
      expect(ownHand).toEqual(
        playerId === owner
          ? [teamDraws.get(playerId), ordinaryReward]
          : [teamDraws.get(playerId)],
      );
    }
    for (const playerId of opponents) {
      expect(
        clients[indexOf(playerId)]!.latestView.players.find(
          (player) => player.id === playerId,
        )?.hand,
      ).toEqual([]);
    }

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });

  it("persists JN50401 target memory and private draws over six sockets", async () => {
    const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-jn50401-integration-"));
    roots.push(root);
    const databasePath = join(root, "jn50401.sqlite");
    let running = await start(databasePath);
    const created = await createPlaying(running);
    let { sessions, clients } = created;
    const ordered = clients[0]!.latestView.players
      .slice()
      .sort((left, right) => left.seat - right.seat);
    const owner = ordered[0]!.id;
    const targets = ordered
      .map((player) => player.id)
      .filter((playerId) => playerId !== owner);
    const firstTarget = targets[0]!;
    const secondTarget = targets[1]!;
    const indexOf = (playerId: PlayerId) =>
      sessions.findIndex((session) => session.playerId === playerId);
    const claimed = new Set([
      "xyy.card.wq01@47",
      "xyy.card.fj01@52",
      "xyy.card.wq02@48",
    ]);
    const expectedDrawn = SETUP_CARD_INSTANCES.filter(
      (card) => !claimed.has(card),
    ).slice(0, 4);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    rewriteSnapshot(databasePath, created.roomId, (state) =>
      injectJn50401(state, owner, firstTarget),
    );
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    let version = clients[0]!.latestView.version;
    const firstAction = clients[
      indexOf(owner)
    ]!.latestView.availableActions.find(
      (action) =>
        action.type === "activate-hero-skill" &&
        action.skillId === "xyy.skill.jn50401",
    );
    expect(firstAction).toEqual({
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.wq01@47", "xyy.card.fj01@52"],
      requiredCardCount: 1,
      skillId: "xyy.skill.jn50401",
      targetPlayerIds: targets,
      requiredTargetCount: 1,
    });
    for (const player of ordered) {
      if (player.id === owner) continue;
      expect(
        clients[indexOf(player.id)]!.latestView.availableActions,
      ).not.toContainEqual(
        expect.objectContaining({
          type: "activate-hero-skill",
          skillId: "xyy.skill.jn50401",
        }),
      );
    }

    let response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn50401-first-transfer",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.wq01@47"],
        skillId: "xyy.skill.jn50401",
        targetPlayerIds: [firstTarget],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(expectedDrawn.slice(0, 2));
    expect(
      clients[0]!.latestView.players.find((player) => player.id === firstTarget)
        ?.equipment.weapon,
    ).toBe("xyy.card.wq01@47");
    for (const player of ordered) {
      if (player.id === owner) continue;
      const serialized = JSON.stringify(
        clients[indexOf(player.id)]!.latestView,
      );
      for (const card of expectedDrawn.slice(0, 2)) {
        expect(serialized).not.toContain(card);
      }
    }

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    version = clients[0]!.latestView.version;
    const resumedAction = clients[
      indexOf(owner)
    ]!.latestView.availableActions.find(
      (action) =>
        action.type === "activate-hero-skill" &&
        action.skillId === "xyy.skill.jn50401",
    );
    expect(resumedAction).toMatchObject({
      cardInstanceIds: ["xyy.card.fj01@52"],
      targetPlayerIds: targets.filter((playerId) => playerId !== firstTarget),
    });

    response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn50401-repeat-target",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.fj01@52"],
        skillId: "xyy.skill.jn50401",
        targetPlayerIds: [firstTarget],
      },
    );
    expect(response).toMatchObject({
      type: "command-rejected",
      reason: "forbidden",
      currentVersion: version,
    });
    response = await send(
      clients[indexOf(owner)]!,
      sessions[indexOf(owner)]!,
      "jn50401-second-transfer",
      version,
      {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.fj01@52"],
        skillId: "xyy.skill.jn50401",
        targetPlayerIds: [secondTarget],
      },
    );
    expect(response.type).toBe("command-accepted");
    version += 1;
    await waitVersion(clients, version);
    expect(
      clients[0]!.latestView.players.find(
        (player) => player.id === secondTarget,
      )?.equipment.armor,
    ).toBe("xyy.card.fj01@52");
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(expectedDrawn);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
    running = await start(databasePath);
    clients = await Promise.all(
      sessions.map((session) => connect(running.wsUrl, session)),
    );
    expect(clients[0]!.latestView.version).toBeGreaterThanOrEqual(version);
    expect(
      clients[indexOf(owner)]!.latestView.players.find(
        (player) => player.id === owner,
      )?.hand,
    ).toEqual(expectedDrawn);
    expect(
      clients[indexOf(owner)]!.latestView.availableActions.some(
        (action) =>
          action.type === "activate-hero-skill" &&
          action.skillId === "xyy.skill.jn50401",
      ),
    ).toBe(false);

    for (const client of clients) client.socket.close();
    await running.server.closeGracefully();
  });
});
