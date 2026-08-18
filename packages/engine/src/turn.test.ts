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
  expect(state.turn).toEqual({ number: 1, phase: "action" });
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

  it("ends action, traverses skipped stages, draws reward, requires exact discard, and advances", () => {
    let state = playing("discard-and-advance");
    const actor = state.activePlayerId!;
    const next = state.turnOrder[(state.turnOrder.indexOf(actor) + 1) % 6]!;
    state = arrange(state, {
      [actor]: ["xyy.card.jp01@1", "xyy.card.jp01@2", "xyy.card.jp02@3"],
    });
    state = dispatch(state, actor, "end-action", { type: "end-action" });
    expect(state.turn).toEqual({ number: 1, phase: "discard" });
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
    expect(state.turn).toEqual({ number: 2, phase: "action" });
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
