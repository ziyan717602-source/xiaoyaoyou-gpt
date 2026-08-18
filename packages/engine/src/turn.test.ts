import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
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
    state = dispatch(state, actor, "end-action", { type: "end-action" });
    expect(state.turn).toMatchObject({ number: 1, phase: "discard" });
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
