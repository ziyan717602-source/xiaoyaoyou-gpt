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
  beginBattleCards,
  beginMonsterOutcome,
  collectSystemDeadlines,
  reduceEvent,
  type DomainEvent,
  type MatchState,
  type PlayerView,
} from "@xiaoyaoyou/engine";
import { grantPets } from "../../packages/engine/src/testing/npc-fixture.js";
import { npcOptionsFixture } from "../../packages/engine/src/testing/npc-options-fixture.js";
import { monsterFixture } from "../../packages/engine/src/testing/monster-fixture.js";
import { npcCommand } from "../../packages/engine/src/testing/npc-fixture.js";
import { withWeaponSkillEquipment } from "../../packages/engine/src/hero-stats.js";
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
  it.each(["multi-choice", "dying", "capture-timeout"] as const)(
    "resumes real monster outcome %s across six connections and SQLite restart",
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-monster-outcome-"));
      roots.push(root);
      const databasePath = join(root, "outcome.sqlite");
      let running = await start(databasePath),
        stopped = false;
      let clients: Client[] = [];
      const stop = async () => {
        for (const c of clients) c.socket.close();
        await running.server.closeGracefully();
        clients = [];
        stopped = true;
      };
      try {
        const created = await createPlaying(running);
        clients = [...created.clients];
        await stop();
        const base = latestSnapshotState(databasePath, created.roomId);
        const at = Date.now() - 100;
        let input = monsterFixture(
          mode === "multi-choice"
            ? "xyy.monster.gl03"
            : mode === "dying"
              ? "xyy.monster.gt01"
              : "xyy.monster.gf02",
          {
            base,
            at,
            supporter: null,
            hinder: null,
          },
        );
        const actor = input.activePlayerId!;
        input = {
          ...input,
          players: {
            ...input.players,
            [actor]: {
              ...input.players[actor]!,
              strength: mode === "multi-choice" ? 0 : 100,
              hp: mode === "dying" ? 2 : input.players[actor]!.hp,
            },
          },
        };
        if (mode === "multi-choice") {
          const ids = [
            actor,
            ...input.turnOrder.filter((id) => id !== actor),
          ].slice(0, 3);
          const weapons = [
            "xyy.card.wq01@47",
            "xyy.card.wq02@48",
            "xyy.card.wq03@49",
          ] as const;
          for (const [i, id] of ids.entries()) {
            input = {
              ...input,
              drawPile: input.drawPile.filter(
                (c) =>
                  c !== weapons[i] && (i !== 0 || c !== "xyy.card.fj01@52"),
              ),
              players: {
                ...input.players,
                [id]: withWeaponSkillEquipment(input.players[id]!, {
                  weapon: weapons[i]!,
                  armor: i === 0 ? "xyy.card.fj01@52" : null,
                }),
              },
            };
          }
        }
        if (mode === "capture-timeout")
          input = grantPets(input, actor, ["xyy.monster.gf01"]);
        input = beginMonsterDebut(input, "fixture-debut", at + 3).state;
        input = beginBattleCards(input, "fixture-cards", at + 4).state;
        for (
          let i = 0;
          input.encounterState.battle!.stage === "card-window";
          i++
        ) {
          const w = input.encounterState.battle!.cardWindow!;
          const id = w.playerIds.find((id) => !w.passedPlayerIds.includes(id))!;
          const r = applyCommand(
            input,
            npcCommand(
              input,
              id,
              { type: "pass-battle", windowId: w.windowId },
              at + 5 + i,
            ),
          );
          if (!r.accepted) throw new Error(r.reason);
          input = r.state;
        }
        const opened = beginMonsterOutcome(
          input,
          "fixture-outcome",
          at + 20,
        ).state;
        const initial = {
          ...opened,
          version: base.version,
          eventSequence: base.eventSequence,
        };
        const db = new Database(databasePath),
          json = JSON.stringify(initial);
        try {
          db.prepare(
            "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE match_id = ? AND event_sequence = ?",
          ).run(
            json,
            createHash("sha256").update(json).digest("hex"),
            created.roomId,
            base.eventSequence,
          );
        } finally {
          db.close();
        }
        const read = () => latestSnapshotState(databasePath, created.roomId);
        const reconnect = async () => {
          running = await start(databasePath);
          stopped = false;
          clients = await Promise.all(
            created.sessions.map((s) => connect(running.wsUrl, s)),
          );
          await waitUntil(() =>
            clients.every((c) =>
              c.latestView.players.every(
                (p) => p.connection.status === "connected",
              ),
            ),
          );
        };
        await reconnect();
        const seen = new Set<string>();
        for (
          let n = 0;
          read().encounterState.battle!.stage !== "complete";
          n++
        ) {
          if (n > 60) throw new Error("Network outcome stalled");
          const s = read(),
            b = s.encounterState.battle!;
          const key = `${b.stage}:${s.dyingBatch?.status ?? ""}:${b.outcome!.stepIndex}:${b.outcome!.choices.filter((c) => c.selections !== null).length}`;
          if (!seen.has(key)) {
            seen.add(key);
            const deadlines = collectSystemDeadlines(s).filter(
              (d) => d.origin === "system-timeout",
            );
            await stop();
            await reconnect();
            expect(
              collectSystemDeadlines(read()).filter(
                (d) => d.origin === "system-timeout",
              ),
            ).toEqual(deadlines);
            expect(read().encounterState.battle!.outcome).toEqual(b.outcome);
          }
          for (const [i, c] of clients.entries()) {
            for (const p of c.latestView.players)
              if (p.id !== created.sessions[i]!.playerId)
                expect(p.hand).toBeNull();
          }
          if (mode === "capture-timeout") {
            await waitUntil(
              () => read().encounterState.battle!.stage === "complete",
              18000,
            );
            expect(systemTimeoutCount(databasePath, created.roomId)).toBe(1);
            expect(read().rng.cursor).toBe(initial.rng.cursor + 1);
            break;
          }
          const actions = clients.flatMap((c, index) =>
            c.latestView.availableActions.map((a) => ({ index, a })),
          );
          const e =
            actions.find(
              ({ a }) => a.type === "pass-reaction" || a.type === "pass-rescue",
            ) ?? actions.find(({ a }) => a.type === "submit-choice");
          if (!e) throw new Error(`No network outcome action at ${key}`);
          const cmd =
            e.a.type === "submit-choice"
              ? {
                  type: "submit-choice" as const,
                  choiceId: e.a.choiceId,
                  selections: e.a.optionIds.includes("xyy.card.fj01@52")
                    ? ["xyy.card.fj01@52"]
                    : e.a.optionIds.slice(0, e.a.minSelections),
                }
              : e.a.type === "pass-reaction" || e.a.type === "pass-rescue"
                ? e.a
                : null;
          if (!cmd) throw new Error("Invalid network outcome test action");
          const response = await send(
            clients[e.index]!,
            created.sessions[e.index]!,
            `outcome-network-${n}`,
            cmd,
          );
          expect(response.type).toBe("command-accepted");
          if (response.type === "command-accepted")
            await waitUntil(() =>
              clients.every((c) => c.latestView.version >= response.version),
            );
        }
        if (mode === "multi-choice") {
          expect(seen.has("outcome-choice::1:1")).toBe(true);
          expect(read().discardPile).toHaveLength(4);
        }
        if (mode === "dying") {
          expect([...seen].some((key) => key.includes("awaiting-rescue"))).toBe(
            true,
          );
          expect(read().players[actor]!.alive).toBe(false);
          // C# VS/ObtainPet does not add an alive-only filter after death.
          expect(read().encounterState.pets[actor]).toEqual([
            "xyy.monster.gt01",
          ]);
        }
        const beforeRestart = read();
        await stop();
        await reconnect();
        expect(read().encounterState).toEqual(beforeRestart.encounterState);
        expect(read().players).toEqual(beforeRestart.players);
        expect(
          persistedEventsAfter(
            databasePath,
            created.roomId,
            initial.eventSequence,
          ).reduce(reduceEvent, initial),
        ).toEqual(read());
      } finally {
        if (!stopped) await stop();
      }
    },
    30000,
  );
  it.each(["manual", "choice-timeout", "side-timeout"] as const)(
    "restores team battle windows, nested TP01 and ZP04 choice over six sockets; mode=%s",
    async (mode) => {
      const automaticChoice = mode === "choice-timeout";
      const root = mkdtempSync(join(tmpdir(), "xiaoyaoyou-battle-recovery-"));
      roots.push(root);
      const databasePath = join(root, "battle.sqlite");
      let running = await start(databasePath),
        stopped = false;
      let clients: Client[] = [];
      const stop = async () => {
        for (const c of clients) c.socket.close();
        await running.server.closeGracefully();
        clients = [];
        stopped = true;
      };
      try {
        const created = await createPlaying(running);
        clients = [...created.clients];
        await stop();
        const base = latestSnapshotState(databasePath, created.roomId);
        let input = monsterFixture("xyy.monster.gt03", {
          base,
          at: Date.now() - (mode === "side-timeout" ? 15501 : 5),
          supporter: null,
          hinder: null,
        });
        const actor = input.activePlayerId!,
          actorTeam = input.players[actor]!.team;
        const iceOwner = input.turnOrder.find((id) => id !== actor)!;
        input = {
          ...input,
          drawPile: input.drawPile.filter(
            (c) =>
              ![
                "xyy.card.zp04@25",
                "xyy.card.tp01@33",
                "xyy.card.tp01@34",
              ].includes(c),
          ),
          players: {
            ...input.players,
            [actor]: {
              ...input.players[actor]!,
              strength: 2,
              hand: ["xyy.card.zp04@25", "xyy.card.tp01@34"],
            },
            [iceOwner]: {
              ...input.players[iceOwner]!,
              hand: ["xyy.card.tp01@33"],
            },
          },
        };
        const debuted = beginMonsterDebut(
          input,
          "fixture-debut",
          input.turn!.openedAt + 3,
        ).state;
        const opened = beginBattleCards(
          debuted,
          "fixture-cards",
          input.turn!.openedAt + 4,
        ).state;
        const initial = {
          ...opened,
          version: base.version,
          eventSequence: base.eventSequence,
        };
        const database = new Database(databasePath),
          json = JSON.stringify(initial);
        try {
          database
            .prepare(
              "UPDATE snapshots SET state_json = ?, state_hash = ? WHERE match_id = ? AND event_sequence = ?",
            )
            .run(
              json,
              createHash("sha256").update(json).digest("hex"),
              created.roomId,
              base.eventSequence,
            );
        } finally {
          database.close();
        }
        const read = () => latestSnapshotState(databasePath, created.roomId);
        const reconnect = async () => {
          running = await start(databasePath);
          stopped = false;
          clients = await Promise.all(
            created.sessions.map((s) => connect(running.wsUrl, s)),
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
        await reconnect();
        if (mode === "side-timeout") {
          await waitUntil(
            () => systemTimeoutCount(databasePath, created.roomId) === 3,
          );
          const afterTimeout = read();
          expect(
            afterTimeout.encounterState.battle!.cardWindow!.sideTeam,
          ).not.toBe(actorTeam);
          expect(afterTimeout.encounterState.battle!.cardWindow!.openedAt).toBe(
            initial.encounterState.battle!.cardWindow!.deadlineAt,
          );
          const timeoutEvents = persistedEventsAfter(
            databasePath,
            created.roomId,
            initial.eventSequence,
          ).filter((e) => e.type === "system.timeout-resolved");
          expect(
            new Set(timeoutEvents.map((e) => e.payload.targetId)).size,
          ).toBe(3);
          await stop();
          await reconnect();
          expect(systemTimeoutCount(databasePath, created.roomId)).toBe(3);
          expect(read().encounterState.battle).toEqual(
            afterTimeout.encounterState.battle,
          );
          for (let i = 0; i < 3; i++) {
            const w = read().encounterState.battle!.cardWindow!;
            const id = w.playerIds.find(
              (id) => !w.passedPlayerIds.includes(id),
            )!;
            expect(
              (
                await submit(id, `after-side-timeout-${i}`, {
                  type: "pass-battle",
                  windowId: w.windowId,
                })
              ).type,
            ).toBe("command-accepted");
          }
          expect(read().encounterState.battle!.stage).toBe("outcome-ready");
          expect(
            persistedEventsAfter(
              databasePath,
              created.roomId,
              initial.eventSequence,
            ).reduce(reduceEvent, initial),
          ).toEqual(read());
          return;
        }
        const w = read().encounterState.battle!.cardWindow!;
        expect(w).toEqual(initial.encounterState.battle!.cardWindow);
        const teammates = w.playerIds.filter((id) => id !== actor);
        const competing = await Promise.all(
          teammates.map((id, i) =>
            submit(id, `battle-compete-${i}`, {
              type: "pass-battle",
              windowId: w.windowId,
            }),
          ),
        );
        expect(
          competing.filter((x) => x.type === "command-accepted"),
        ).toHaveLength(1);
        expect(
          competing.filter((x) => x.type === "command-rejected"),
        ).toHaveLength(1);
        const passedWindow = read().encounterState.battle!.cardWindow;
        await stop();
        await reconnect();
        expect(read().encounterState.battle!.cardWindow).toEqual(passedWindow);
        for (const [i, c] of clients.entries()) {
          const viewer = created.sessions[i]!.playerId;
          if (viewer !== actor)
            expect(JSON.stringify(c.latestView)).not.toContain(
              "xyy.card.zp04@25",
            );
          if (viewer !== iceOwner)
            expect(JSON.stringify(c.latestView)).not.toContain(
              "xyy.card.tp01@33",
            );
          expect(c.latestView.encounter.battle!.cardWindow!.sideTeam).toBe(
            actorTeam,
          );
        }
        const outsider = input.turnOrder.find(
          (id) => input.players[id]!.team !== actorTeam,
        )!;
        const beforeInvalid = read();
        expect(
          (
            await submit(outsider, "battle-forbidden", {
              type: "play-battle-card",
              cardInstanceId: "xyy.card.zp04@25",
              windowId: w.windowId,
            })
          ).type,
        ).toBe("command-rejected");
        expect(read()).toEqual(beforeInvalid);
        const play: ClientCommand = {
          type: "play-battle-card",
          cardInstanceId: "xyy.card.zp04@25",
          windowId: w.windowId,
        };
        expect((await submit(actor, "battle-play", play)).type).toBe(
          "command-accepted",
        );
        const responseWindow = read().reactionWindow;
        await stop();
        await reconnect();
        expect(read().reactionWindow).toEqual(responseWindow);
        let counterNo = 0;
        for (const [owner, card] of [
          [iceOwner, "xyy.card.tp01@33"],
          [actor, "xyy.card.tp01@34"],
        ] as const) {
          for (
            let i = 0;
            read().reactionWindow!.priorityOrder[
              read().reactionWindow!.priorityIndex
            ] !== owner;
            i++
          ) {
            if (i > 6) throw new Error("Missing battle counter priority");
            const r = read().reactionWindow!;
            expect(
              (
                await submit(
                  r.priorityOrder[r.priorityIndex]!,
                  `battle-counter-pass-${counterNo}-${i}`,
                  { type: "pass-reaction", windowId: r.windowId },
                )
              ).type,
            ).toBe("command-accepted");
          }
          expect(
            (
              await submit(owner, `battle-counter-${counterNo++}`, {
                type: "play-reaction-card",
                cardInstanceId: card,
                targetEffectId: read().reactionWindow!.effectId,
              })
            ).type,
          ).toBe("command-accepted");
          const nested = read();
          await stop();
          await reconnect();
          expect(read().reactionWindow).toEqual(nested.reactionWindow);
          expect(read().effectStack).toEqual(nested.effectStack);
        }
        for (let i = 0; read().reactionWindow !== null; i++) {
          if (i > 20) throw new Error("Battle responses stalled");
          const r = read().reactionWindow!;
          expect(
            (
              await submit(
                r.priorityOrder[r.priorityIndex]!,
                `battle-final-response-${i}`,
                { type: "pass-reaction", windowId: r.windowId },
              )
            ).type,
          ).toBe("command-accepted");
        }
        const choosing = read();
        expect(choosing.pendingChoice!.optionIds).toEqual(["team:1", "team:2"]);
        const timeoutBefore = systemTimeoutCount(databasePath, created.roomId);
        await stop();
        await reconnect();
        expect(read().pendingChoice).toEqual(choosing.pendingChoice);
        if (automaticChoice) {
          await waitUntil(() => read().pendingChoice === null, 18000);
          expect(read().rng.cursor).toBe(choosing.rng.cursor + 1);
          expect(systemTimeoutCount(databasePath, created.roomId)).toBe(
            timeoutBefore + 1,
          );
        } else {
          expect(
            (
              await submit(actor, "battle-team-choice", {
                type: "submit-choice",
                choiceId: choosing.pendingChoice!.choiceId,
                selections: [`team:${actorTeam}`],
              })
            ).type,
          ).toBe("command-accepted");
        }
        const afterChoice = read();
        expect(
          afterChoice.encounterState.battle!.remainingCardQuota[actor],
        ).toBe(0);
        expect(await submit(actor, "battle-play", play)).toMatchObject({
          type: "command-accepted",
          duplicate: true,
        });
        expect(read()).toEqual(afterChoice);
        for (
          let i = 0;
          read().encounterState.battle!.stage === "card-window";
          i++
        ) {
          if (i > 6) throw new Error("Battle side passes stalled");
          const window = read().encounterState.battle!.cardWindow!;
          const owner = window.playerIds.find(
            (id) => !window.passedPlayerIds.includes(id),
          )!;
          expect(
            (
              await submit(owner, `battle-side-pass-${i}`, {
                type: "pass-battle",
                windowId: window.windowId,
              })
            ).type,
          ).toBe("command-accepted");
        }
        const finished = read();
        expect(finished.encounterState.battle!.stage).toBe("outcome-ready");
        expect(finished.encounterState.resolution!.heldCardId).toBe(
          "xyy.monster.gt03",
        );
        expect(
          finished.discardPile.filter((c) => c === "xyy.card.zp04@25"),
        ).toHaveLength(1);
        expect(
          persistedEventsAfter(
            databasePath,
            created.roomId,
            initial.eventSequence,
          ).reduce(reduceEvent, initial),
        ).toEqual(finished);
        await stop();
        await reconnect();
        const restored = read();
        expect(restored.encounterState).toEqual(finished.encounterState);
        expect(restored.rng).toEqual(finished.rng);
        expect(systemTimeoutCount(databasePath, created.roomId)).toBe(
          timeoutBefore + (automaticChoice ? 1 : 0),
        );
        expect(
          persistedEventsAfter(
            databasePath,
            created.roomId,
            initial.eventSequence,
          ).reduce(reduceEvent, initial),
        ).toEqual(restored);
      } finally {
        if (!stopped) await stop();
      }
    },
    45000,
  );
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
