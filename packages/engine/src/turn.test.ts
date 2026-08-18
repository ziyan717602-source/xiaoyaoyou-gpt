import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  createSetupMatch,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  type CardInstanceId,
  type MatchState,
} from "./index.js";

const players = Array.from({ length: 6 }, (_, index) => ({
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
    clientIssuedAt: 1,
    command,
  };
}

function dispatch(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
): MatchState {
  const result = applyCommand(state, {
    origin: "player",
    serverReceivedAt: 0,
    envelope: envelope(state, playerId, commandId, command),
  });
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  let replayed = state;
  for (const event of result.events) replayed = reduceEvent(replayed, event);
  expect(replayed).toEqual(result.state);
  return result.state;
}

function passAllReactions(state: MatchState, prefix: string): MatchState {
  let next = state;
  let index = 0;
  while (next.reactionWindow !== null) {
    const window = next.reactionWindow;
    const priority = window.priorityOrder[window.priorityIndex]!;
    next = dispatch(next, priority, `${prefix}-${index}`, {
      type: "pass-reaction",
      windowId: window.windowId,
    });
    index += 1;
    if (index > 12) throw new Error("Reaction fixture did not converge.");
  }
  return next;
}

function playing(seed = "m03-turn-seed"): MatchState {
  let state = createSetupMatch({
    matchId: `m03-${seed}`,
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    players,
  });
  for (const playerId of state.turnOrder) {
    state = dispatch(state, playerId, `choose-${playerId}`, {
      type: "choose-hero",
      heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
    });
  }
  expect(state.turn).toMatchObject({ number: 1, phase: "action" });
  expect(state.turn?.deadlineAt).toBe(state.turn!.openedAt + 15_000);
  return state;
}

function arrange(
  state: MatchState,
  hands: Readonly<Record<PlayerId, readonly CardInstanceId[]>>,
  equipment: Readonly<
    Record<
      PlayerId,
      { readonly weapon?: CardInstanceId; readonly armor?: CardInstanceId }
    >
  > = {},
  discardPile: readonly CardInstanceId[] = [],
): MatchState {
  const claimed = new Set<CardInstanceId>(discardPile);
  for (const hand of Object.values(hands)) {
    for (const card of hand) {
      if (claimed.has(card)) throw new Error(`duplicate fixture card ${card}`);
      claimed.add(card);
    }
  }
  for (const slots of Object.values(equipment)) {
    for (const card of [slots.weapon, slots.armor]) {
      if (card === undefined) continue;
      if (claimed.has(card)) throw new Error(`duplicate fixture card ${card}`);
      claimed.add(card);
    }
  }
  const nextPlayers = Object.fromEntries(
    Object.values(state.players).map((player) => [
      player.id,
      {
        ...player,
        hand: hands[player.id] ?? [],
        equipment: {
          weapon: equipment[player.id]?.weapon ?? null,
          armor: equipment[player.id]?.armor ?? null,
        },
      },
    ]),
  );
  return {
    ...state,
    players: nextPlayers,
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile,
  };
}

function allCards(state: MatchState): CardInstanceId[] {
  return [
    ...state.drawPile,
    ...state.discardPile,
    ...Object.values(state.players).flatMap((player) => [
      ...(player.hand as CardInstanceId[]),
      ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
      ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
    ]),
  ];
}

function expectConserved(state: MatchState): void {
  const cards = allCards(state);
  expect(cards).toHaveLength(56);
  expect(new Set(cards)).toEqual(new Set(SETUP_CARD_INSTANCES));
}

describe("M03 deterministic turn core", () => {
  it("uses JN50202 once to draw before a mandatory private discard", () => {
    let emptyHand = playing("jn50202-empty-hand");
    const actor = emptyHand.activePlayerId!;
    const other = emptyHand.turnOrder.find((id) => id !== actor)!;
    emptyHand = arrange(emptyHand, {});
    emptyHand = {
      ...emptyHand,
      players: {
        ...emptyHand.players,
        [actor]: { ...emptyHand.players[actor]!, heroId: "xyy.hero.xj402" },
      },
    };
    const firstDrawn = emptyHand.drawPile[0]!;
    expect(createPlayerView(emptyHand, actor).availableActions).toContainEqual({
      type: "activate-hero-skill",
      cardInstanceIds: [],
      requiredCardCount: 0,
      skillId: "xyy.skill.jn50202",
      targetPlayerIds: [],
      requiredTargetCount: 0,
    });
    expect(createPlayerView(emptyHand, other).availableActions).toEqual([]);

    const forged = applyCommand(emptyHand, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(emptyHand, actor, "jn50202-forged-payment", {
        type: "activate-hero-skill",
        cardInstanceIds: [firstDrawn],
        skillId: "xyy.skill.jn50202",
        targetPlayerIds: [actor],
      }),
    });
    expect(forged).toMatchObject({ accepted: false, reason: "forbidden" });
    const nonNative = applyCommand(
      {
        ...emptyHand,
        players: {
          ...emptyHand.players,
          [actor]: { ...emptyHand.players[actor]!, heroId: "xyy.hero.xj401" },
        },
      },
      {
        origin: "player",
        serverReceivedAt: 0,
        envelope: envelope(emptyHand, actor, "jn50202-forged-owner", {
          type: "activate-hero-skill",
          cardInstanceIds: [],
          skillId: "xyy.skill.jn50202",
          targetPlayerIds: [],
        }),
      },
    );
    expect(nonNative).toMatchObject({ accepted: false, reason: "forbidden" });

    emptyHand = dispatch(emptyHand, actor, "jn50202-draw-only", {
      type: "activate-hero-skill",
      cardInstanceIds: [],
      skillId: "xyy.skill.jn50202",
      targetPlayerIds: [],
    });
    expect(emptyHand.players[actor]!.hand).toEqual([firstDrawn]);
    expect(emptyHand.pendingChoice).toBeNull();
    expect(emptyHand.effectStack).toEqual([]);
    expect(emptyHand.turn?.usedSkillIds).toEqual(["xyy.skill.jn50202"]);
    const repeated = applyCommand(emptyHand, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(emptyHand, actor, "jn50202-repeat", {
        type: "activate-hero-skill",
        cardInstanceIds: [],
        skillId: "xyy.skill.jn50202",
        targetPlayerIds: [],
      }),
    });
    expect(repeated).toMatchObject({ accepted: false, reason: "forbidden" });
    expect(
      createPlayerView(emptyHand, actor).availableActions.some(
        (action) =>
          action.type === "activate-hero-skill" &&
          action.skillId === "xyy.skill.jn50202",
      ),
    ).toBe(false);

    let choosing = playing("jn50202-mandatory-choice");
    const choosingActor = choosing.activePlayerId!;
    const originalCard = "xyy.card.jp01@1" as const;
    choosing = arrange(choosing, { [choosingActor]: [originalCard] });
    choosing = {
      ...choosing,
      players: {
        ...choosing.players,
        [choosingActor]: {
          ...choosing.players[choosingActor]!,
          heroId: "xyy.hero.xj402",
        },
      },
    };
    const drawnCard = choosing.drawPile[0]!;
    const plannedActivation = applyCommand(choosing, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(choosing, choosingActor, "jn50202-tamper-source", {
        type: "activate-hero-skill",
        cardInstanceIds: [],
        skillId: "xyy.skill.jn50202",
        targetPlayerIds: [],
      }),
    });
    expect(plannedActivation.accepted).toBe(true);
    if (!plannedActivation.accepted) throw new Error(plannedActivation.reason);
    expect(() =>
      reduceEvent(choosing, {
        ...plannedActivation.events[0]!,
        payload: {
          ...plannedActivation.events[0]!.payload,
          drawnCardInstanceIds: [choosing.drawPile[1]!],
        },
      }),
    ).toThrow(/deterministic|applicable/i);
    choosing = dispatch(choosing, choosingActor, "jn50202-open-choice", {
      type: "activate-hero-skill",
      cardInstanceIds: [],
      skillId: "xyy.skill.jn50202",
      targetPlayerIds: [],
    });
    expect(choosing.reactionWindow).toBeNull();
    expect(choosing.players[choosingActor]!.hand).toEqual([
      originalCard,
      drawnCard,
    ]);
    expect(choosing.effectStack).toEqual([
      expect.objectContaining({
        kind: "hero-skill:xyy.skill.jn50202",
        sourcePlayerId: choosingActor,
        targetIds: [choosingActor],
        step: "awaiting-choice",
        status: "resolving",
        payload: { skillId: "xyy.skill.jn50202" },
      }),
    ]);
    expect(choosing.pendingChoice).toMatchObject({
      playerIds: [choosingActor],
      prompt: "jn50202-discard-one",
      minSelections: 1,
      maxSelections: 1,
      optionIds: [originalCard, drawnCard],
      optional: false,
      fallback: "deterministic-random",
    });
    for (const playerId of choosing.turnOrder) {
      const view = createPlayerView(choosing, playerId);
      if (playerId === choosingActor) {
        expect(view.pendingChoice?.optionIds).toEqual([
          originalCard,
          drawnCard,
        ]);
      } else {
        expect(view.pendingChoice).toBeNull();
        expect(view.availableActions).toEqual([]);
        expect(JSON.stringify(view.effectStack)).not.toContain(originalCard);
        expect(JSON.stringify(view.effectStack)).not.toContain(drawnCard);
      }
    }

    choosing = dispatch(choosing, choosingActor, "jn50202-discard", {
      type: "submit-choice",
      choiceId: choosing.pendingChoice!.choiceId,
      selections: [originalCard],
    });
    expect(choosing.players[choosingActor]!.hand).toEqual([drawnCard]);
    expect(choosing.discardPile).toEqual([originalCard]);
    expect(choosing.pendingChoice).toBeNull();
    expect(choosing.effectStack).toEqual([]);
    expectConserved(emptyHand);
    expectConserved(choosing);
  });

  it("times out JN50202 mandatory discard with replayable seeded randomness", () => {
    let state = playing("jn50202-timeout");
    const actor = state.activePlayerId!;
    state = arrange(state, { [actor]: ["xyy.card.jp01@1"] });
    state = {
      ...state,
      players: {
        ...state.players,
        [actor]: { ...state.players[actor]!, heroId: "xyy.hero.xj402" },
      },
      drawPile: [],
      discardPile: state.drawPile,
    };
    const beforeActivationCursor = state.rng.cursor;
    state = dispatch(state, actor, "jn50202-timeout-open", {
      type: "activate-hero-skill",
      cardInstanceIds: [],
      skillId: "xyy.skill.jn50202",
      targetPlayerIds: [],
    });
    expect(state.rng.cursor).toBeGreaterThan(beforeActivationCursor);
    const before = JSON.parse(JSON.stringify(state)) as MatchState;
    const deadline = collectSystemDeadlines(state).find((candidate) =>
      candidate.targetId.startsWith("choice:"),
    );
    expect(deadline).toBeDefined();
    const timed = applyCommand(state, {
      origin: "system-timeout",
      commandId: "jn50202-timeout-resolve",
      matchId: state.matchId,
      expectedVersion: state.version,
      deadlineAt: deadline!.deadlineAt,
      targetId: deadline!.targetId,
    });
    const recovered = applyCommand(before, {
      origin: "system-timeout",
      commandId: "jn50202-timeout-resolve",
      matchId: before.matchId,
      expectedVersion: before.version,
      deadlineAt: deadline!.deadlineAt,
      targetId: deadline!.targetId,
    });
    expect(timed.accepted).toBe(true);
    expect(recovered).toEqual(timed);
    if (!timed.accepted) throw new Error(timed.reason);
    expect(timed.state.pendingChoice).toBeNull();
    expect(timed.state.effectStack).toEqual([]);
    expect(timed.state.players[actor]!.hand).toHaveLength(1);
    expect(timed.state.discardPile).toHaveLength(1);
    expect(timed.state.rng.cursor).toBeGreaterThan(state.rng.cursor);
    expectConserved(timed.state);
  });

  it("uses JN50201 once per action phase to convert one hand card into JP01 or JP06", () => {
    let state = playing("jn50201-conversion");
    const actor = state.activePlayerId!;
    const target = state.turnOrder.find((id) => id !== actor)!;
    state = arrange(
      state,
      {
        [actor]: ["xyy.card.zp01@16"],
        [target]: ["xyy.card.jp04@7"],
      },
      { [target]: { armor: "xyy.card.fj03@54" } },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [actor]: { ...state.players[actor]!, heroId: "xyy.hero.xj402" },
      },
    };

    const actions = createPlayerView(state, actor).availableActions;
    expect(actions).toContainEqual({
      type: "play-skill-converted-card",
      cardInstanceIds: ["xyy.card.zp01@16"],
      requiredCardCount: 1,
      skillId: "xyy.skill.jn50201",
      convertedCardId: "xyy.card.jp01",
      targetPlayerIds: [target],
    });
    expect(actions).toContainEqual({
      type: "play-skill-converted-card",
      cardInstanceIds: ["xyy.card.zp01@16"],
      requiredCardCount: 1,
      skillId: "xyy.skill.jn50201",
      convertedCardId: "xyy.card.jp06",
      targetPlayerIds: [target],
    });
    expect(createPlayerView(state, target).availableActions).toEqual([]);

    const forged = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(state, actor, "jn50201-forged", {
        type: "play-skill-converted-card",
        cardInstanceIds: ["xyy.card.zp01@16"],
        skillId: "xyy.skill.jn50201",
        convertedCardId: "xyy.card.jp05",
        targetPlayerIds: [target],
      }),
    });
    expect(forged).toMatchObject({ accepted: false, reason: "forbidden" });

    const initial = state;
    state = dispatch(state, actor, "jn50201-steal", {
      type: "play-skill-converted-card",
      cardInstanceIds: ["xyy.card.zp01@16"],
      skillId: "xyy.skill.jn50201",
      convertedCardId: "xyy.card.jp01",
      targetPlayerIds: [target],
    });
    expect(state.turn?.usedSkillIds).toEqual(["xyy.skill.jn50201"]);
    expect(state.effectStack[0]).toMatchObject({
      kind: "card:xyy.card.jp01",
      payload: {
        cardInstanceIds: ["xyy.card.zp01@16"],
        skillId: "xyy.skill.jn50201",
        convertedCardId: "xyy.card.jp01",
      },
    });
    state = passAllReactions(state, "jn50201-steal-pass");
    expect(state.pendingChoice?.optionIds).toEqual(["opaque-hand-slot-1"]);
    state = dispatch(state, actor, "jn50201-steal-choice", {
      type: "submit-choice",
      choiceId: state.pendingChoice!.choiceId,
      selections: ["opaque-hand-slot-1"],
    });
    expect(state.players[actor]!.hand).toEqual(["xyy.card.jp04@7"]);
    expect(state.players[target]!.hand).toEqual([]);
    expect(
      createPlayerView(state, actor).availableActions.some(
        (action) =>
          action.type === "play-skill-converted-card" &&
          action.skillId === "xyy.skill.jn50201",
      ),
    ).toBe(false);

    let discarded = dispatch(initial, actor, "jn50201-discard", {
      type: "play-skill-converted-card",
      cardInstanceIds: ["xyy.card.zp01@16"],
      skillId: "xyy.skill.jn50201",
      convertedCardId: "xyy.card.jp06",
      targetPlayerIds: [target],
    });
    discarded = passAllReactions(discarded, "jn50201-discard-pass");
    expect(discarded.pendingChoice?.optionIds).toEqual([
      "opaque-hand-slot-1",
      "equipment:armor",
    ]);
    discarded = dispatch(discarded, actor, "jn50201-discard-choice", {
      type: "submit-choice",
      choiceId: discarded.pendingChoice!.choiceId,
      selections: ["equipment:armor"],
    });
    expect(discarded.players[target]!.equipment.armor).toBeNull();
    expect(discarded.discardPile).toEqual([
      "xyy.card.zp01@16",
      "xyy.card.fj03@54",
    ]);

    const cancelInitial: MatchState = {
      ...initial,
      players: {
        ...initial.players,
        [target]: {
          ...initial.players[target]!,
          hand: ["xyy.card.jp04@7", "xyy.card.tp01@33"],
        },
      },
      drawPile: initial.drawPile.filter((card) => card !== "xyy.card.tp01@33"),
    };
    let cancelled = dispatch(cancelInitial, actor, "jn50201-cancelled", {
      type: "play-skill-converted-card",
      cardInstanceIds: ["xyy.card.zp01@16"],
      skillId: "xyy.skill.jn50201",
      convertedCardId: "xyy.card.jp06",
      targetPlayerIds: [target],
    });
    let skipped = 0;
    while (
      cancelled.reactionWindow !== null &&
      cancelled.reactionWindow.priorityOrder[
        cancelled.reactionWindow.priorityIndex
      ] !== target
    ) {
      const window = cancelled.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      cancelled = dispatch(
        cancelled,
        priority,
        `jn50201-cancel-skip-${skipped}`,
        {
          type: "pass-reaction",
          windowId: window.windowId,
        },
      );
      skipped += 1;
    }
    cancelled = dispatch(cancelled, target, "jn50201-bingxin", {
      type: "play-reaction-card",
      cardInstanceId: "xyy.card.tp01@33",
      targetEffectId: cancelled.effectStack[0]!.effectId,
    });
    cancelled = passAllReactions(cancelled, "jn50201-cancel-pass");
    expect(cancelled.pendingChoice).toBeNull();
    expect(cancelled.players[target]).toMatchObject({
      hand: ["xyy.card.jp04@7"],
      equipment: { armor: "xyy.card.fj03@54" },
    });
    expect(cancelled.turn?.usedSkillIds).toEqual(["xyy.skill.jn50201"]);
    expectConserved(state);
    expectConserved(discarded);
    expectConserved(cancelled);
  });

  it("uses JN40401 to discard hand or equipment before curing self", () => {
    let state = playing("jn40401-active");
    const actor = state.activePlayerId!;
    state = arrange(
      state,
      { [actor]: ["xyy.card.jp01@1"] },
      {
        [actor]: {
          weapon: "xyy.card.wq02@48",
          armor: "xyy.card.fj03@54",
        },
      },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [actor]: {
          ...state.players[actor]!,
          heroId: "xyy.hero.x3w04",
          hp: 1,
          maxHp: 5,
        },
      },
    };
    expect(createPlayerView(state, actor).availableActions).toContainEqual({
      type: "activate-hero-skill",
      cardInstanceIds: [
        "xyy.card.jp01@1",
        "xyy.card.wq02@48",
        "xyy.card.fj03@54",
      ],
      requiredCardCount: 1,
      skillId: "xyy.skill.jn40401",
      targetPlayerIds: [actor],
      requiredTargetCount: 0,
    });
    const forged = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(state, actor, "jn40401-forged", {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.jp02@3"],
        skillId: "xyy.skill.jn40401",
        targetPlayerIds: [actor],
      }),
    });
    expect(forged).toMatchObject({ accepted: false, reason: "forbidden" });

    const keepWeapon = dispatch(state, actor, "jn40401-pay-hand", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn40401",
      targetPlayerIds: [actor],
    });
    expect(keepWeapon.players[actor]).toMatchObject({
      hp: 4,
      hand: [],
      equipment: { weapon: "xyy.card.wq02@48", armor: "xyy.card.fj03@54" },
    });

    state = dispatch(state, actor, "jn40401-pay-weapon", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.wq02@48"],
      skillId: "xyy.skill.jn40401",
      targetPlayerIds: [actor],
    });
    expect(state.reactionWindow).toBeNull();
    expect(state.players[actor]).toMatchObject({
      hp: 3,
      hand: ["xyy.card.jp01@1"],
      equipment: { weapon: null, armor: "xyy.card.fj03@54" },
    });
    expect(state.discardPile).toEqual(["xyy.card.wq02@48"]);
    expectConserved(state);
  });

  it("uses JN20302 to discard one technique card and directly cure any living target", () => {
    let state = playing("jn20302-active");
    const actor = state.activePlayerId!;
    const target = state.turnOrder.find((id) => id !== actor)!;
    state = arrange(
      state,
      {
        [actor]: ["xyy.card.jp01@1", "xyy.card.jp02@3", "xyy.card.zp01@16"],
      },
      { [target]: { weapon: "xyy.card.wq02@48" } },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [actor]: { ...state.players[actor]!, heroId: "xyy.hero.xj203" },
        [target]: {
          ...state.players[target]!,
          hp: 1,
          maxHp: 5,
        },
      },
    };
    expect(createPlayerView(state, actor).availableActions).toContainEqual({
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.jp02@3"],
      requiredCardCount: 1,
      skillId: "xyy.skill.jn20302",
      targetPlayerIds: Object.values(state.players)
        .sort((left, right) => left.seat - right.seat)
        .map((player) => player.id),
      requiredTargetCount: 1,
    });
    expect(createPlayerView(state, target).availableActions).toEqual([]);
    const forged = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(state, actor, "jn20302-forged", {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.zp01@16"],
        skillId: "xyy.skill.jn20302",
        targetPlayerIds: [target],
      }),
    });
    expect(forged).toMatchObject({ accepted: false, reason: "forbidden" });

    state = dispatch(state, actor, "jn20302-cure", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn20302",
      targetPlayerIds: [target],
    });
    expect(state.reactionWindow).toBeNull();
    expect(state.effectStack).toEqual([]);
    expect(state.players[target]!.hp).toBe(4);
    expect(state.players[actor]!.hand).toEqual([
      "xyy.card.jp02@3",
      "xyy.card.zp01@16",
    ]);
    expect(state.discardPile).toEqual(["xyy.card.jp01@1"]);
    expect(createPlayerView(state, actor).availableActions).toContainEqual(
      expect.objectContaining({
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.jp02@3"],
      }),
    );
    expectConserved(state);
  });

  it("uses JN40301 to pay two hand cards into the normal TP02 chain", () => {
    let state = playing("jn40301-action");
    const actor = state.activePlayerId!;
    const responder = state.turnOrder.find((id) => id !== actor)!;
    state = arrange(state, {
      [actor]: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
      [responder]: ["xyy.card.tp01@33"],
    });
    state = {
      ...state,
      players: {
        ...state.players,
        [actor]: {
          ...state.players[actor]!,
          heroId: "xyy.hero.x3w03",
          hp: 2,
          maxHp: 5,
        },
      },
    };
    expect(createPlayerView(state, actor).availableActions).toContainEqual({
      type: "play-skill-converted-card",
      cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
      requiredCardCount: 2,
      skillId: "xyy.skill.jn40301",
      targetPlayerIds: [actor],
    });
    expect(
      createPlayerView(
        state,
        state.turnOrder.find((id) => id !== actor)!,
      ).availableActions,
    ).toEqual([]);

    const forged = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(state, actor, "jn40301-forged", {
        type: "play-skill-converted-card",
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.jp01@1"],
        skillId: "xyy.skill.jn40301",
        targetPlayerIds: [actor],
      }),
    });
    expect(forged).toMatchObject({ accepted: false, reason: "forbidden" });

    state = dispatch(state, actor, "jn40301-convert", {
      type: "play-skill-converted-card",
      cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
      skillId: "xyy.skill.jn40301",
      targetPlayerIds: [actor],
    });
    expect(state.players[actor]!.hand).toEqual([]);
    expect(state.discardPile).toEqual(["xyy.card.jp01@1", "xyy.card.zp01@16"]);
    expect(state.effectStack[0]).toMatchObject({
      kind: "card:xyy.card.tp02",
      payload: {
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
        skillId: "xyy.skill.jn40301",
      },
    });
    let cancelled = state;
    let skipped = 0;
    while (
      cancelled.reactionWindow !== null &&
      cancelled.reactionWindow.priorityOrder[
        cancelled.reactionWindow.priorityIndex
      ] !== responder
    ) {
      const window = cancelled.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      cancelled = dispatch(cancelled, priority, `jn40301-skip-${skipped}`, {
        type: "pass-reaction",
        windowId: window.windowId,
      });
      skipped += 1;
    }
    cancelled = dispatch(cancelled, responder, "jn40301-cancel", {
      type: "play-reaction-card",
      cardInstanceId: "xyy.card.tp01@33",
      targetEffectId: cancelled.effectStack[0]!.effectId,
    });
    cancelled = passAllReactions(cancelled, "jn40301-cancel-pass");
    expect(cancelled.players[actor]!.hp).toBe(2);

    state = passAllReactions(state, "jn40301-pass");
    expect(state.players[actor]!.hp).toBe(4);
    expectConserved(state);
  });

  it("uses 剑匣 limit five for authoritative discard decisions", () => {
    let state = playing("jn50402-7");
    const ownerId = state.activePlayerId!;
    expect(state.players[ownerId]).toMatchObject({
      heroId: "xyy.hero.xj404",
      handLimit: 5,
    });
    state = arrange(state, {
      [ownerId]: [
        "xyy.card.jp01@1",
        "xyy.card.jp02@3",
        "xyy.card.jp03@5",
        "xyy.card.jp04@7",
      ],
    });
    state = dispatch(state, ownerId, "jn50402-within-limit", {
      type: "end-action",
    });
    expect(state.players[ownerId]!.hand).toHaveLength(5);
    expect(state.turn).toMatchObject({ number: 2, phase: "action" });
    expect(state.activePlayerId).not.toBe(ownerId);

    let overflow = playing("jn50402-7");
    const overflowOwnerId = overflow.activePlayerId!;
    overflow = arrange(overflow, {
      [overflowOwnerId]: [
        "xyy.card.jp01@1",
        "xyy.card.jp02@3",
        "xyy.card.jp03@5",
        "xyy.card.jp04@7",
        "xyy.card.jp05@10",
      ],
    });
    overflow = dispatch(overflow, overflowOwnerId, "jn50402-over-limit", {
      type: "end-action",
    });
    expect(overflow.players[overflowOwnerId]!.hand).toHaveLength(6);
    expect(overflow.turn).toMatchObject({ number: 1, phase: "discard" });
    expect(
      createPlayerView(overflow, overflowOwnerId).availableActions,
    ).toEqual([
      {
        type: "discard-cards",
        count: 1,
        cardInstanceIds: overflow.players[overflowOwnerId]!.hand,
      },
    ]);

    let ordinary = playing("m03-turn-seed");
    const ordinaryId = ordinary.activePlayerId!;
    expect(ordinary.players[ordinaryId]!.handLimit).toBe(3);
    ordinary = dispatch(ordinary, ordinaryId, "ordinary-over-limit", {
      type: "end-action",
    });
    expect(ordinary.turn).toMatchObject({ number: 1, phase: "discard" });
  });

  it("uses JN50401 to transfer equipment, draw two, and visit each target once", () => {
    let state = playing("jn50401-present-sword");
    const actor = state.activePlayerId!;
    const targets = Object.values(state.players)
      .filter((player) => player.id !== actor)
      .sort((left, right) => left.seat - right.seat)
      .map((player) => player.id);
    const firstTarget = targets[0]!;
    const secondTarget = targets[1]!;
    state = arrange(
      state,
      {},
      {
        [actor]: {
          weapon: "xyy.card.wq01@47",
          armor: "xyy.card.fj01@52",
        },
        [firstTarget]: { weapon: "xyy.card.wq02@48" },
      },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [actor]: {
          ...state.players[actor]!,
          heroId: "xyy.hero.xj404",
          handLimit: 5,
        },
      },
    };
    const firstDraw = state.drawPile.slice(0, 2);
    expect(createPlayerView(state, actor).availableActions).toContainEqual({
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.wq01@47", "xyy.card.fj01@52"],
      requiredCardCount: 1,
      skillId: "xyy.skill.jn50401",
      targetPlayerIds: targets,
      requiredTargetCount: 1,
    });
    const deadline = collectSystemDeadlines(state).find((candidate) =>
      candidate.targetId.startsWith("turn:"),
    )!;
    const timedOut = applyCommand(state, {
      origin: "system-timeout",
      commandId: "jn50401-action-timeout",
      matchId: state.matchId,
      expectedVersion: state.version,
      deadlineAt: deadline.deadlineAt,
      targetId: deadline.targetId,
    });
    expect(timedOut.accepted).toBe(true);
    if (!timedOut.accepted) throw new Error(timedOut.reason);
    expect(timedOut.state.players[actor]!.equipment).toEqual(
      state.players[actor]!.equipment,
    );
    expect(timedOut.state.turn?.usedSkillTargetIds).toBeUndefined();
    expect(
      timedOut.events.some(
        (event) => event.type === "turn.hero-skill-activated",
      ),
    ).toBe(false);

    const nonNativeState: MatchState = {
      ...state,
      players: {
        ...state.players,
        [actor]: { ...state.players[actor]!, heroId: "xyy.hero.xj401" },
      },
    };
    const nonNative = applyCommand(nonNativeState, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(nonNativeState, actor, "jn50401-forged-owner", {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.wq01@47"],
        skillId: "xyy.skill.jn50401",
        targetPlayerIds: [firstTarget],
      }),
    });
    expect(nonNative).toMatchObject({ accepted: false, reason: "forbidden" });

    state = dispatch(state, actor, "jn50401-first-target", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.wq01@47"],
      skillId: "xyy.skill.jn50401",
      targetPlayerIds: [firstTarget],
    });
    expect(state.players[actor]).toMatchObject({
      hand: firstDraw,
      equipment: { weapon: null, armor: "xyy.card.fj01@52" },
    });
    expect(state.players[firstTarget]!.equipment.weapon).toBe(
      "xyy.card.wq01@47",
    );
    expect(state.discardPile).toContain("xyy.card.wq02@48");
    expect(state.turn?.usedSkillTargetIds).toEqual({
      "xyy.skill.jn50401": [firstTarget],
    });
    expect(state.reactionWindow).toBeNull();
    expect(createPlayerView(state, actor).availableActions).toContainEqual({
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.fj01@52"],
      requiredCardCount: 1,
      skillId: "xyy.skill.jn50401",
      targetPlayerIds: targets.filter((playerId) => playerId !== firstTarget),
      requiredTargetCount: 1,
    });

    const repeated = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(state, actor, "jn50401-repeat-target", {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.fj01@52"],
        skillId: "xyy.skill.jn50401",
        targetPlayerIds: [firstTarget],
      }),
    });
    expect(repeated).toMatchObject({ accepted: false, reason: "forbidden" });
    const forgedHand = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(state, actor, "jn50401-forged-hand", {
        type: "activate-hero-skill",
        cardInstanceIds: [state.players[actor]!.hand[0]!],
        skillId: "xyy.skill.jn50401",
        targetPlayerIds: [secondTarget],
      }),
    });
    expect(forgedHand).toMatchObject({
      accepted: false,
      reason: "forbidden",
    });
    const unknownCard = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(state, actor, "jn50401-unknown-card", {
        type: "activate-hero-skill",
        cardInstanceIds: ["xyy.card.unknown@999"],
        skillId: "xyy.skill.jn50401",
        targetPlayerIds: [secondTarget],
      }),
    });
    expect(unknownCard).toMatchObject({
      accepted: false,
      reason: "forbidden",
    });

    state = dispatch(state, actor, "jn50401-second-target", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.fj01@52"],
      skillId: "xyy.skill.jn50401",
      targetPlayerIds: [secondTarget],
    });
    expect(state.players[secondTarget]!.equipment.armor).toBe(
      "xyy.card.fj01@52",
    );
    expect(state.players[actor]!.hand).toHaveLength(4);
    expect(
      createPlayerView(state, actor).availableActions.some(
        (action) =>
          action.type === "activate-hero-skill" &&
          action.skillId === "xyy.skill.jn50401",
      ),
    ).toBe(false);
    expectConserved(state);

    state = dispatch(state, actor, "jn50401-end-action", {
      type: "end-action",
    });
    expect(state.turn).toMatchObject({ number: 2, phase: "action" });
    expect(state.turn?.usedSkillTargetIds).toBeUndefined();
  });

  it("lets JN50401 refill from the equipment it replaced before drawing its second card", () => {
    let state = playing("jn50401-replacement-refill");
    const actor = state.activePlayerId!;
    const target = state.turnOrder.find((playerId) => playerId !== actor)!;
    state = arrange(
      state,
      {},
      {
        [actor]: { weapon: "xyy.card.wq01@47" },
        [target]: { weapon: "xyy.card.wq02@48" },
      },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [actor]: {
          ...state.players[actor]!,
          heroId: "xyy.hero.xj404",
          hand: [],
          equipment: { weapon: "xyy.card.wq01@47", armor: null },
        },
        [target]: {
          ...state.players[target]!,
          hand: [],
          equipment: { weapon: "xyy.card.wq02@48", armor: null },
        },
      },
      drawPile: ["xyy.card.jp01@1"],
      discardPile: [],
    };
    state = dispatch(state, actor, "jn50401-replacement-refill", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.wq01@47"],
      skillId: "xyy.skill.jn50401",
      targetPlayerIds: [target],
    });
    expect(state.players[actor]!.hand).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.wq02@48",
    ]);
    expect(state.players[target]!.equipment.weapon).toBe("xyy.card.wq01@47");
    expect(state.discardPile).toEqual([]);
  });

  it("plays 鼠儿果 on one living target and draws exactly two privately", () => {
    let state = playing();
    const actor = state.activePlayerId!;
    const target = state.turnOrder.find((id) => id !== actor)!;
    state = arrange(state, {
      [actor]: ["xyy.card.jp04@7", "xyy.card.jp01@1"],
      [target]: ["xyy.card.jp02@3"],
    });

    const actorView = createPlayerView(state, actor);
    expect(actorView.availableActions).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.jp04@7",
      targetPlayerIds: expect.arrayContaining([target]),
    });
    state = dispatch(state, actor, "play-draw-two", {
      type: "play-card",
      cardInstanceId: "xyy.card.jp04@7",
      targetPlayerIds: [target],
    });

    expect(state.players[actor]!.hand).not.toContain("xyy.card.jp04@7");
    expect(state.discardPile).toContain("xyy.card.jp04@7");
    expect(state.reactionWindow).not.toBeNull();
    expect(state.players[target]!.hand).toHaveLength(1);
    state = passAllReactions(state, "draw-two-pass");
    expect(state.players[target]!.hand).toHaveLength(3);
    expect(
      createPlayerView(state, actor).players.find((p) => p.id === target)?.hand,
    ).toBeNull();
    expectConserved(state);
  });

  it("equips weapon and armor and discards the replaced instance", () => {
    let state = playing("equipment");
    const actor = state.activePlayerId!;
    state = arrange(
      state,
      { [actor]: ["xyy.card.wq02@48", "xyy.card.fj01@52"] },
      { [actor]: { weapon: "xyy.card.wq01@47" } },
    );
    state = dispatch(state, actor, "equip-weapon", {
      type: "play-card",
      cardInstanceId: "xyy.card.wq02@48",
      targetPlayerIds: [actor],
    });
    expect(state.players[actor]!.equipment.weapon).toBe("xyy.card.wq02@48");
    expect(state.discardPile).toContain("xyy.card.wq01@47");
    state = dispatch(state, actor, "equip-armor", {
      type: "play-card",
      cardInstanceId: "xyy.card.fj01@52",
      targetPlayerIds: [actor],
    });
    expect(state.players[actor]!.equipment.armor).toBe("xyy.card.fj01@52");
    expectConserved(state);
  });

  it("pawns WQ04 from either hand or weapon for two cards without a response window", () => {
    const handInitial = playing("wq04-hand-pawn");
    const actor = handInitial.activePlayerId!;
    let fromHand = arrange(handInitial, {
      [actor]: ["xyy.card.wq04@50"],
    });
    expect(createPlayerView(fromHand, actor).availableActions).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.wq04@50",
      targetPlayerIds: [],
      mode: "pawn",
    });
    fromHand = dispatch(fromHand, actor, "wq04-pawn-hand", {
      type: "play-card",
      cardInstanceId: "xyy.card.wq04@50",
      targetPlayerIds: [],
      mode: "pawn",
    });
    expect(fromHand.players[actor]!.hand).toHaveLength(2);
    expect(fromHand.discardPile).toContain("xyy.card.wq04@50");
    expect(fromHand.reactionWindow).toBeNull();
    expectConserved(fromHand);

    const equippedInitial = playing("wq04-equipped-pawn");
    const equippedActor = equippedInitial.activePlayerId!;
    let fromWeapon = arrange(
      equippedInitial,
      { [equippedActor]: [] },
      { [equippedActor]: { weapon: "xyy.card.wq04@50" } },
    );
    expect(
      createPlayerView(fromWeapon, equippedActor).availableActions,
    ).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.wq04@50",
      targetPlayerIds: [],
      mode: "pawn",
    });
    fromWeapon = dispatch(fromWeapon, equippedActor, "wq04-pawn-equipped", {
      type: "play-card",
      cardInstanceId: "xyy.card.wq04@50",
      targetPlayerIds: [],
      mode: "pawn",
    });
    expect(fromWeapon.players[equippedActor]!.equipment.weapon).toBeNull();
    expect(fromWeapon.players[equippedActor]!.hand).toHaveLength(2);
    expect(fromWeapon.discardPile).toContain("xyy.card.wq04@50");
    expect(fromWeapon.reactionWindow).toBeNull();
    expectConserved(fromWeapon);
  });

  it("ends action, traverses skipped stages, draws reward, requires exact discard, and advances", () => {
    let state = playing("discard-and-advance");
    const actor = state.activePlayerId!;
    const next = state.turnOrder[(state.turnOrder.indexOf(actor) + 1) % 6]!;
    state = arrange(state, {
      [actor]: ["xyy.card.jp01@1", "xyy.card.jp01@2", "xyy.card.jp02@3"],
    });
    state = {
      ...state,
      turn: { ...state.turn!, usedSkillIds: ["xyy.skill.jn50201"] },
    };
    state = dispatch(state, actor, "end-action", { type: "end-action" });
    expect(state.turn).toMatchObject({ number: 1, phase: "discard" });
    expect(state.turn?.usedSkillIds).toEqual(["xyy.skill.jn50201"]);
    expect(state.players[actor]!.hand).toHaveLength(4);
    expect(createPlayerView(state, actor).availableActions).toEqual([
      {
        type: "discard-cards",
        count: 1,
        cardInstanceIds: state.players[actor]!.hand,
      },
    ]);
    state = dispatch(state, actor, "discard-one", {
      type: "discard-cards",
      cardInstanceIds: [state.players[actor]!.hand[0]!],
    });
    expect(state.activePlayerId).toBe(next);
    expect(state.turn).toMatchObject({ number: 2, phase: "action" });
    expect(state.turn?.usedSkillIds).toEqual([]);
    expect(state.players[actor]!.hand).toHaveLength(3);
    expectConserved(state);
  });

  it("rejects wrong actor, illegal target, unsupported card, and invalid discard without mutation", () => {
    let state = playing("rejections");
    const actor = state.activePlayerId!;
    const other = state.turnOrder.find((id) => id !== actor)!;
    state = arrange(state, {
      [actor]: ["xyy.card.jp04@7", "xyy.card.tp01@33"],
    });
    const commands: [PlayerId, CommandEnvelope["command"], string][] = [
      [other, { type: "end-action" }, "not-available"],
      [
        actor,
        {
          type: "play-card",
          cardInstanceId: "xyy.card.jp04@7",
          targetPlayerIds: ["missing-player"],
        },
        "forbidden",
      ],
      [
        actor,
        {
          type: "play-card",
          cardInstanceId: "xyy.card.tp01@33",
          targetPlayerIds: [actor],
        },
        "not-available",
      ],
      [
        actor,
        { type: "discard-cards", cardInstanceIds: ["xyy.card.jp04@7"] },
        "not-available",
      ],
    ];
    for (const [playerId, command, reason] of commands) {
      expect(
        applyCommand(state, {
          origin: "player",
          serverReceivedAt: 0,
          envelope: envelope(state, playerId, `reject-${reason}`, command),
        }),
      ).toEqual({ accepted: false, reason, currentVersion: state.version });
    }
    expectConserved(state);
  });

  it("rejects tampered deterministic draw events and broken command version chains", () => {
    let state = playing("tampered-events");
    const actor = state.activePlayerId!;
    state = arrange(state, { [actor]: [] });
    const result = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(state, actor, "tamper-source", { type: "end-action" }),
    });
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error(result.reason);
    const drawIndex = result.events.findIndex(
      (event) => event.type === "turn.cards-drawn",
    );
    expect(drawIndex).toBeGreaterThan(0);
    let beforeDraw = state;
    for (const event of result.events.slice(0, drawIndex)) {
      beforeDraw = reduceEvent(beforeDraw, event);
    }
    const draw = result.events[drawIndex]!;
    expect(() =>
      reduceEvent(beforeDraw, {
        ...draw,
        payload: { ...draw.payload, cardInstanceIds: ["xyy.card.fj05@56"] },
      }),
    ).toThrow("disagrees with deterministic draw");
    expect(() =>
      reduceEvent(beforeDraw, { ...draw, causationEventId: null }),
    ).toThrow("invalid match version");
  });

  it("deterministically reshuffles discard and supports basic victory", () => {
    let state = playing("reshuffle");
    const actor = state.activePlayerId!;
    const target = state.turnOrder.find((id) => id !== actor)!;
    const kept = ["xyy.card.jp04@7"] as const;
    const discard = SETUP_CARD_INSTANCES.filter(
      (card) => !kept.includes(card as (typeof kept)[number]),
    );
    state = arrange(state, { [actor]: kept }, {}, discard);
    const beforeCursor = state.rng.cursor;
    state = dispatch(state, actor, "reshuffle-draw", {
      type: "play-card",
      cardInstanceId: "xyy.card.jp04@7",
      targetPlayerIds: [target],
    });
    state = passAllReactions(state, "reshuffle-pass");
    expect(state.players[target]!.hand).toHaveLength(2);
    expect(state.rng.cursor).toBeGreaterThan(beforeCursor);
    expectConserved(state);

    const victoryBase = playing("victory");
    const oneTeam = arrange(
      {
        ...victoryBase,
        players: Object.fromEntries(
          Object.values(victoryBase.players).map((player) => [
            player.id,
            { ...player, alive: player.team === 1 },
          ]),
        ),
      },
      {},
    );
    const winner = dispatch(oneTeam, oneTeam.activePlayerId!, "win", {
      type: "end-action",
    });
    expect(winner.phase).toBe("finished");
    expect(winner.winner).toBe(1);
    expect(winner.activePlayerId).toBeNull();
  });

  it("conserves all 56 cards across generated legal end/discard sequences", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (seed) => {
        let state = playing(seed);
        for (let step = 0; step < 30; step += 1) {
          const active = state.activePlayerId!;
          if (state.turn?.phase === "discard") {
            const player = state.players[active]!;
            state = dispatch(state, active, `${seed}-discard-${step}`, {
              type: "discard-cards",
              cardInstanceIds: player.hand.slice(
                0,
                player.hand.length - player.handLimit,
              ),
            });
          } else {
            state = dispatch(state, active, `${seed}-end-${step}`, {
              type: "end-action",
            });
          }
          expectConserved(state);
          expect(JSON.parse(JSON.stringify(state))).toEqual(state);
        }
      }),
      { numRuns: 40, seed: 20_260_819 },
    );
  });
});
