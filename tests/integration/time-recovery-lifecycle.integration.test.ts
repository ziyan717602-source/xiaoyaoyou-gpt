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
  applyCommand,
  beginNpcOptions,
  beginMonsterDebut,
  collectSystemDeadlines,
  reduceEvent,
  type DomainEvent,
  type MatchState,
  type PlayerView,
} from "@xiaoyaoyou/engine";
import { grantPets } from "../../packages/engine/src/testing/npc-fixture.js";
import { npcOptionsFixture } from "../../packages/engine/src/testing/npc-options-fixture.js";
import { monsterFixture } from "../../packages/engine/src/testing/monster-fixture.js";
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

function persistedEventsAfter(
  databasePath: string,
  matchId: string,
  sequence: number,
): DomainEvent[] {
  const database = new Database(databasePath, { readonly: true });
  try {
    const rows = database
      .prepare(
        `SELECT sequence, event_id, command_id, causation_event_id, type,
              ruleset_version, payload_json FROM events
       WHERE match_id = ? AND sequence > ? ORDER BY sequence`,
      )
      .all(matchId, sequence) as Array<{
      sequence: number;
      event_id: string;
      command_id: string;
      causation_event_id: string | null;
      type: string;
      ruleset_version: string;
      payload_json: string;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      eventId: row.event_id,
      causationCommandId: row.command_id,
      causationEventId: row.causation_event_id,
      type: row.type,
      matchId,
      rulesetVersion: row.ruleset_version,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  } finally {
    database.close();
  }
}

describe("M06 time/recovery over six real WebSockets", () => {
  it.each([false, true])(
    "restores actual GH04 reaction and rescue windows, overdue=%s, retaining source, deadlines, privacy and exact event replay",
    async (overdue) => {
      const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-monster-recovery-"));
      roots.push(root);
      const databasePath = join(root, "monster.sqlite");
      let running = await start(databasePath);
      let clients: Client[] = [];
      let stopped = false;
      const stop = async () => {
        for (const client of clients) client.socket.close();
        await running.server.closeGracefully();
        clients = [];
        stopped = true;
      };
      try {
        const created = await createPlaying(running);
        clients = [...created.clients];
        await stop();
        const base = latestSnapshotState(databasePath, created.roomId);
        let input = monsterFixture("xyy.monster.gh04", {
          base,
          at: Date.now() - (overdue ? 15_501 : 5),
          seed: "monster-network",
        });
        const victim = input.turnOrder[0]!,
          rescuer = input.turnOrder[1]!;
        const rescueCard = "xyy.card.tp02@36" as const;
        input = {
          ...input,
          drawPile: input.drawPile.filter((c) => c !== rescueCard),
          players: {
            ...input.players,
            [victim]: { ...input.players[victim]!, hp: 1 },
            [rescuer]: { ...input.players[rescuer]!, hand: [rescueCard] },
          },
        };
        const opened = beginMonsterDebut(
          input,
          "fixture-monster",
          input.turn!.openedAt + 3,
        ).state;
        const initial: MatchState = {
          ...opened,
          version: base.version,
          eventSequence: base.eventSequence,
        };
        const initialWindow = initial.reactionWindow!;
        expect(initialWindow.deadlineAt - initialWindow.openedAt).toBe(15_000);
        const stateJson = JSON.stringify(initial);
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
          await waitUntil(() =>
            clients.every((c) =>
              c.latestView.players.every(
                (p) => p.connection.status === "connected",
              ),
            ),
          );
        };
        const submit = async (
          owner: string,
          id: string,
          command: ClientCommand,
        ) => {
          const index = created.sessions.findIndex((s) => s.playerId === owner);
          const response = await send(
            clients[index]!,
            created.sessions[index]!,
            id,
            command,
          );
          if (response.type === "command-accepted")
            await waitUntil(() =>
              clients.every((c) => c.latestView.version >= response.version),
            );
          return response;
        };
        const read = () => latestSnapshotState(databasePath, created.roomId);
        const countBefore = systemTimeoutCount(databasePath, created.roomId);
        await reconnect();
        if (overdue) {
          await waitUntil(
            () =>
              systemTimeoutCount(databasePath, created.roomId) ===
              countBefore + 1,
          );
          expect(read().reactionWindow?.passedPlayerIds).toEqual([
            initialWindow.priorityOrder[0],
          ]);
        } else expect(read().reactionWindow).toEqual(initialWindow);
        let state = read();
        for (const [i, client] of clients.entries()) {
          if (created.sessions[i]!.playerId !== rescuer)
            expect(JSON.stringify(client.latestView)).not.toContain(rescueCard);
          expect(client.latestView.encounter.battle).toMatchObject({
            monsterId: "xyy.monster.gh04",
            stage: "debut-damage",
          });
        }
        expect(state.effectStack[0]!.payload.damageItems).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sourcePlayerId: null,
              sourceMonsterId: "xyy.monster.gh04",
              element: "fire",
            }),
          ]),
        );
        const priority =
          state.reactionWindow!.priorityOrder[
            state.reactionWindow!.priorityIndex
          ]!;
        const outsider = state.turnOrder.find((id) => id !== priority)!;
        expect(
          (
            await submit(outsider, "monster-forbidden", {
              type: "pass-reaction",
              windowId: state.reactionWindow!.windowId,
            })
          ).type,
        ).toBe("command-rejected");
        expect(read()).toEqual(state);
        // Restart a non-expired response window, not merely its JSON value.
        const responseWindow = state.reactionWindow;
        await stop();
        await reconnect();
        expect(read().reactionWindow).toEqual(responseWindow);
        for (let n = 0; read().reactionWindow !== null; n++) {
          if (n > 8) throw new Error("Monster response did not finish");
          state = read();
          const w = state.reactionWindow!;
          expect(
            (
              await submit(
                w.priorityOrder[w.priorityIndex]!,
                `monster-pass-${n}`,
                { type: "pass-reaction", windowId: w.windowId },
              )
            ).type,
          ).toBe("command-accepted");
        }
        const dying = read();
        expect(dying.dyingBatch?.currentTargetPlayerId).toBe(victim);
        expect(dying.players[victim]!.hp).toBe(0);
        expect(dying.encounterState.battle!.stage).toBe("debut-damage");
        await stop();
        await reconnect();
        expect(read().pendingChoice).toEqual(dying.pendingChoice);
        expect(read().dyingBatch).toEqual(dying.dyingBatch);
        for (let n = 0; read().pendingChoice!.playerIds[0] !== rescuer; n++) {
          if (n > 6) throw new Error("Missing rescue priority");
          state = read();
          expect(
            (
              await submit(
                state.pendingChoice!.playerIds[0]!,
                `monster-rescue-pass-${n}`,
                {
                  type: "pass-rescue",
                  choiceId: state.pendingChoice!.choiceId,
                },
              )
            ).type,
          ).toBe("command-accepted");
        }
        const rescue: ClientCommand = {
          type: "play-rescue-card",
          cardInstanceId: rescueCard,
          targetPlayerId: victim,
        };
        expect((await submit(rescuer, "monster-rescue", rescue)).type).toBe(
          "command-accepted",
        );
        const finished = read();
        expect(finished.players[victim]).toMatchObject({ alive: true, hp: 2 });
        expect(finished.encounterState.battle!.stage).toBe("combat-ready");
        expect(finished.encounterState.resolution!.heldCardId).toBe(
          "xyy.monster.gh04",
        );
        expect(finished.pendingChoice).toBeNull();
        expect(finished.dyingBatch).toBeNull();
        const persisted = persistedEventsAfter(
          databasePath,
          created.roomId,
          initial.eventSequence,
        );
        expect(persisted.reduce(reduceEvent, initial)).toEqual(finished);
        expect(
          persisted.filter((e) => e.type === "monster.debut"),
        ).toHaveLength(1);
        const rescueEvents = persisted.filter(
          (e) => e.causationCommandId === "monster-rescue",
        );
        expect(
          new Set(rescueEvents.map((e) => e.payload.matchVersion)).size,
        ).toBe(1);
        expect(await submit(rescuer, "monster-rescue", rescue)).toMatchObject({
          type: "command-accepted",
          duplicate: true,
        });
        expect(read()).toEqual(finished);
        await stop();
        await reconnect();
        expect(read().encounterState).toEqual(finished.encounterState);
        expect(read().players).toEqual(finished.players);
        expect(read().rng).toEqual(finished.rng);
        expect(systemTimeoutCount(databasePath, created.roomId)).toBe(
          countBefore + (overdue ? 1 : 0),
        );
      } finally {
        if (!stopped) await stop();
      }
    },
  );
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
        let input = npcOptionsFixture(
          heroJoin
            ? "xyy.npc.nc106"
            : petExchange
              ? "xyy.npc.nc103"
              : "xyy.npc.nc104",
          undefined,
          { base, at: Date.now(), seed: "npc-network" },
        );
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
        const prepared = beginNpcOptions(
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
        const actionWindow = clients[indexOf(actor)]!.latestView.pendingChoice!;
        const beforeAction = latestSnapshotState(databasePath, created.roomId);
        expect(actionWindow.optionIds).toContain(actionId);
        for (const [i, client] of clients.entries()) {
          expect(client.latestView.encounter.resolution).toMatchObject({
            stage: "npc-choice",
            decisionOwnerPlayerId: actor,
          });
          expect(client.latestView.encounter.resolution).not.toHaveProperty(
            "availableActions",
          );
          if (created.sessions[i]!.playerId !== actor) {
            expect(client.latestView.pendingChoice).toBeNull();
            expect(client.latestView.availableActions).toEqual([]);
          }
          if (created.sessions[i]!.playerId !== donor)
            for (const card of hand)
              expect(JSON.stringify(client.latestView)).not.toContain(card);
        }
        await stop();
        await reconnect();
        expect(clients[indexOf(actor)]!.latestView.pendingChoice).toEqual(
          actionWindow,
        );
        expect(latestSnapshotState(databasePath, created.roomId).rng).toEqual(
          beforeAction.rng,
        );
        expect(
          (
            await submit(
              donor,
              "npc-action-wrong-owner",
              [actionId],
              actionWindow.choiceId,
            )
          ).type,
        ).toBe("command-rejected");
        expect(
          (
            await submit(actor, "npc-action-unavailable", [
              "xyy.npc-action.nj08",
            ])
          ).type,
        ).toBe("command-rejected");
        const beforeSelection = latestSnapshotState(
          databasePath,
          created.roomId,
        );
        expect(
          (await submit(actor, "npc-select-action", [actionId])).type,
        ).toBe("command-accepted");
        const afterAction = latestSnapshotState(databasePath, created.roomId);
        expect(afterAction.version).toBe(beforeSelection.version + 1);
        expect(afterAction.eventSequence).toBe(
          beforeSelection.eventSequence + 2,
        );
        const actionEvents = persistedEventsAfter(
          databasePath,
          created.roomId,
          beforeSelection.eventSequence,
        );
        expect(actionEvents.map((event) => event.type)).toEqual([
          "npc-options.operation",
          "npc.operation",
        ]);
        expect(actionEvents.reduce(reduceEvent, beforeSelection)).toEqual(
          afterAction,
        );
        expect(afterAction.encounterState.npc?.stage).toBe("donor");
        expect(
          await submit(
            actor,
            "npc-select-action",
            [actionId],
            actionWindow.choiceId,
          ),
        ).toMatchObject({ type: "command-accepted", duplicate: true });
        expect(latestSnapshotState(databasePath, created.roomId)).toEqual(
          afterAction,
        );
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
  it.each([false, true])(
    "restores an overdue NPC action window (mandatory=%s), resolves it once and replays the persisted events",
    async (mandatory) => {
      const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-npc-timeout-"));
      roots.push(root);
      const databasePath = join(root, "npc-timeout.sqlite");
      let running = await start(databasePath);
      let clients: Client[] = [];
      let stopped = false;
      const stop = async () => {
        for (const client of clients) client.socket.close();
        await running.server.closeGracefully();
        clients = [];
        stopped = true;
      };
      try {
        const created = await createPlaying(running);
        clients = [...created.clients];
        await stop();
        const base = latestSnapshotState(databasePath, created.roomId);
        // Age a complete, internally consistent 15-second window. Only this
        // initial scenario is injected; the running service owns all timeouts.
        let input = npcOptionsFixture(
          "xyy.npc.nc106",
          mandatory ? [] : ["xyy.monster.gs01"],
          {
            base,
            at: Date.now() - 15_501,
            seed: "npc-overdue-window",
          },
        );
        const actor = input.activePlayerId!;
        input = {
          ...input,
          drawPile: input.drawPile.slice(2),
          players: {
            ...input.players,
            [actor]: {
              ...input.players[actor]!,
              hand: input.drawPile.slice(0, 2),
            },
          },
        };
        const opened = beginNpcOptions(
          input,
          "fixture-overdue-npc",
          input.turn!.openedAt + 1,
        ).state;
        const initial: MatchState = {
          ...opened,
          version: base.version,
          eventSequence: base.eventSequence,
        };
        const choice = initial.pendingChoice!;
        expect(choice.deadlineAt - choice.openedAt).toBe(15_000);
        expect(choice.optional).toBe(!mandatory);
        expect(choice.optionIds).toEqual([
          "xyy.npc-action.nj01",
          "xyy.npc-action.nj04",
        ]);
        const deadline = collectSystemDeadlines(initial).find(
          (d) => d.origin === "system-timeout",
        )!;
        const expected = applyCommand(initial, {
          origin: "system-timeout",
          commandId: deadline.id,
          matchId: initial.matchId,
          expectedVersion: initial.version,
          targetId: deadline.targetId,
          deadlineAt: deadline.deadlineAt,
        });
        if (!expected.accepted) throw new Error(expected.reason);
        const stateJson = JSON.stringify(initial);
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
        const before = systemTimeoutCount(databasePath, created.roomId);
        const reconnect = async () => {
          running = await start(databasePath);
          stopped = false;
          clients = await Promise.all(
            created.sessions.map((session) => connect(running.wsUrl, session)),
          );
          await waitUntil(() =>
            clients.every((client) =>
              client.latestView.players.every(
                (player) => player.connection.status === "connected",
              ),
            ),
          );
        };
        await reconnect();
        await waitUntil(
          () => systemTimeoutCount(databasePath, created.roomId) === before + 1,
        );
        const resolved = latestSnapshotState(databasePath, created.roomId);
        expect(resolved.encounterState).toEqual(expected.state.encounterState);
        expect(resolved.players).toEqual(expected.state.players);
        expect(resolved.encounterDeck).toEqual(expected.state.encounterDeck);
        expect(resolved.encounterDiscard).toEqual(
          expected.state.encounterDiscard,
        );
        expect(resolved.pendingChoice).toEqual(expected.state.pendingChoice);
        expect(resolved.rng).toEqual(expected.state.rng);
        expect(resolved.rng.cursor - initial.rng.cursor).toBe(
          mandatory ? 1 : 0,
        );
        if (!mandatory)
          expect(resolved.encounterState.resolution).toMatchObject({
            stage: "monster-effects",
            heldCardId: "xyy.monster.gs01",
          });
        const persisted = persistedEventsAfter(
          databasePath,
          created.roomId,
          initial.eventSequence,
        );
        expect(persisted.reduce(reduceEvent, initial)).toEqual(resolved);
        const timeoutEvents = persisted.filter(
          (event) => event.causationCommandId === deadline.id,
        );
        expect(timeoutEvents.map((event) => event.type)).toEqual(
          mandatory
            ? [
                "npc-options.operation",
                "npc.operation",
                "system.timeout-resolved",
              ]
            : ["npc-options.operation", "system.timeout-resolved"],
        );
        expect(
          new Set(timeoutEvents.map((event) => event.payload.matchVersion))
            .size,
        ).toBe(1);
        const actorIndex = created.sessions.findIndex(
          (session) => session.playerId === actor,
        );
        expect(
          (
            await send(
              clients[actorIndex]!,
              created.sessions[actorIndex]!,
              "stale-npc-action",
              {
                type: "submit-choice",
                choiceId: choice.choiceId,
                selections: [choice.optionIds[0]!],
              },
            )
          ).type,
        ).toBe("command-rejected");
        expect(latestSnapshotState(databasePath, created.roomId)).toEqual(
          resolved,
        );
        await stop();
        await reconnect();
        const restarted = latestSnapshotState(databasePath, created.roomId);
        expect(restarted.encounterState).toEqual(resolved.encounterState);
        expect(restarted.pendingChoice).toEqual(resolved.pendingChoice);
        expect(restarted.players).toEqual(resolved.players);
        expect(restarted.rng).toEqual(resolved.rng);
        expect(systemTimeoutCount(databasePath, created.roomId)).toBe(
          before + 1,
        );
        expect(
          persistedEventsAfter(
            databasePath,
            created.roomId,
            initial.eventSequence,
          ).reduce(reduceEvent, initial),
        ).toEqual(restarted);
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
