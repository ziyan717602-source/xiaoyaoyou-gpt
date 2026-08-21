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
  type DomainEvent,
  type MatchState,
} from "./index.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `duel-${index + 1}`,
  nickname: `Duel ${index + 1}`,
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
    clientIssuedAt: 0,
    command,
  };
}

function apply(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
  serverReceivedAt = 0,
): { readonly state: MatchState; readonly events: readonly DomainEvent[] } {
  const result = applyCommand(state, {
    origin: "player",
    serverReceivedAt,
    envelope: envelope(state, playerId, commandId, command),
  });
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  let replayed = state;
  for (const event of result.events) replayed = reduceEvent(replayed, event);
  expect(replayed).toEqual(result.state);
  return result;
}

function started(seed = "duel-test-seed"): MatchState {
  let state = createSetupMatch({
    matchId: `duel-match-${seed}`,
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    players: seats,
  });
  for (const playerId of state.turnOrder) {
    state = apply(state, playerId, `choose-${playerId}`, {
      type: "choose-hero",
      heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
    }).state;
  }
  return state;
}

function arrange(
  state: MatchState,
  overrides: Readonly<
    Record<
      PlayerId,
      Partial<
        Pick<
          MatchState["players"][PlayerId],
          "heroId" | "hp" | "maxHp" | "hand" | "equipment"
        >
      >
    >
  >,
  rngSeed = "duel-fixed-rng",
): MatchState {
  const players = Object.fromEntries(
    Object.values(state.players).map((player) => [
      player.id,
      {
        ...player,
        hand: [],
        equipment: { weapon: null, armor: null },
        ...overrides[player.id],
      },
    ]),
  ) as MatchState["players"];
  const claimed = new Set<CardInstanceId>();
  for (const player of Object.values(players)) {
    for (const card of player.hand) claimed.add(card);
    if (player.equipment.weapon !== null) claimed.add(player.equipment.weapon);
    if (player.equipment.armor !== null) claimed.add(player.equipment.armor);
  }
  return {
    ...state,
    players,
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
    rng: { algorithm: "sha256-counter-v1", seed: rngSeed, cursor: 0 },
  };
}

function passAllRescues(state: MatchState, prefix: string): MatchState {
  let next = state;
  for (let index = 0; next.dyingBatch !== null; index += 1) {
    if (index > 24) throw new Error("Duel rescue fixture did not converge.");
    const batch = next.dyingBatch;
    const choice = next.pendingChoice;
    if (batch.status !== "awaiting-rescue" || choice === null) {
      throw new Error("Duel rescue fixture is missing its open choice.");
    }
    const playerId = batch.priorityOrder[batch.priorityIndex]!;
    next = apply(next, playerId, `${prefix}-${index}`, {
      type: "pass-rescue",
      choiceId: choice.choiceId,
    }).state;
  }
  return next;
}

describe("CS02 JN20102/JN30601/JN30602 deterministic duel", () => {
  it("projects the rising payment, opens only the roller's private reroll, and records public dice", () => {
    const base = started("projection");
    const owner = base.activePlayerId!;
    const firstTarget = base.turnOrder.find((id) => id !== owner)!;
    const secondTarget = base.turnOrder.find(
      (id) => id !== owner && id !== firstTarget,
    )!;
    const state = arrange(base, {
      [owner]: { heroId: "xyy.hero.xj306", hand: ["xyy.card.jp01@1"] },
      [firstTarget]: {
        heroId: "xyy.hero.xj201",
        hand: ["xyy.card.tp03@39"],
      },
      [secondTarget]: { heroId: "xyy.hero.xj201", hand: [] },
    });

    expect(createPlayerView(state, owner).availableActions).toContainEqual({
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp01@1"],
      requiredCardCount: 1,
      skillId: "xyy.skill.jn30601",
      targetPlayerIds: expect.arrayContaining([firstTarget, secondTarget]),
      minTargetCount: 1,
      maxTargetCount: 2,
    });

    const activated = apply(state, owner, "duel-start", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn30601",
      targetPlayerIds: [firstTarget, secondTarget],
    });
    expect(activated.state.discardPile).toEqual(["xyy.card.jp01@1"]);
    expect(activated.state.turn?.usedSkillCounts?.["xyy.skill.jn30601"]).toBe(
      1,
    );
    expect(activated.state.turn?.duelContinuation).toMatchObject({
      kind: "jn30601-duel",
      ownerPlayerId: owner,
      targetPlayerIds: [firstTarget, secondTarget],
      currentTargetIndex: 0,
      stage: "rolling-target",
      ownerRoll: { playerId: owner, value: expect.any(Number) },
      targetRoll: { playerId: firstTarget, value: expect.any(Number) },
    });
    expect(activated.state.pendingChoice).toMatchObject({
      playerIds: [firstTarget],
      prompt: "hero-skill:xyy.skill.jn20102",
      optionIds: ["xyy.card.tp03@39"],
      optional: true,
      fallback: "pass",
    });
    for (const viewerId of state.turnOrder) {
      const view = createPlayerView(activated.state, viewerId);
      expect(
        view.turn?.duelContinuation?.targetRoll?.value,
      ).toBeGreaterThanOrEqual(1);
      if (viewerId === firstTarget) {
        expect(view.pendingChoice?.optionIds).toEqual(["xyy.card.tp03@39"]);
        expect(view.availableActions).toContainEqual(
          expect.objectContaining({ type: "submit-choice" }),
        );
      } else {
        expect(view.pendingChoice).toBeNull();
        expect(JSON.stringify(view.availableActions)).not.toContain(
          "xyy.card.tp03@39",
        );
      }
    }
  });

  it("pays for a reroll, settles targets sequentially, blocks TP03, and applies ALIVE at actual damage", () => {
    const base = started("reroll-alive");
    const owner = base.activePlayerId!;
    const [firstTarget, secondTarget] = base.turnOrder.filter(
      (id) => id !== owner,
    );
    const thirdTarget = base.turnOrder.find(
      (id) => id !== owner && id !== firstTarget && id !== secondTarget,
    )!;
    let state = arrange(
      base,
      {
        [owner]: {
          heroId: "xyy.hero.xj306",
          hp: 5,
          maxHp: 5,
          hand: ["xyy.card.jp01@1", "xyy.card.jp04@7", "xyy.card.zp01@16"],
        },
        [firstTarget!]: {
          heroId: "xyy.hero.xj201",
          hp: 2,
          maxHp: 4,
          hand: ["xyy.card.tp03@39"],
        },
        [secondTarget!]: {
          heroId: "xyy.hero.xj201",
          hp: 2,
          maxHp: 4,
          hand: ["xyy.card.jp02@3"],
        },
      },
      "duel-sequential-rng",
    );
    state = apply(state, owner, "duel-sequential-start", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn30601",
      targetPlayerIds: [firstTarget!, secondTarget!],
    }).state;
    const firstChoice = state.pendingChoice!;
    const rerolled = apply(state, firstTarget!, "duel-reroll", {
      type: "submit-choice",
      choiceId: firstChoice.choiceId,
      selections: ["xyy.card.tp03@39"],
    });
    state = rerolled.state;
    expect(state.discardPile).toEqual(["xyy.card.jp01@1", "xyy.card.tp03@39"]);
    expect(
      rerolled.events
        .filter((event) => event.type === "duel.die-rolled")
        .map((event) => event.payload.playerId),
    ).toEqual([firstTarget, owner, secondTarget]);
    expect(state.turn?.duelContinuation).toMatchObject({
      currentTargetIndex: 1,
      stage: "rolling-target",
      targetRoll: { playerId: secondTarget },
    });
    expect(state.pendingChoice?.playerIds).toEqual([secondTarget!]);
    expect(state.reactionWindow).toBeNull();
    expect(state.players[firstTarget!]!.hp).toBe(1);
    expect(state.players[owner]!.hp).toBe(3);
    expect(
      rerolled.events.find((event) => event.type === "duel.damage-started")
        ?.payload.damageItems,
    ).toEqual([
      expect.objectContaining({
        targetPlayerId: firstTarget,
        amount: 2,
        hpEvoMask: ["tux-inavo", "alive", "rsv-duel"],
      }),
      expect.objectContaining({
        targetPlayerId: owner,
        amount: 2,
        hpEvoMask: ["tux-inavo", "alive", "rsv-duel"],
      }),
    ]);

    state = apply(state, secondTarget!, "duel-second-pass", {
      type: "submit-choice",
      choiceId: state.pendingChoice!.choiceId,
      selections: [],
    }).state;
    expect(state.turn?.duelContinuation).toBeUndefined();
    expect(state.pendingChoice).toBeNull();
    expect(state.reactionWindow).toBeNull();
    expect(state.players[secondTarget!]!.hp).toBe(1);
    expect(state.players[owner]!.hp).toBe(3);
    expect(createPlayerView(state, owner).availableActions).toContainEqual({
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp04@7", "xyy.card.zp01@16"],
      requiredCardCount: 2,
      skillId: "xyy.skill.jn30601",
      targetPlayerIds: expect.arrayContaining([thirdTarget]),
      minTargetCount: 1,
      maxTargetCount: 2,
    });

    state = apply(state, owner, "duel-second-use", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp04@7", "xyy.card.zp01@16"],
      skillId: "xyy.skill.jn30601",
      targetPlayerIds: [thirdTarget],
    }).state;
    expect(state.turn?.usedSkillCounts?.["xyy.skill.jn30601"]).toBe(2);
    expect(state.players[owner]!.hand).toEqual([]);
    expect(state.discardPile).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.tp03@39",
      "xyy.card.jp04@7",
      "xyy.card.zp01@16",
    ]);
  });

  it("defaults JN20102 to pass after 15 seconds and rejects forged dice evidence on replay", () => {
    const base = started("timeout-replay");
    const owner = base.activePlayerId!;
    const target = base.turnOrder.find((id) => id !== owner)!;
    let state = arrange(base, {
      [owner]: { heroId: "xyy.hero.xj306", hand: ["xyy.card.jp01@1"] },
      [target]: {
        heroId: "xyy.hero.xj201",
        hand: ["xyy.card.jp02@3"],
      },
    });
    const activationInput = state;
    const activation = apply(state, owner, "duel-timeout-start", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn30601",
      targetPlayerIds: [target],
    });
    state = activation.state;
    const deadline = collectSystemDeadlines(state).find((item) =>
      item.targetId.startsWith("choice:"),
    )!;
    const timeout = applyCommand(state, {
      origin: "system-timeout",
      commandId: "duel-reroll-timeout",
      matchId: state.matchId,
      expectedVersion: state.version,
      deadlineAt: deadline.deadlineAt,
      targetId: deadline.targetId,
    });
    expect(timeout.accepted).toBe(true);
    if (!timeout.accepted) throw new Error(timeout.reason);
    expect(timeout.state.players[target]!.hand).toEqual(["xyy.card.jp02@3"]);
    expect(timeout.events).toContainEqual(
      expect.objectContaining({ type: "duel.roll-accepted" }),
    );

    const firstRoll = activation.events.find(
      (event) => event.type === "duel.die-rolled",
    )!;
    const forged: DomainEvent = {
      ...firstRoll,
      payload: {
        ...firstRoll.payload,
        value: ((firstRoll.payload.value as number) % 6) + 1,
      },
    };
    const beforeRoll = activation.events
      .slice(0, activation.events.indexOf(firstRoll))
      .reduce((current, event) => reduceEvent(current, event), activationInput);
    expect(() => reduceEvent(beforeRoll, forged)).toThrow(
      /deterministic dice/i,
    );

    const startEvent = activation.events[0]!;
    expect(() =>
      reduceEvent(activationInput, {
        ...startEvent,
        payload: {
          ...startEvent.payload,
          cardInstanceIds: ["xyy.card.wq01@47"],
        },
      }),
    ).toThrow(/JN30601 start/i);

    const damageEvent = timeout.events.find(
      (event) => event.type === "duel.damage-started",
    )!;
    const beforeDamage = timeout.events
      .slice(0, timeout.events.indexOf(damageEvent))
      .reduce((current, event) => reduceEvent(current, event), state);
    const forgedDamageItems = JSON.parse(
      JSON.stringify(damageEvent.payload.damageItems),
    ) as { amount: number }[];
    forgedDamageItems[0]!.amount += 1;
    expect(() =>
      reduceEvent(beforeDamage, {
        ...damageEvent,
        payload: { ...damageEvent.payload, damageItems: forgedDamageItems },
      }),
    ).toThrow(/Duel damage disagrees/i);
  });

  it("does not project TP03 against TUX_INAVO even when FJ05 opens the damage window", () => {
    const base = started("duel-tux-inavo");
    const owner = base.activePlayerId!;
    const target = base.turnOrder.find((id) => id !== owner)!;
    let state = arrange(base, {
      [owner]: { heroId: "xyy.hero.xj306", hand: ["xyy.card.jp01@1"] },
      [target]: {
        heroId: "xyy.hero.xj202",
        hp: 2,
        maxHp: 4,
        hand: ["xyy.card.tp03@39"],
        equipment: { weapon: null, armor: "xyy.card.fj05@56" },
      },
    });
    state = apply(state, owner, "duel-fj05-start", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn30601",
      targetPlayerIds: [target],
    }).state;
    expect(state.reactionWindow).not.toBeNull();
    const actions = createPlayerView(state, target).availableActions;
    expect(actions).toContainEqual({
      type: "activate-damage-equipment",
      cardInstanceId: "xyy.card.fj05@56",
      targetEffectId: state.reactionWindow!.effectId,
    });
    expect(actions).not.toContainEqual(
      expect.objectContaining({
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp03@39",
      }),
    );
  });

  it("lets ALIVE kill at one HP, finishes rescue/death, then clears the duel continuation", () => {
    const base = started("duel-one-hp-death");
    const owner = base.activePlayerId!;
    const target = base.turnOrder.find((id) => id !== owner)!;
    let state = arrange(base, {
      [owner]: { heroId: "xyy.hero.xj306", hand: ["xyy.card.jp01@1"] },
      [target]: {
        heroId: "xyy.hero.xj202",
        hp: 1,
        maxHp: 4,
        hand: [],
      },
    });
    state = apply(state, owner, "duel-one-hp-start", {
      type: "activate-hero-skill",
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn30601",
      targetPlayerIds: [target],
    }).state;
    expect(state.players[target]!.hp).toBe(0);
    expect(state.dyingBatch?.currentTargetPlayerId).toBe(target);
    expect(state.turn?.duelContinuation?.stage).toBe("resolving-damage");

    state = passAllRescues(state, "duel-one-hp-pass");
    expect(state.players[target]!.alive).toBe(false);
    expect(state.turn?.duelContinuation).toBeUndefined();
    expect(state.pendingChoice).toBeNull();
    expect(state.reactionWindow).toBeNull();
    expect(state.dyingBatch).toBeNull();
  });
});
