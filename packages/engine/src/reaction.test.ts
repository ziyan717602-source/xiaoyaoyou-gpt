import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  createSetupMatch,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  type ApplyCommandResult,
  type CardInstanceId,
  type MatchState,
} from "./index.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `p${index + 1}`,
  nickname: `玩家 ${index + 1}`,
}));

function envelope(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
): CommandEnvelope {
  return {
    protocolVersion: 1,
    commandId,
    matchId: state.matchId,
    playerId,
    clientSequence: state.version,
    expectedVersion: state.version,
    clientIssuedAt: 999_999_999,
    command,
  };
}

function applyPlayer(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
  serverReceivedAt: number,
): ApplyCommandResult {
  return applyCommand(state, {
    origin: "player",
    envelope: envelope(state, playerId, commandId, command),
    serverReceivedAt,
  });
}

function accepted(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
  serverReceivedAt: number,
): MatchState {
  const result = applyPlayer(
    state,
    playerId,
    commandId,
    command,
    serverReceivedAt,
  );
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  let replayed = state;
  for (const event of result.events) replayed = reduceEvent(replayed, event);
  expect(replayed).toEqual(result.state);
  return result.state;
}

function playing(seed = "m04-reaction-seed"): MatchState {
  let state = createSetupMatch({
    matchId: `m04-${seed}`,
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    players: seats,
  });
  for (const playerId of state.turnOrder) {
    state = accepted(
      state,
      playerId,
      `choose-${playerId}`,
      {
        type: "choose-hero",
        heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
      },
      0,
    );
  }
  return state;
}

function clockwiseAfter(state: MatchState, sourceId: PlayerId): PlayerId[] {
  const ordered = Object.values(state.players)
    .filter((player) => player.alive)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  const sourceIndex = ordered.indexOf(sourceId);
  return Array.from(
    { length: ordered.length - 1 },
    (_, offset) => ordered[(sourceIndex + offset + 1) % ordered.length]!,
  );
}

function arrangeForCounters(state: MatchState): {
  readonly state: MatchState;
  readonly actor: PlayerId;
  readonly first: PlayerId;
  readonly second: PlayerId;
  readonly third: PlayerId;
} {
  const actor = state.activePlayerId!;
  const [first, second, third] = clockwiseAfter(state, actor);
  const hands: Record<PlayerId, readonly CardInstanceId[]> = {
    [actor]: ["xyy.card.jp04@7"],
    [first!]: ["xyy.card.tp01@33"],
    [second!]: ["xyy.card.tp01@34"],
    [third!]: ["xyy.card.tp01@35"],
  };
  const claimed = new Set(Object.values(hands).flat());
  return {
    state: {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          { ...player, hand: hands[player.id] ?? [] },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    },
    actor,
    first: first!,
    second: second!,
    third: third!,
  };
}

function begin(state: MatchState, actor: PlayerId, now = 1_000): MatchState {
  return accepted(
    state,
    actor,
    "play-original",
    {
      type: "play-card",
      cardInstanceId: "xyy.card.jp04@7",
      targetPlayerIds: [actor],
    },
    now,
  );
}

function passAll(
  state: MatchState,
  prefix: string,
  startNow: number,
): MatchState {
  const windowId = state.reactionWindow?.windowId;
  if (windowId === undefined) throw new Error("Missing reaction window.");
  let next = state;
  let index = 0;
  while (next.reactionWindow?.windowId === windowId) {
    const priority =
      next.reactionWindow.priorityOrder[next.reactionWindow.priorityIndex]!;
    next = accepted(
      next,
      priority,
      `${prefix}-${index}`,
      { type: "pass-reaction", windowId },
      startNow + index * 100,
    );
    index += 1;
    if (index > 6) throw new Error("Reaction pass loop did not close.");
  }
  return next;
}

describe("M04 serializable reaction core", () => {
  it("resolves JP01 through opaque hand slots without leaking the target hand", () => {
    const initial = playing("jp01-hidden-transfer");
    const actor = initial.activePlayerId!;
    const target = clockwiseAfter(initial, actor)[0]!;
    const claimed = new Set<CardInstanceId>([
      "xyy.card.jp01@1",
      "xyy.card.jp04@7",
      "xyy.card.jp05@10",
    ]);
    const prepared: MatchState = {
      ...initial,
      players: Object.fromEntries(
        Object.values(initial.players).map((player) => [
          player.id,
          {
            ...player,
            hand:
              player.id === actor
                ? ["xyy.card.jp01@1"]
                : player.id === target
                  ? ["xyy.card.jp04@7", "xyy.card.jp05@10"]
                  : [],
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    expect(createPlayerView(prepared, actor).availableActions).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.jp01@1",
      targetPlayerIds: [target],
    });
    expect(
      applyPlayer(
        prepared,
        actor,
        "jp01-self-target",
        {
          type: "play-card",
          cardInstanceId: "xyy.card.jp01@1",
          targetPlayerIds: [actor],
        },
        1_000,
      ),
    ).toEqual({
      accepted: false,
      reason: "forbidden",
      currentVersion: prepared.version,
    });

    let choosing = accepted(
      prepared,
      actor,
      "jp01-play",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp01@1",
        targetPlayerIds: [target],
      },
      1_000,
    );
    choosing = passAll(choosing, "jp01-pass", 2_000);
    expect(choosing.reactionWindow).toBeNull();
    expect(choosing.pendingChoice).toMatchObject({
      playerIds: [actor],
      optionIds: ["opaque-hand-slot-1", "opaque-hand-slot-2"],
      minSelections: 1,
      maxSelections: 1,
      optional: false,
      fallback: "deterministic-random",
    });
    const actorView = createPlayerView(choosing, actor);
    expect(actorView.availableActions).toEqual([
      {
        type: "submit-choice",
        choiceId: choosing.pendingChoice!.choiceId,
        optionIds: ["opaque-hand-slot-1", "opaque-hand-slot-2"],
        minSelections: 1,
        maxSelections: 1,
      },
    ]);
    expect(JSON.stringify(actorView)).not.toContain("xyy.card.jp04@7");
    expect(JSON.stringify(actorView)).not.toContain("xyy.card.jp05@10");
    for (const playerId of clockwiseAfter(choosing, actor)) {
      expect(createPlayerView(choosing, playerId).pendingChoice).toBeNull();
      expect(createPlayerView(choosing, playerId).availableActions).toEqual([]);
    }

    const resolved = accepted(
      choosing,
      actor,
      "jp01-choose-slot",
      {
        type: "submit-choice",
        choiceId: choosing.pendingChoice!.choiceId,
        selections: ["opaque-hand-slot-2"],
      },
      3_000,
    );
    expect(resolved.pendingChoice).toBeNull();
    expect(resolved.players[actor]!.hand).toEqual(["xyy.card.jp05@10"]);
    expect(resolved.players[target]!.hand).toEqual(["xyy.card.jp04@7"]);
    expect(resolved.discardPile).toContain("xyy.card.jp01@1");
  });

  it("uses deterministic RNG when the mandatory JP01 choice times out", () => {
    const initial = playing("jp01-timeout");
    const actor = initial.activePlayerId!;
    const target = clockwiseAfter(initial, actor)[0]!;
    const claimed = new Set<CardInstanceId>([
      "xyy.card.jp01@1",
      "xyy.card.jp04@7",
      "xyy.card.jp05@10",
    ]);
    let state: MatchState = {
      ...initial,
      players: Object.fromEntries(
        Object.values(initial.players).map((player) => [
          player.id,
          {
            ...player,
            hand:
              player.id === actor
                ? ["xyy.card.jp01@1"]
                : player.id === target
                  ? ["xyy.card.jp04@7", "xyy.card.jp05@10"]
                  : [],
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    state = accepted(
      state,
      actor,
      "jp01-timeout-play",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp01@1",
        targetPlayerIds: [target],
      },
      1_000,
    );
    state = passAll(state, "jp01-timeout-pass", 2_000);
    state = {
      ...state,
      connections: {
        ...state.connections,
        [actor]: {
          status: "auto",
          disconnectedAt: 0,
          autoAt: state.pendingChoice!.openedAt,
        },
      },
    };
    const deadline = collectSystemDeadlines(state).find((candidate) =>
      candidate.targetId.startsWith("choice:"),
    );
    expect(deadline).toBeDefined();
    expect(deadline!.deadlineAt).toBe(state.pendingChoice!.openedAt);
    const result = applyCommand(state, {
      origin: "system-timeout",
      commandId: "jp01-choice-timeout",
      matchId: state.matchId,
      expectedVersion: state.version,
      deadlineAt: deadline!.deadlineAt,
      targetId: deadline!.targetId,
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error(result.reason);
    let replayed = state;
    for (const event of result.events) replayed = reduceEvent(replayed, event);
    expect(replayed).toEqual(result.state);
    expect(result.state.pendingChoice).toBeNull();
    expect(result.state.players[actor]!.hand).toHaveLength(1);
    expect(result.state.players[target]!.hand).toHaveLength(1);
    expect(result.state.rng.cursor).toBeGreaterThan(state.rng.cursor);
  });

  it("does not open a JP01 hand choice when Bingxin cancels the steal", () => {
    const initial = playing("jp01-cancelled");
    const actor = initial.activePlayerId!;
    const target = clockwiseAfter(initial, actor)[0]!;
    const claimed = new Set<CardInstanceId>([
      "xyy.card.jp01@1",
      "xyy.card.jp04@7",
      "xyy.card.tp01@33",
    ]);
    let state: MatchState = {
      ...initial,
      players: Object.fromEntries(
        Object.values(initial.players).map((player) => [
          player.id,
          {
            ...player,
            hand:
              player.id === actor
                ? ["xyy.card.jp01@1"]
                : player.id === target
                  ? ["xyy.card.jp04@7", "xyy.card.tp01@33"]
                  : [],
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    state = accepted(
      state,
      actor,
      "jp01-cancel-play",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp01@1",
        targetPlayerIds: [target],
      },
      1_000,
    );
    state = accepted(
      state,
      target,
      "jp01-bingxin",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: state.effectStack[0]!.effectId,
      },
      2_000,
    );
    state = passAll(state, "jp01-cancel-pass", 3_000);
    expect(state.pendingChoice).toBeNull();
    expect(state.reactionWindow).toBeNull();
    expect(state.players[actor]!.hand).toEqual([]);
    expect(state.players[target]!.hand).toEqual(["xyy.card.jp04@7"]);
  });

  it("resolves JP06 across opaque opponent hands, visible equipment, and known self cards", () => {
    const initial = playing("jp06-card-zones");
    const actor = initial.activePlayerId!;
    const target = clockwiseAfter(initial, actor)[0]!;
    const claimed = new Set<CardInstanceId>([
      "xyy.card.jp06@13",
      "xyy.card.jp06@14",
      "xyy.card.jp04@8",
      "xyy.card.wq01@47",
    ]);
    let state: MatchState = {
      ...initial,
      players: Object.fromEntries(
        Object.values(initial.players).map((player) => [
          player.id,
          {
            ...player,
            hand:
              player.id === actor
                ? ["xyy.card.jp06@13", "xyy.card.jp06@14"]
                : player.id === target
                  ? ["xyy.card.jp04@8"]
                  : [],
            equipment:
              player.id === target
                ? { weapon: "xyy.card.wq01@47", armor: null }
                : player.equipment,
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    expect(
      createPlayerView(state, actor).availableActions.find(
        (action) =>
          action.type === "play-card" &&
          action.cardInstanceId === "xyy.card.jp06@13",
      ),
    ).toMatchObject({
      type: "play-card",
      cardInstanceId: "xyy.card.jp06@13",
      targetPlayerIds: expect.arrayContaining([actor, target]),
    });
    state = accepted(
      state,
      actor,
      "jp06-equipment-play",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp06@13",
        targetPlayerIds: [target],
      },
      1_000,
    );
    state = passAll(state, "jp06-equipment-pass", 2_000);
    expect(state.pendingChoice?.optionIds).toEqual([
      "opaque-hand-slot-1",
      "equipment:weapon",
    ]);
    state = accepted(
      state,
      actor,
      "jp06-equipment-select",
      {
        type: "submit-choice",
        choiceId: state.pendingChoice!.choiceId,
        selections: ["equipment:weapon"],
      },
      3_000,
    );
    expect(state.players[target]!.equipment.weapon).toBeNull();
    expect(state.discardPile).toContain("xyy.card.wq01@47");

    state = accepted(
      state,
      actor,
      "jp06-hand-play",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp06@14",
        targetPlayerIds: [target],
      },
      4_000,
    );
    state = passAll(state, "jp06-hand-pass", 5_000);
    expect(state.pendingChoice?.optionIds).toEqual(["opaque-hand-slot-1"]);
    expect(JSON.stringify(createPlayerView(state, actor))).not.toContain(
      "xyy.card.jp04@8",
    );
    state = accepted(
      state,
      actor,
      "jp06-hand-select",
      {
        type: "submit-choice",
        choiceId: state.pendingChoice!.choiceId,
        selections: ["opaque-hand-slot-1"],
      },
      6_000,
    );
    expect(state.players[target]!.hand).toEqual([]);
    expect(state.discardPile).toEqual(
      expect.arrayContaining([
        "xyy.card.jp06@13",
        "xyy.card.wq01@47",
        "xyy.card.jp06@14",
        "xyy.card.jp04@8",
      ]),
    );

    const selfClaimed = new Set<CardInstanceId>([
      "xyy.card.jp06@15",
      "xyy.card.jp04@7",
      "xyy.card.fj01@52",
    ]);
    let selfState: MatchState = {
      ...initial,
      players: Object.fromEntries(
        Object.values(initial.players).map((player) => [
          player.id,
          {
            ...player,
            hand:
              player.id === actor
                ? ["xyy.card.jp06@15", "xyy.card.jp04@7"]
                : [],
            equipment:
              player.id === actor
                ? { weapon: null, armor: "xyy.card.fj01@52" }
                : player.equipment,
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !selfClaimed.has(card)),
      discardPile: [],
    };
    selfState = accepted(
      selfState,
      actor,
      "jp06-self-play",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp06@15",
        targetPlayerIds: [actor],
      },
      1_000,
    );
    selfState = passAll(selfState, "jp06-self-pass", 2_000);
    expect(selfState.pendingChoice?.optionIds).toEqual([
      "own-hand:xyy.card.jp04@7",
      "equipment:armor",
    ]);
    selfState = accepted(
      selfState,
      actor,
      "jp06-self-select",
      {
        type: "submit-choice",
        choiceId: selfState.pendingChoice!.choiceId,
        selections: ["own-hand:xyy.card.jp04@7"],
      },
      3_000,
    );
    expect(selfState.players[actor]!.hand).toEqual([]);
    expect(selfState.players[actor]!.equipment.armor).toBe("xyy.card.fj01@52");
    expect(selfState.discardPile).toEqual(
      expect.arrayContaining(["xyy.card.jp06@15", "xyy.card.jp04@7"]),
    );
  });

  it("resolves JP03 team healing after responses and supports its pawn mode without a response window", () => {
    const initial = playing("jp03-team-heal");
    const actor = initial.activePlayerId!;
    const responder = clockwiseAfter(initial, actor)[0]!;
    const actorTeam = initial.players[actor]!.team;
    const allies = Object.values(initial.players)
      .filter((player) => player.alive && player.team === actorTeam)
      .sort((left, right) => left.seat - right.seat)
      .map((player) => player.id);
    const opponents = Object.values(initial.players)
      .filter((player) => player.alive && player.team !== actorTeam)
      .map((player) => player.id);
    const staffBearer = allies.find((playerId) => playerId !== actor)!;
    const claimed = new Set<CardInstanceId>([
      "xyy.card.jp03@5",
      "xyy.card.tp01@33",
      "xyy.card.wq02@48",
    ]);
    const prepared: MatchState = {
      ...initial,
      players: Object.fromEntries(
        Object.values(initial.players).map((player) => [
          player.id,
          {
            ...player,
            hp: player.maxHp - (player.id === staffBearer ? 2 : 1),
            hand:
              player.id === actor
                ? ["xyy.card.jp03@5"]
                : player.id === responder
                  ? ["xyy.card.tp01@33"]
                  : [],
            equipment:
              player.id === staffBearer
                ? { weapon: "xyy.card.wq02@48", armor: null }
                : { weapon: null, armor: null },
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    expect(createPlayerView(prepared, actor).availableActions).toEqual(
      expect.arrayContaining([
        {
          type: "play-card",
          cardInstanceId: "xyy.card.jp03@5",
          targetPlayerIds: [],
          mode: "pawn",
        },
        {
          type: "play-card",
          cardInstanceId: "xyy.card.jp03@5",
          targetPlayerIds: allies,
          mode: "primary",
        },
      ]),
    );
    expect(
      applyPlayer(
        prepared,
        actor,
        "jp03-wrong-team",
        {
          type: "play-card",
          cardInstanceId: "xyy.card.jp03@5",
          targetPlayerIds: [actor],
          mode: "primary",
        },
        1_000,
      ),
    ).toEqual({
      accepted: false,
      reason: "forbidden",
      currentVersion: prepared.version,
    });

    let healed = accepted(
      prepared,
      actor,
      "jp03-primary",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp03@5",
        targetPlayerIds: allies,
        mode: "primary",
      },
      1_000,
    );
    expect(healed.effectStack[0]).toMatchObject({
      kind: "card:xyy.card.jp03",
      targetIds: allies,
    });
    healed = passAll(healed, "jp03-pass", 2_000);
    for (const playerId of allies) {
      expect(healed.players[playerId]!.hp).toBe(
        healed.players[playerId]!.maxHp,
      );
    }
    for (const playerId of opponents) {
      expect(healed.players[playerId]!.hp).toBe(
        healed.players[playerId]!.maxHp - 1,
      );
    }

    let cancelled = accepted(
      prepared,
      actor,
      "jp03-cancelled",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp03@5",
        targetPlayerIds: allies,
        mode: "primary",
      },
      1_000,
    );
    cancelled = accepted(
      cancelled,
      responder,
      "jp03-bingxin",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: cancelled.effectStack[0]!.effectId,
      },
      2_000,
    );
    cancelled = passAll(cancelled, "jp03-cancel-pass", 3_000);
    for (const playerId of allies) {
      expect(cancelled.players[playerId]!.hp).toBe(
        cancelled.players[playerId]!.maxHp - (playerId === staffBearer ? 2 : 1),
      );
    }

    const pawned = accepted(
      prepared,
      actor,
      "jp03-pawn",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp03@5",
        targetPlayerIds: [],
        mode: "pawn",
      },
      1_000,
    );
    expect(pawned.reactionWindow).toBeNull();
    expect(pawned.players[actor]!.hand).toHaveLength(1);
    expect(pawned.players[actor]!.hand).not.toContain("xyy.card.jp03@5");
    expect(pawned.discardPile).toContain("xyy.card.jp03@5");
  });

  it("uses TP02 on self in the action phase, caps healing, allows a full-HP play, and remains cancellable", () => {
    const initial = playing("tp02-normal-heal");
    const actor = initial.activePlayerId!;
    const [responder, foreignTarget] = clockwiseAfter(initial, actor);
    const claimed = new Set<CardInstanceId>([
      "xyy.card.tp02@36",
      "xyy.card.tp01@33",
      "xyy.card.wq02@48",
    ]);
    const prepared: MatchState = {
      ...initial,
      players: Object.fromEntries(
        Object.values(initial.players).map((player) => [
          player.id,
          {
            ...player,
            hp: player.id === actor ? player.maxHp - 3 : player.hp,
            hand:
              player.id === actor
                ? ["xyy.card.tp02@36"]
                : player.id === responder
                  ? ["xyy.card.tp01@33"]
                  : [],
            equipment:
              player.id === actor
                ? { weapon: "xyy.card.wq02@48", armor: null }
                : { weapon: null, armor: null },
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };

    expect(createPlayerView(prepared, actor).availableActions).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.tp02@36",
      targetPlayerIds: [actor],
    });
    expect(
      applyPlayer(
        prepared,
        actor,
        "tp02-foreign-target",
        {
          type: "play-card",
          cardInstanceId: "xyy.card.tp02@36",
          targetPlayerIds: [foreignTarget!],
        },
        1_000,
      ),
    ).toEqual({
      accepted: false,
      reason: "forbidden",
      currentVersion: prepared.version,
    });

    let healed = accepted(
      prepared,
      actor,
      "tp02-heal",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.tp02@36",
        targetPlayerIds: [actor],
      },
      1_000,
    );
    expect(healed.effectStack[0]).toMatchObject({
      kind: "card:xyy.card.tp02",
      sourcePlayerId: actor,
      targetIds: [actor],
      status: "waiting",
    });
    healed = passAll(healed, "tp02-heal-pass", 2_000);
    expect(healed.players[actor]!.hp).toBe(healed.players[actor]!.maxHp);
    expect(healed.discardPile).toContain("xyy.card.tp02@36");

    const fullHp = {
      ...prepared,
      players: {
        ...prepared.players,
        [actor]: {
          ...prepared.players[actor]!,
          hp: prepared.players[actor]!.maxHp,
        },
      },
    };
    let wasted = accepted(
      fullHp,
      actor,
      "tp02-full-hp",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.tp02@36",
        targetPlayerIds: [actor],
      },
      1_000,
    );
    wasted = passAll(wasted, "tp02-full-pass", 2_000);
    expect(wasted.players[actor]!.hp).toBe(wasted.players[actor]!.maxHp);
    expect(wasted.discardPile).toContain("xyy.card.tp02@36");

    let cancelled = accepted(
      prepared,
      actor,
      "tp02-cancelled",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.tp02@36",
        targetPlayerIds: [actor],
      },
      1_000,
    );
    cancelled = accepted(
      cancelled,
      responder!,
      "tp02-bingxin",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: cancelled.effectStack[0]!.effectId,
      },
      2_000,
    );
    cancelled = passAll(cancelled, "tp02-cancel-pass", 3_000);
    expect(cancelled.players[actor]!.hp).toBe(
      prepared.players[actor]!.maxHp - 3,
    );
    expect(cancelled.effectStack).toEqual([]);
  });

  it("pays JP04, opens an absolute-deadline window, hides response ability, and resolves after all pass", () => {
    const arranged = arrangeForCounters(playing());
    let state = begin(arranged.state, arranged.actor, 12_000);
    expect(state.players[arranged.actor]!.hand).toEqual([]);
    expect(state.discardPile).toContain("xyy.card.jp04@7");
    expect(state.effectStack).toHaveLength(1);
    expect(state.effectStack[0]).toMatchObject({
      kind: "card:xyy.card.jp04",
      sourcePlayerId: arranged.actor,
      targetIds: [arranged.actor],
      status: "waiting",
    });
    expect(state.reactionWindow).toMatchObject({
      effectId: state.effectStack[0]!.effectId,
      priorityIndex: 0,
      passedPlayerIds: [],
      openedAt: 12_000,
      deadlineAt: 27_000,
    });
    expect(
      state.reactionWindow!.priorityOrder[state.reactionWindow!.priorityIndex],
    ).toBe(arranged.first);
    expect(createPlayerView(state, arranged.first).availableActions).toEqual([
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: state.effectStack[0]!.effectId,
      },
      { type: "pass-reaction", windowId: state.reactionWindow!.windowId },
    ]);
    expect(createPlayerView(state, arranged.second).availableActions).toEqual(
      [],
    );
    expect(
      JSON.stringify(createPlayerView(state, arranged.second)),
    ).not.toContain("xyy.card.tp01@33");

    state = passAll(state, "original-pass", 13_000);
    expect(state.reactionWindow).toBeNull();
    expect(state.effectStack).toEqual([]);
    expect(state.players[arranged.actor]!.hand).toHaveLength(2);
  });

  it("uses JN20202 to pay a special card into the normal Bingxin chain", () => {
    const arranged = arrangeForCounters(playing("jn20202-conversion"));
    const claimed = new Set([
      "xyy.card.jp04@7",
      "xyy.card.tp02@36",
      "xyy.card.jp01@1",
      "xyy.card.tp01@34",
    ]);
    let state: MatchState = {
      ...arranged.state,
      players: {
        ...arranged.state.players,
        [arranged.first]: {
          ...arranged.state.players[arranged.first]!,
          heroId: "xyy.hero.xj202",
          hand: ["xyy.card.tp02@36", "xyy.card.jp01@1"],
        },
        [arranged.second]: {
          ...arranged.state.players[arranged.second]!,
          hand: ["xyy.card.tp01@34"],
        },
        [arranged.third]: {
          ...arranged.state.players[arranged.third]!,
          hand: [],
        },
      },
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    };
    state = begin(state, arranged.actor);
    const originalEffectId = state.effectStack[0]!.effectId;
    expect(createPlayerView(state, arranged.first).availableActions).toEqual([
      {
        type: "play-skill-converted-reaction-card",
        cardInstanceId: "xyy.card.tp02@36",
        skillId: "xyy.skill.jn20202",
        targetEffectId: originalEffectId,
      },
      { type: "pass-reaction", windowId: state.reactionWindow!.windowId },
    ]);
    expect(createPlayerView(state, arranged.second).availableActions).toEqual(
      [],
    );

    const invalid = applyPlayer(
      state,
      arranged.first,
      "jn20202-invalid-normal-card",
      {
        type: "play-skill-converted-reaction-card",
        cardInstanceId: "xyy.card.jp01@1",
        skillId: "xyy.skill.jn20202",
        targetEffectId: originalEffectId,
      },
      1_500,
    );
    expect(invalid).toMatchObject({ accepted: false, reason: "forbidden" });

    state = accepted(
      state,
      arranged.first,
      "jn20202-convert",
      {
        type: "play-skill-converted-reaction-card",
        cardInstanceId: "xyy.card.tp02@36",
        skillId: "xyy.skill.jn20202",
        targetEffectId: originalEffectId,
      },
      2_000,
    );
    expect(state.players[arranged.first]!.hand).toEqual(["xyy.card.jp01@1"]);
    expect(state.discardPile).toEqual(
      expect.arrayContaining(["xyy.card.jp04@7", "xyy.card.tp02@36"]),
    );
    expect(state.effectStack.at(-1)).toMatchObject({
      kind: "cancel-effect",
      parentEffectId: originalEffectId,
      payload: {
        cardInstanceId: "xyy.card.tp02@36",
        skillId: "xyy.skill.jn20202",
      },
    });
    state = passAll(state, "jn20202-pass", 3_000);
    expect(state.effectStack).toEqual([]);
    expect(state.players[arranged.actor]!.hand).toEqual([]);
  });

  it("resolves one Bingxin child and cancels the original without drawing", () => {
    const arranged = arrangeForCounters(playing("single-cancel"));
    let state = begin(arranged.state, arranged.actor);
    const originalEffectId = state.effectStack[0]!.effectId;
    state = accepted(
      state,
      arranged.first,
      "play-first-bingxin",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: originalEffectId,
      },
      2_000,
    );
    expect(state.effectStack).toHaveLength(2);
    expect(state.effectStack[0]!.status).toBe("pending");
    expect(state.effectStack[1]).toMatchObject({
      kind: "cancel-effect",
      parentEffectId: originalEffectId,
      targetIds: [originalEffectId],
      status: "waiting",
    });
    state = passAll(state, "cancel-pass", 3_000);
    expect(state.reactionWindow).toBeNull();
    expect(state.effectStack).toEqual([]);
    expect(state.players[arranged.actor]!.hand).toEqual([]);
    expect(state.discardPile).toEqual(
      expect.arrayContaining(["xyy.card.jp04@7", "xyy.card.tp01@33"]),
    );
  });

  it("counters Bingxin, restores the original window after the counter source, and resolves once", () => {
    const arranged = arrangeForCounters(playing("counter-cancel"));
    let state = begin(arranged.state, arranged.actor);
    const originalEffectId = state.effectStack[0]!.effectId;
    state = accepted(
      state,
      arranged.first,
      "bingxin-one",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: originalEffectId,
      },
      2_000,
    );
    const firstBingxinId = state.effectStack[1]!.effectId;
    expect(
      state.reactionWindow!.priorityOrder[state.reactionWindow!.priorityIndex],
    ).toBe(arranged.second);
    state = accepted(
      state,
      arranged.second,
      "bingxin-two",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@34",
        targetEffectId: firstBingxinId,
      },
      3_000,
    );
    state = passAll(state, "counter-pass", 4_000);

    expect(state.effectStack.map((effect) => effect.status)).toEqual([
      "waiting",
    ]);
    expect(state.reactionWindow?.effectId).toBe(originalEffectId);
    expect(state.reactionWindow?.passedPlayerIds).toEqual([]);
    const expectedNext = clockwiseAfter(state, arranged.second).find(
      (playerId) => playerId !== arranged.actor,
    );
    expect(
      state.reactionWindow!.priorityOrder[state.reactionWindow!.priorityIndex],
    ).toBe(expectedNext);

    const restarted = JSON.parse(JSON.stringify(state)) as MatchState;
    const resolved = passAll(state, "restored-pass", 6_000);
    const restartedResolved = passAll(restarted, "restored-pass", 6_000);
    expect(restartedResolved).toEqual(resolved);
    expect(resolved.reactionWindow).toBeNull();
    expect(resolved.effectStack).toEqual([]);
    expect(resolved.players[arranged.actor]!.hand).toHaveLength(2);
  });

  it("rejects nonpriority, wrong-effect, and foreign-card reactions without mutation", () => {
    const arranged = arrangeForCounters(playing("reaction-rejections"));
    const state = begin(arranged.state, arranged.actor);
    const windowId = state.reactionWindow!.windowId;
    const effectId = state.effectStack[0]!.effectId;
    for (const [playerId, command, reason] of [
      [arranged.second, { type: "pass-reaction", windowId }, "not-available"],
      [
        arranged.first,
        {
          type: "play-reaction-card",
          cardInstanceId: "xyy.card.tp01@33",
          targetEffectId: "wrong-effect",
        },
        "forbidden",
      ],
      [
        arranged.first,
        {
          type: "play-reaction-card",
          cardInstanceId: "xyy.card.tp01@34",
          targetEffectId: effectId,
        },
        "forbidden",
      ],
    ] as const) {
      expect(
        applyPlayer(
          state,
          playerId,
          `reject-${reason}-${playerId}`,
          command,
          2_000,
        ),
      ).toEqual({ accepted: false, reason, currentVersion: state.version });
    }
  });

  it("supports a third nested counter without a hardcoded depth and resolves by parity", () => {
    const arranged = arrangeForCounters(playing("three-counters"));
    let state = begin(arranged.state, arranged.actor);
    const originalId = state.effectStack[0]!.effectId;
    state = accepted(
      state,
      arranged.first,
      "nested-one",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: originalId,
      },
      2_000,
    );
    state = accepted(
      state,
      arranged.second,
      "nested-two",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@34",
        targetEffectId: state.effectStack.at(-1)!.effectId,
      },
      3_000,
    );
    state = accepted(
      state,
      arranged.third,
      "nested-three",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@35",
        targetEffectId: state.effectStack.at(-1)!.effectId,
      },
      4_000,
    );
    state = passAll(state, "nested-three-pass", 5_000);
    expect(state.effectStack.map((effect) => effect.status)).toEqual([
      "pending",
      "waiting",
    ]);
    expect(state.reactionWindow?.effectId).toBe(state.effectStack[1]!.effectId);
    state = passAll(state, "nested-one-pass", 7_000);
    expect(state.reactionWindow).toBeNull();
    expect(state.effectStack).toEqual([]);
    expect(state.players[arranged.actor]!.hand).toEqual([]);
  });

  it("expires late input using server time and resets the deadline only after an accepted pass", () => {
    const arranged = arrangeForCounters(playing("deadline"));
    let state = begin(arranged.state, arranged.actor, 1_000);
    const window = state.reactionWindow!;
    expect(
      applyPlayer(
        state,
        arranged.first,
        "late-pass",
        { type: "pass-reaction", windowId: window.windowId },
        16_001,
      ),
    ).toEqual({
      accepted: false,
      reason: "expired-window",
      currentVersion: state.version,
    });
    state = accepted(
      state,
      arranged.first,
      "on-deadline-pass",
      { type: "pass-reaction", windowId: window.windowId },
      16_000,
    );
    expect(state.reactionWindow).toMatchObject({
      openedAt: 16_000,
      deadlineAt: 31_000,
      passedPlayerIds: [arranged.first],
    });
  });
});
