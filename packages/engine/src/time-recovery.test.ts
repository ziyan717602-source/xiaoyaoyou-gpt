import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type CommandEnvelope,
  type PlayerId,
} from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  createSetupMatch,
  type EngineCommand,
  type MatchState,
  type SystemDeadline,
} from "./index.js";
import { SETUP_CARD_INSTANCES, type CardInstanceId } from "./setup-content.js";

const players = Array.from({ length: 6 }, (_, index) => ({
  id: `time-player-${index + 1}`,
  nickname: `时间玩家${index + 1}`,
}));

function envelope(
  state: Readonly<MatchState>,
  playerId: PlayerId,
  commandId: string,
  command: ClientCommand,
): CommandEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    matchId: state.matchId,
    playerId,
    clientSequence: state.version + 1,
    expectedVersion: state.version,
    clientIssuedAt: 0,
    command,
  };
}

function playerCommand(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: ClientCommand,
  receivedAt: number,
): MatchState {
  const result = applyCommand(state, {
    origin: "player",
    envelope: envelope(state, playerId, commandId, command),
    serverReceivedAt: receivedAt,
  });
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  return result.state;
}

function deadline(
  state: Readonly<MatchState>,
  origin: SystemDeadline["origin"],
  prefix: string,
): SystemDeadline {
  const found = collectSystemDeadlines(state).find(
    (candidate) =>
      candidate.origin === origin && candidate.targetId.startsWith(prefix),
  );
  if (found === undefined)
    throw new Error(`Missing deadline ${origin}:${prefix}`);
  return found;
}

function systemCommand(
  state: Readonly<MatchState>,
  target: Readonly<SystemDeadline>,
): Exclude<EngineCommand, { origin: "player" | "system-presence" }> {
  return target.origin === "system-auto"
    ? {
        origin: "system-auto",
        commandId: target.id,
        matchId: state.matchId,
        expectedVersion: state.version,
        playerId: target.playerId,
        disconnectedAt: target.disconnectedAt!,
        deadlineAt: target.deadlineAt,
      }
    : {
        origin: "system-timeout",
        commandId: target.id,
        matchId: state.matchId,
        expectedVersion: state.version,
        targetId: target.targetId,
        deadlineAt: target.deadlineAt,
      };
}

function applySystem(
  state: MatchState,
  target: Readonly<SystemDeadline>,
): { readonly state: MatchState; readonly eventTypes: readonly string[] } {
  const result = applyCommand(state, systemCommand(state, target));
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  return {
    state: result.state,
    eventTypes: result.events.map((event) => event.type),
  };
}

function setup(seed: string, openedAt = 1_000): MatchState {
  return createSetupMatch({
    matchId: `time-${seed}`,
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    openedAt,
    players,
  });
}

function playing(seed: string): MatchState {
  let state = setup(seed);
  for (const playerId of state.turnOrder) {
    state = playerCommand(
      state,
      playerId,
      `choose-${playerId}`,
      {
        type: "choose-hero",
        heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
      },
      2_000,
    );
  }
  return state;
}

function arrange(
  state: MatchState,
  hands: Readonly<Record<PlayerId, readonly CardInstanceId[]>>,
): MatchState {
  const assigned = new Set(Object.values(hands).flat());
  const allCards = [
    ...state.drawPile,
    ...state.discardPile,
    ...Object.values(state.players).flatMap((player) => [
      ...player.hand,
      ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
      ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
    ]),
  ];
  return {
    ...state,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          hand: hands[player.id] ?? [],
          equipment: { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: allCards.filter((card) => !assigned.has(card)),
    discardPile: [],
  };
}

describe("M06 authoritative time and recovery", () => {
  it("accepts a player at the setup deadline, rejects after it, and chooses mandatory setup deterministically", () => {
    const state = setup("setup-boundary");
    const playerId = state.turnOrder[0]!;
    const heroId = state.setup!.offers[playerId]!.candidateHeroIds[0]!;
    const atDeadline = applyCommand(state, {
      origin: "player",
      envelope: envelope(state, playerId, "at-deadline", {
        type: "choose-hero",
        heroId,
      }),
      serverReceivedAt: 16_000,
    });
    expect(atDeadline.accepted).toBe(true);

    const afterDeadline = applyCommand(state, {
      origin: "player",
      envelope: envelope(state, playerId, "after-deadline", {
        type: "choose-hero",
        heroId,
      }),
      serverReceivedAt: 16_001,
    });
    expect(afterDeadline).toEqual({
      accepted: false,
      reason: "expired-window",
      currentVersion: state.version,
    });

    const target = deadline(state, "system-timeout", `setup:${playerId}`);
    const first = applySystem(state, target);
    const replay = applySystem(structuredClone(state), target);
    expect(replay.state).toEqual(first.state);
    expect(first.eventTypes).toEqual([
      "setup.hero-selected",
      "system.timeout-resolved",
    ]);
    expect(first.state.rng.cursor).toBeGreaterThan(state.rng.cursor);
  });

  it("does not pause the current deadline, enters auto at 60 seconds, and clears auto on reconnect", () => {
    let state = setup("presence");
    const playerId = state.turnOrder[0]!;
    const originalDeadline = state.setup!.deadlineAt;
    let result = applyCommand(state, {
      origin: "system-presence",
      commandId: "presence-disconnect",
      matchId: state.matchId,
      expectedVersion: state.version,
      playerId,
      status: "disconnected",
      occurredAt: 5_000,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error(result.reason);
    state = result.state;
    expect(state.setup!.deadlineAt).toBe(originalDeadline);
    expect(state.connections[playerId]).toMatchObject({
      status: "grace",
      disconnectedAt: 5_000,
    });

    const autoTarget = deadline(state, "system-auto", `connection:${playerId}`);
    expect(autoTarget.deadlineAt).toBe(65_000);
    state = applySystem(state, autoTarget).state;
    expect(state.connections[playerId]).toMatchObject({
      status: "auto",
      autoAt: 65_000,
    });
    expect(
      deadline(state, "system-timeout", `setup:${playerId}`).deadlineAt,
    ).toBe(state.setup!.openedAt);

    result = applyCommand(state, {
      origin: "system-presence",
      commandId: "presence-reconnect",
      matchId: state.matchId,
      expectedVersion: state.version,
      playerId,
      status: "connected",
      occurredAt: 66_000,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error(result.reason);
    state = result.state;
    expect(state.connections[playerId]).toEqual({
      status: "connected",
      disconnectedAt: null,
      autoAt: null,
    });
    expect(
      createPlayerView(state, players[1]!.id).players[0]!.connection,
    ).toBeDefined();
  });

  it("ends an optional action and deterministically satisfies mandatory discard", () => {
    let state = playing("turn-fallback");
    const actor = state.activePlayerId!;
    const beforeCursor = state.rng.cursor;
    let resolved = applySystem(
      state,
      deadline(state, "system-timeout", "turn:"),
    );
    state = resolved.state;
    expect(state.turn?.phase).toBe("discard");
    expect(resolved.eventTypes).toContain("system.timeout-resolved");

    resolved = applySystem(state, deadline(state, "system-timeout", "turn:"));
    state = resolved.state;
    expect(state.turn).toMatchObject({ number: 2, phase: "action" });
    expect(state.players[actor]!.hand).toHaveLength(3);
    expect(state.rng.cursor).toBeGreaterThan(beforeCursor);
    expect(resolved.eventTypes).toContain("turn.cards-discarded");
  });

  it("times out reaction and rescue priorities one at a time through the normal event pipeline", () => {
    let state = playing("reaction-rescue");
    const actor = state.activePlayerId!;
    const target = state.turnOrder.find((playerId) => playerId !== actor)!;
    state = arrange(state, { [actor]: ["xyy.card.jp05@10"] });
    state = {
      ...state,
      players: {
        ...state.players,
        [target]: { ...state.players[target]!, hp: 2 },
      },
    };
    state = playerCommand(
      state,
      actor,
      "play-jp05-timeout",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
      3_000,
    );
    let reactionPasses = 0;
    while (state.reactionWindow !== null) {
      const resolved = applySystem(
        state,
        deadline(state, "system-timeout", "reaction:"),
      );
      state = resolved.state;
      reactionPasses += 1;
      if (reactionPasses > 6)
        throw new Error("Reaction timeout did not converge.");
    }
    expect(state.players[target]).toMatchObject({ hp: 0, alive: true });

    let rescuePasses = 0;
    while (state.dyingBatch !== null) {
      const resolved = applySystem(
        state,
        deadline(state, "system-timeout", "rescue:"),
      );
      state = resolved.state;
      rescuePasses += 1;
      if (rescuePasses > 6) throw new Error("Rescue timeout did not converge.");
    }
    expect(state.players[target]).toMatchObject({ hp: 0, alive: false });
    expect(reactionPasses).toBeGreaterThan(0);
    expect(rescuePasses).toBeGreaterThan(0);
  });

  it("keeps all 56 physical cards conserved after timeout fallbacks", () => {
    let state = playing("conservation");
    state = applySystem(
      state,
      deadline(state, "system-timeout", "turn:"),
    ).state;
    state = applySystem(
      state,
      deadline(state, "system-timeout", "turn:"),
    ).state;
    const cards = [
      ...state.drawPile,
      ...state.discardPile,
      ...Object.values(state.players).flatMap((player) => [
        ...player.hand,
        ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
        ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
      ]),
    ];
    expect(cards).toHaveLength(SETUP_CARD_INSTANCES.length);
    expect(new Set(cards)).toEqual(new Set(SETUP_CARD_INSTANCES));
  });
});
