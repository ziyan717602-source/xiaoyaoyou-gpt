import { describe, expect, it } from "vitest";
import { grantPets } from "./testing/npc-fixture.js";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  beginDamageResponse,
  collectSystemDeadlines,
  createPlayerView,
  createSetupMatch,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  type CardInstanceId,
  type MatchState,
} from "./index.js";
import {
  applyPlannedDamage,
  planDamageBatch,
  type DamageIntent,
} from "./damage-dying.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `dying-${index + 1}`,
  nickname: `Dying ${index + 1}`,
}));

function accepted(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
  serverReceivedAt: number,
): MatchState {
  const result = applyCommand(state, {
    origin: "player",
    serverReceivedAt,
    envelope: {
      protocolVersion: 1,
      commandId,
      matchId: state.matchId,
      playerId,
      clientSequence: state.version,
      expectedVersion: state.version,
      clientIssuedAt: 0,
      command,
    },
  });
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  let replayed = state;
  for (const event of result.events) replayed = reduceEvent(replayed, event);
  expect(replayed).toEqual(result.state);
  return result.state;
}

function applied(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
  serverReceivedAt: number,
) {
  return applyCommand(state, {
    origin: "player" as const,
    serverReceivedAt,
    envelope: {
      protocolVersion: 1,
      commandId,
      matchId: state.matchId,
      playerId,
      clientSequence: state.version,
      expectedVersion: state.version,
      clientIssuedAt: 0,
      command,
    },
  });
}

function playing(seed = "m05-damage-dying"): MatchState {
  let state = createSetupMatch({
    matchId: `m05-${seed}`,
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

function arrange(
  state: MatchState,
  hands: Readonly<Record<PlayerId, readonly CardInstanceId[]>>,
  equipment: Readonly<
    Record<
      PlayerId,
      {
        readonly weapon: CardInstanceId | null;
        readonly armor: CardInstanceId | null;
      }
    >
  > = {},
): MatchState {
  const claimed = new Set([
    ...Object.values(hands).flat(),
    ...Object.values(equipment).flatMap((slots) =>
      [slots.weapon, slots.armor].filter(
        (card): card is CardInstanceId => card !== null,
      ),
    ),
  ]);
  return {
    ...state,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          hand: hands[player.id] ?? [],
          equipment: equipment[player.id] ?? {
            weapon: null,
            armor: null,
          },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
  };
}

function passAllReactions(state: MatchState, now: number): MatchState {
  let next = state;
  let index = 0;
  while (next.reactionWindow !== null) {
    const window = next.reactionWindow;
    const priority = window.priorityOrder[window.priorityIndex]!;
    next = accepted(
      next,
      priority,
      `reaction-pass-${index}`,
      { type: "pass-reaction", windowId: window.windowId },
      now + index,
    );
    index += 1;
    if (index > 12) throw new Error("Reaction pass did not converge.");
  }
  return next;
}

function passAllRescue(state: MatchState, now: number): MatchState {
  let next = state;
  let index = 0;
  const target = state.dyingBatch?.currentTargetPlayerId;
  while (
    next.dyingBatch?.status === "awaiting-rescue" &&
    next.dyingBatch.currentTargetPlayerId === target
  ) {
    const batch = next.dyingBatch;
    const priority = batch.priorityOrder[batch.priorityIndex]!;
    next = accepted(
      next,
      priority,
      `rescue-pass-${index}`,
      { type: "pass-rescue", choiceId: next.pendingChoice!.choiceId },
      now + index,
    );
    index += 1;
    if (index > 6) throw new Error("Rescue pass did not converge.");
  }
  return next;
}

describe("M05 damage and dying core", () => {
  it.each([false, true])(
    "uses JN20602 to transform before death while preserving hand, equipment and pets (pets=%s)",
    (pets) => {
      let state = playing("jn20602-transform");
      const ordered = Object.values(state.players).sort(
        (left, right) => left.seat - right.seat,
      );
      const owner = ordered[0]!.id;
      const victim = ordered[1]!.id;
      state = arrange(
        state,
        {
          [owner]: ["xyy.card.jp01@1"],
          [victim]: ["xyy.card.zp01@16"],
        },
        {
          [owner]: { weapon: "xyy.card.wq01@47", armor: null },
          [victim]: { weapon: "xyy.card.wq02@48", armor: null },
        },
      );
      state = {
        ...state,
        players: Object.fromEntries(
          Object.values(state.players).map((player) => [
            player.id,
            {
              ...player,
              heroId:
                player.id === owner
                  ? "xyy.hero.xj206"
                  : player.id === victim
                    ? "xyy.hero.xj104"
                    : "xyy.hero.xj201",
              hp: player.id === owner || player.id === victim ? 1 : 4,
              strength: player.id === victim ? 3 : player.strength,
            },
          ]),
        ),
      };
      if (pets)
        state = grantPets(state, owner, [
          "xyy.monster.gs04",
          "xyy.monster.gl03",
        ]);
      state = applyPlannedDamage(
        state,
        "jn20602-simultaneous-damage",
        planDamageBatch(state, [
          {
            itemId: "jn20602-owner-zero",
            sourcePlayerId: victim,
            targetPlayerId: owner,
            amount: 1,
            element: "neutral",
          },
          {
            itemId: "jn20602-victim-zero",
            sourcePlayerId: owner,
            targetPlayerId: victim,
            amount: 1,
            element: "neutral",
          },
        ]),
        1_000,
      );

      let transformation:
        | {
            readonly before: MatchState;
            readonly event: Parameters<typeof reduceEvent>[1];
          }
        | undefined;
      let pass = 0;
      while (
        state.dyingBatch?.status === "awaiting-rescue" &&
        state.dyingBatch.currentTargetPlayerId === owner
      ) {
        const before = state;
        const batch = state.dyingBatch;
        const priority = batch.priorityOrder[batch.priorityIndex]!;
        const result = applied(
          state,
          priority,
          `jn20602-owner-pass-${pass}`,
          { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
          2_000 + pass,
        );
        expect(result.accepted).toBe(true);
        if (!result.accepted) throw new Error(result.reason);
        const event = result.events.find(
          (candidate) => candidate.type === "death.hero-transformed",
        );
        if (event !== undefined) transformation = { before, event };
        state = result.state;
        pass += 1;
        if (pass > 6) throw new Error("JN20602 owner rescue did not converge.");
      }

      expect(transformation).toBeDefined();
      expect(state.players[owner]).toMatchObject({
        heroId: "xyy.hero.xj207",
        alive: true,
        hp: 5,
        maxHp: 5,
        strength: pets ? 9 : 8,
        dexterity: pets ? 5 : 2,
        handLimit: 3,
        hand: ["xyy.card.jp01@1"],
        equipment: { weapon: "xyy.card.wq01@47", armor: null },
      });
      expect(state.dyingBatch).toMatchObject({
        currentTargetPlayerId: victim,
        status: "awaiting-rescue",
        deadPlayerIds: [],
      });
      expect(() =>
        reduceEvent(transformation!.before, {
          ...transformation!.event,
          payload: {
            ...transformation!.event.payload,
            targetHeroId: "xyy.hero.xj201",
          },
        }),
      ).toThrow();

      state = passAllRescue(state, 3_000);
      expect(state.players[victim]).toMatchObject({
        alive: false,
        hp: 0,
        strength: 2,
        hand: [],
        equipment: { weapon: null, armor: null },
      });
      expect(state.players[owner]!.hand).toEqual(["xyy.card.jp01@1"]);
      expect(state.players[owner]!.equipment.weapon).toBe("xyy.card.wq01@47");
      expect(state.discardPile).not.toContain("xyy.card.jp01@1");
      expect(state.discardPile).not.toContain("xyy.card.wq01@47");
      expect(state.discardPile).toContain("xyy.card.zp01@16");
      expect(state.discardPile).toContain("xyy.card.wq02@48");
      expect(state.dyingBatch).toBeNull();
      expect(state.winner).toBeNull();
    },
  );

  it("lets JN20602 transformation decide a simultaneous last-player death cycle", () => {
    let state = playing("jn20602-last-player");
    const ordered = Object.values(state.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const owner = ordered[0]!.id;
    const opponent = ordered.find(
      (player) => player.team !== state.players[owner]!.team,
    )!.id;
    state = arrange(state, {});
    state = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            heroId: player.id === owner ? "xyy.hero.xj206" : "xyy.hero.xj201",
            alive: player.id === owner || player.id === opponent,
            hp: player.id === owner || player.id === opponent ? 1 : 0,
          },
        ]),
      ),
    };
    state = applyPlannedDamage(
      state,
      "jn20602-final-cycle",
      planDamageBatch(state, [
        {
          itemId: "jn20602-final-owner",
          sourcePlayerId: opponent,
          targetPlayerId: owner,
          amount: 1,
          element: "neutral",
        },
        {
          itemId: "jn20602-final-opponent",
          sourcePlayerId: owner,
          targetPlayerId: opponent,
          amount: 1,
          element: "neutral",
        },
      ]),
      1_000,
    );
    while (state.dyingBatch !== null) state = passAllRescue(state, 2_000);

    expect(state.players[owner]).toMatchObject({
      heroId: "xyy.hero.xj207",
      alive: true,
      hp: 5,
    });
    expect(state.players[opponent]).toMatchObject({ alive: false, hp: 0 });
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe(state.players[owner]!.team);
  });

  it("uses JN50203 once per death batch to collect and optionally distribute every dead card", () => {
    let state = playing("jn50203-loot");
    const ordered = Object.values(state.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const owner = ordered[0]!.id;
    const victim = ordered[1]!.id;
    const recipient = ordered[2]!.id;
    state = arrange(
      state,
      {
        [owner]: ["xyy.card.zp01@16"],
        [victim]: ["xyy.card.jp01@1"],
      },
      {
        [victim]: { weapon: "xyy.card.wq01@47", armor: null },
      },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [owner]: {
          ...state.players[owner]!,
          heroId: "xyy.hero.xj402",
          hp: 3,
        },
        [victim]: {
          ...state.players[victim]!,
          heroId: "xyy.hero.xj104",
          hp: 1,
          strength: 3,
        },
        [recipient]: {
          ...state.players[recipient]!,
          heroId: "xyy.hero.xj201",
        },
      },
    };
    const damage = planDamageBatch(state, [
      {
        itemId: "jn50203-kill",
        sourcePlayerId: owner,
        targetPlayerId: victim,
        amount: 1,
        element: "thunder",
      },
    ]);
    state = applyPlannedDamage(state, "jn50203-kill-effect", damage, 1_000);
    state = passAllRescue(state, 2_000);

    expect(state.players[victim]).toMatchObject({
      alive: false,
      strength: 2,
      hand: [],
      equipment: { weapon: null, armor: null },
    });
    expect(state.players[owner]!.hand).toEqual([
      "xyy.card.zp01@16",
      "xyy.card.jp01@1",
      "xyy.card.wq01@47",
    ]);
    expect(state.dyingBatch?.status).toBe("distributing-loot");
    expect(state.pendingChoice).toMatchObject({
      playerIds: [owner],
      prompt: "jn50203-distribute-loot",
      optionIds: ["xyy.card.jp01@1", "xyy.card.wq01@47"],
      minSelections: 0,
      maxSelections: 2,
      fallback: "pass",
    });
    expect(createPlayerView(state, owner).availableActions).toEqual([
      {
        type: "distribute-death-loot",
        choiceId: state.pendingChoice!.choiceId,
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.wq01@47"],
        minCardCount: 1,
        maxCardCount: 2,
        targetPlayerIds: ordered
          .filter((player) => player.id !== owner && player.id !== victim)
          .map((player) => player.id),
      },
      {
        type: "finish-death-loot",
        choiceId: state.pendingChoice!.choiceId,
      },
    ]);
    for (const player of ordered) {
      if (player.id === owner) continue;
      const view = createPlayerView(state, player.id);
      expect(view.pendingChoice).toBeNull();
      expect(view.availableActions).toEqual([]);
      expect(JSON.stringify(view)).not.toContain("xyy.card.jp01@1");
      expect(JSON.stringify(view)).not.toContain("xyy.card.wq01@47");
    }

    const timeoutStart = JSON.parse(JSON.stringify(state)) as MatchState;
    const deadline = collectSystemDeadlines(timeoutStart).find((candidate) =>
      candidate.targetId.startsWith("death-loot:"),
    );
    expect(deadline).toBeDefined();
    const timeout = applyCommand(timeoutStart, {
      origin: "system-timeout",
      commandId: "jn50203-timeout",
      matchId: timeoutStart.matchId,
      expectedVersion: timeoutStart.version,
      deadlineAt: deadline!.deadlineAt,
      targetId: deadline!.targetId,
    });
    expect(timeout.accepted).toBe(true);
    if (!timeout.accepted) throw new Error(timeout.reason);
    let timeoutState = timeout.state;
    expect(
      timeout.events.some(
        (event) =>
          event.type === "death.loot-finished" &&
          event.payload.timeout === true,
      ),
    ).toBe(true);
    timeoutState = passAllReactions(timeoutState, deadline!.deadlineAt + 1);
    expect(timeoutState.players[owner]).toMatchObject({ hp: 2, alive: true });
    expect(timeoutState.players[owner]!.hand).toEqual([
      "xyy.card.zp01@16",
      "xyy.card.jp01@1",
      "xyy.card.wq01@47",
    ]);

    state = accepted(
      state,
      owner,
      "jn50203-distribute-one",
      {
        type: "distribute-death-loot",
        choiceId: state.pendingChoice!.choiceId,
        cardInstanceIds: ["xyy.card.jp01@1"],
        targetPlayerId: recipient,
      },
      3_000,
    );
    expect(state.players[recipient]!.hand).toEqual(["xyy.card.jp01@1"]);
    expect(state.pendingChoice?.optionIds).toEqual(["xyy.card.wq01@47"]);
    state = accepted(
      state,
      owner,
      "jn50203-finish",
      {
        type: "finish-death-loot",
        choiceId: state.pendingChoice!.choiceId,
      },
      4_000,
    );
    expect(state.reactionWindow?.priorityOrder).toEqual([owner]);
    state = passAllReactions(state, 5_000);
    expect(state.players[owner]).toMatchObject({
      hp: 2,
      alive: true,
      hand: ["xyy.card.zp01@16", "xyy.card.wq01@47"],
    });
    expect(state.dyingBatch).toBeNull();
    expect(state.pendingChoice).toBeNull();
    expect(state.discardPile).toEqual([]);
  });

  it("groups simultaneous JN50203 loot into one choice and one self damage", () => {
    let state = playing("jn50203-simultaneous");
    const ordered = Object.values(state.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const owner = ordered[0]!.id;
    const first = ordered[1]!.id;
    const second = ordered[2]!.id;
    state = arrange(state, {
      [first]: ["xyy.card.jp01@1"],
      [second]: ["xyy.card.zp01@16"],
    });
    state = {
      ...state,
      players: {
        ...state.players,
        [owner]: {
          ...state.players[owner]!,
          heroId: "xyy.hero.xj402",
          hp: 3,
        },
        [first]: { ...state.players[first]!, hp: 1 },
        [second]: { ...state.players[second]!, hp: 1 },
      },
    };
    const damage = planDamageBatch(state, [
      {
        itemId: "jn50203-first",
        sourcePlayerId: null,
        targetPlayerId: first,
        amount: 1,
        element: "thunder",
      },
      {
        itemId: "jn50203-second",
        sourcePlayerId: null,
        targetPlayerId: second,
        amount: 1,
        element: "thunder",
      },
    ]);
    state = applyPlannedDamage(
      state,
      "jn50203-simultaneous-effect",
      damage,
      1_000,
    );
    state = passAllRescue(state, 2_000);
    expect(state.dyingBatch?.currentTargetPlayerId).toBe(second);
    expect(state.players[first]!.hand).toEqual(["xyy.card.jp01@1"]);
    state = passAllRescue(state, 3_000);
    expect(state.pendingChoice?.optionIds).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.zp01@16",
    ]);
    state = accepted(
      state,
      owner,
      "jn50203-finish-all",
      {
        type: "finish-death-loot",
        choiceId: state.pendingChoice!.choiceId,
      },
      4_000,
    );
    state = passAllReactions(state, 5_000);
    expect(state.players[owner]).toMatchObject({ hp: 2, alive: true });
    expect(state.players[owner]!.hand).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.zp01@16",
    ]);
  });

  it("does not trigger JN50203 when its owner dies in the same batch", () => {
    let state = playing("jn50203-owner-dies");
    const ordered = Object.values(state.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const owner = ordered[0]!.id;
    const victim = ordered[1]!.id;
    state = arrange(state, {
      [owner]: ["xyy.card.jp01@1"],
      [victim]: ["xyy.card.zp01@16"],
    });
    state = {
      ...state,
      players: {
        ...state.players,
        [owner]: {
          ...state.players[owner]!,
          heroId: "xyy.hero.xj402",
          hp: 1,
        },
        [victim]: { ...state.players[victim]!, hp: 1 },
      },
    };
    const damage = planDamageBatch(state, [
      {
        itemId: "jn50203-owner-dies",
        sourcePlayerId: null,
        targetPlayerId: owner,
        amount: 1,
        element: "thunder",
      },
      {
        itemId: "jn50203-other-dies",
        sourcePlayerId: null,
        targetPlayerId: victim,
        amount: 1,
        element: "thunder",
      },
    ]);
    state = applyPlannedDamage(
      state,
      "jn50203-owner-dies-effect",
      damage,
      1_000,
    );
    state = passAllRescue(state, 2_000);
    state = passAllRescue(state, 3_000);
    expect(state.pendingChoice).toBeNull();
    expect(state.dyingBatch).toBeNull();
    expect(state.discardPile).toEqual(
      expect.arrayContaining(["xyy.card.jp01@1", "xyy.card.zp01@16"]),
    );
    expect(state.players[owner]!.hand).toEqual([]);
    expect(state.players[victim]!.hand).toEqual([]);
  });

  it("skips JN50203 when the death batch has already decided the winner", () => {
    let state = playing("jn50203-winning-death");
    const ordered = Object.values(state.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const owner = ordered[0]!.id;
    const victim = ordered.find(
      (player) => player.team !== state.players[owner]!.team,
    )!.id;
    state = arrange(state, { [victim]: ["xyy.card.jp01@1"] });
    state = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            heroId: player.id === owner ? "xyy.hero.xj402" : player.heroId,
            alive:
              player.team === state.players[owner]!.team ||
              player.id === victim,
            hp:
              player.id === victim
                ? 1
                : player.team === state.players[owner]!.team
                  ? player.hp
                  : 0,
            hand: player.id === victim ? ["xyy.card.jp01@1"] : [],
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter(
        (card) => card !== "xyy.card.jp01@1",
      ),
    };
    const damage = planDamageBatch(state, [
      {
        itemId: "jn50203-winning-kill",
        sourcePlayerId: owner,
        targetPlayerId: victim,
        amount: 1,
        element: "thunder",
      },
    ]);
    state = applyPlannedDamage(state, "jn50203-winning-effect", damage, 1_000);
    state = passAllRescue(state, 2_000);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe(state.players[owner]!.team);
    expect(state.pendingChoice).toBeNull();
    expect(state.dyingBatch).toBeNull();
    expect(state.players[owner]!.hand).toEqual([]);
    expect(state.discardPile).toContain("xyy.card.jp01@1");
  });

  it("lets JN40301 pay two hand cards as TP02 during rescue", () => {
    let state = playing("jn40301-rescue");
    const actor = state.activePlayerId!;
    const ordered = Object.values(state.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const actorIndex = ordered.findIndex((player) => player.id === actor);
    const target = ordered[(actorIndex + 1) % ordered.length]!.id;
    const rescuer = ordered[(actorIndex + 2) % ordered.length]!.id;
    state = arrange(state, {
      [actor]: ["xyy.card.jp05@10"],
      [rescuer]: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
    });
    state = {
      ...state,
      players: {
        ...state.players,
        [target]: { ...state.players[target]!, hp: 2 },
        [rescuer]: {
          ...state.players[rescuer]!,
          heroId: "xyy.hero.x3w03",
        },
      },
    };
    state = accepted(
      state,
      actor,
      "jn40301-damage",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
      1_000,
    );
    state = passAllReactions(state, 2_000);
    state = accepted(
      state,
      target,
      "jn40301-target-pass",
      { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
      3_000,
    );
    expect(createPlayerView(state, rescuer).availableActions).toEqual([
      {
        type: "play-skill-converted-card",
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
        requiredCardCount: 2,
        skillId: "xyy.skill.jn40301",
        targetPlayerIds: [target],
      },
      { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
    ]);
    expect(createPlayerView(state, actor).availableActions).toEqual([]);
    const forged = applied(
      state,
      rescuer,
      "jn40301-rescue-forged",
      {
        type: "play-skill-converted-card",
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.jp01@1"],
        skillId: "xyy.skill.jn40301",
        targetPlayerIds: [target],
      },
      4_000,
    );
    expect(forged).toMatchObject({ accepted: false, reason: "forbidden" });
    const optionalPass = accepted(
      state,
      rescuer,
      "jn40301-rescue-pass-copy",
      { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
      4_000,
    );
    expect(optionalPass.players[rescuer]!.hand).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.zp01@16",
    ]);

    state = accepted(
      state,
      rescuer,
      "jn40301-rescue",
      {
        type: "play-skill-converted-card",
        cardInstanceIds: ["xyy.card.jp01@1", "xyy.card.zp01@16"],
        skillId: "xyy.skill.jn40301",
        targetPlayerIds: [target],
      },
      4_000,
    );
    expect(state.players[target]).toMatchObject({ hp: 2, alive: true });
    expect(state.players[rescuer]!.hand).toEqual([]);
    expect(state.discardPile).toEqual(
      expect.arrayContaining([
        "xyy.card.jp05@10",
        "xyy.card.jp01@1",
        "xyy.card.zp01@16",
      ]),
    );
    expect(state.dyingBatch).toBeNull();
  });

  it("opens owner-private JN30201 pursuit before dying and chains once per paid card", () => {
    let state = playing("jn30201-chain");
    const owner = state.turnOrder[0]!;
    const target = state.turnOrder[1]!;
    state = arrange(state, {
      [owner]: ["xyy.card.jp01@1", "xyy.card.jp02@3"],
    });
    state = {
      ...state,
      players: {
        ...state.players,
        [owner]: {
          ...state.players[owner]!,
          heroId: "xyy.hero.xj302",
        },
        [target]: { ...state.players[target]!, hp: 5 },
      },
    };
    const original = planDamageBatch(state, [
      {
        itemId: "jn30201-original:damage:0",
        sourcePlayerId: target,
        targetPlayerId: target,
        amount: 2,
        element: "thunder",
      },
    ]);
    state = applyPlannedDamage(state, "jn30201-original", original, 100);

    expect(state.players[target]!.hp).toBe(3);
    expect(state.dyingBatch).toBeNull();
    expect(state.pendingChoice).toMatchObject({
      playerIds: [owner],
      prompt: "hero-skill:xyy.skill.jn30201",
      minSelections: 0,
      maxSelections: 1,
      optionIds: ["xyy.card.jp01@1", "xyy.card.jp02@3"],
      fallback: "pass",
    });
    expect(createPlayerView(state, owner).availableActions).toContainEqual({
      type: "submit-choice",
      choiceId: state.pendingChoice!.choiceId,
      optionIds: ["xyy.card.jp01@1", "xyy.card.jp02@3"],
      minSelections: 0,
      maxSelections: 1,
    });
    expect(createPlayerView(state, target).pendingChoice).toBeNull();
    expect(createPlayerView(state, target).availableActions).toEqual([]);
    expect(
      applied(
        state,
        owner,
        "jn30201-forged-card",
        {
          type: "submit-choice",
          choiceId: state.pendingChoice!.choiceId,
          selections: ["xyy.card.tp01@33"],
        },
        101,
      ),
    ).toMatchObject({ accepted: false });
    const plannedActivation = applied(
      state,
      owner,
      "jn30201-tamper-source",
      {
        type: "submit-choice",
        choiceId: state.pendingChoice!.choiceId,
        selections: ["xyy.card.jp01@1"],
      },
      101,
    );
    expect(plannedActivation.accepted).toBe(true);
    if (!plannedActivation.accepted) {
      throw new Error(plannedActivation.reason);
    }
    const activationEvent = plannedActivation.events[0]!;
    expect(() =>
      reduceEvent(state, {
        ...activationEvent,
        payload: {
          ...activationEvent.payload,
          sourceEffectId: "forged-source",
        },
      }),
    ).toThrow("JN30201 event is not applicable");
    expect(() =>
      reduceEvent(state, {
        ...activationEvent,
        payload: {
          ...activationEvent.payload,
          targetPlayerIds: [owner],
        },
      }),
    ).toThrow("JN30201 event is not applicable");
    const damageItems = activationEvent.payload.damageItems as readonly Record<
      string,
      unknown
    >[];
    expect(() =>
      reduceEvent(state, {
        ...activationEvent,
        payload: {
          ...activationEvent.payload,
          damageItems: damageItems.map((item, index) =>
            index === 0 ? { ...item, amount: 2 } : item,
          ),
        },
      }),
    ).toThrow("JN30201 damage event is not applicable");
    const declined = accepted(
      JSON.parse(JSON.stringify(state)) as MatchState,
      owner,
      "jn30201-decline",
      {
        type: "submit-choice",
        choiceId: state.pendingChoice!.choiceId,
        selections: [],
      },
      101,
    );
    expect(declined.players[target]!.hp).toBe(3);
    expect(declined.players[owner]!.hand).toEqual([
      "xyy.card.jp01@1",
      "xyy.card.jp02@3",
    ]);
    expect(declined.pendingChoice).toBeNull();
    expect(declined.dyingBatch).toBeNull();

    state = accepted(
      state,
      owner,
      "jn30201-first",
      {
        type: "submit-choice",
        choiceId: state.pendingChoice!.choiceId,
        selections: ["xyy.card.jp01@1"],
      },
      102,
    );
    expect(state.players[owner]!.hand).toEqual(["xyy.card.jp02@3"]);
    expect(state.discardPile).toContain("xyy.card.jp01@1");
    expect(state.reactionWindow).not.toBeNull();
    state = passAllReactions(state, 103);
    expect(state.players[target]!.hp).toBe(2);
    expect(state.pendingChoice?.prompt).toBe("hero-skill:xyy.skill.jn30201");

    state = accepted(
      state,
      owner,
      "jn30201-second",
      {
        type: "submit-choice",
        choiceId: state.pendingChoice!.choiceId,
        selections: ["xyy.card.jp02@3"],
      },
      120,
    );
    state = passAllReactions(state, 121);
    expect(state.players[target]!.hp).toBe(1);
    expect(state.players[owner]!.hand).toEqual([]);
    expect(state.pendingChoice).toBeNull();
    expect(state.dyingBatch).toBeNull();
  });

  it("does not offer JN30201 for owner-only or CHAIN_INVAO damage", () => {
    let selfOnly = playing("jn30201-self-only");
    const owner = selfOnly.turnOrder[0]!;
    const target = selfOnly.turnOrder[1]!;
    selfOnly = arrange(selfOnly, { [owner]: ["xyy.card.jp01@1"] });
    selfOnly = {
      ...selfOnly,
      players: {
        ...selfOnly.players,
        [owner]: {
          ...selfOnly.players[owner]!,
          heroId: "xyy.hero.xj302",
          hp: 5,
        },
      },
    };
    selfOnly = applyPlannedDamage(
      selfOnly,
      "jn30201-self-only",
      planDamageBatch(selfOnly, [
        {
          itemId: "jn30201-self-only:damage:0",
          sourcePlayerId: target,
          targetPlayerId: owner,
          amount: 1,
          element: "neutral",
        },
      ]),
      100,
    );
    expect(selfOnly.players[owner]!.hp).toBe(4);
    expect(selfOnly.pendingChoice).toBeNull();

    let chainBlocked = playing("jn30201-chain-inavo");
    const chainOwner = chainBlocked.turnOrder[0]!;
    const chainTarget = chainBlocked.turnOrder[1]!;
    chainBlocked = arrange(chainBlocked, {
      [chainOwner]: ["xyy.card.jp01@1"],
    });
    chainBlocked = {
      ...chainBlocked,
      players: {
        ...chainBlocked.players,
        [chainOwner]: {
          ...chainBlocked.players[chainOwner]!,
          heroId: "xyy.hero.xj302",
        },
      },
    };
    chainBlocked = applyPlannedDamage(
      chainBlocked,
      "jn30201-chain-inavo",
      planDamageBatch(chainBlocked, [
        {
          itemId: "jn30201-chain-inavo:damage:0",
          sourcePlayerId: chainOwner,
          targetPlayerId: chainTarget,
          amount: 1,
          element: "neutral",
          hpEvoMask: ["chain-inavo"],
        },
      ]),
      100,
    );
    expect(chainBlocked.pendingChoice).toBeNull();
  });

  it("includes the JN30201 owner when the same original batch also damaged another player", () => {
    let state = playing("jn30201-owner-and-other");
    const owner = state.turnOrder[0]!;
    const target = state.turnOrder[1]!;
    state = arrange(state, { [owner]: ["xyy.card.jp01@1"] });
    state = {
      ...state,
      players: {
        ...state.players,
        [owner]: {
          ...state.players[owner]!,
          heroId: "xyy.hero.xj302",
          hp: 5,
        },
        [target]: { ...state.players[target]!, hp: 5 },
      },
    };
    state = applyPlannedDamage(
      state,
      "jn30201-owner-and-other",
      planDamageBatch(state, [
        {
          itemId: "jn30201-owner-and-other:damage:0",
          sourcePlayerId: target,
          targetPlayerId: owner,
          amount: 1,
          element: "neutral",
        },
        {
          itemId: "jn30201-owner-and-other:damage:1",
          sourcePlayerId: target,
          targetPlayerId: target,
          amount: 1,
          element: "neutral",
        },
      ]),
      100,
    );
    expect(state.players[owner]!.hp).toBe(4);
    expect(state.players[target]!.hp).toBe(4);
    expect(state.effectStack.at(-1)?.targetIds).toEqual([owner, target]);
    state = accepted(
      state,
      owner,
      "jn30201-owner-and-other-activate",
      {
        type: "submit-choice",
        choiceId: state.pendingChoice!.choiceId,
        selections: ["xyy.card.jp01@1"],
      },
      101,
    );
    state = passAllReactions(state, 102);
    expect(state.players[owner]!.hp).toBe(3);
    expect(state.players[target]!.hp).toBe(3);
    expect(state.pendingChoice).toBeNull();
    expect(state.dyingBatch).toBeNull();
  });

  it("times out JN30201 as pass before starting the original dying batch", () => {
    let state = playing("jn30201-timeout-before-dying");
    const owner = state.turnOrder[0]!;
    const target = state.turnOrder[1]!;
    state = arrange(state, { [owner]: ["xyy.card.jp01@1"] });
    state = {
      ...state,
      players: {
        ...state.players,
        [owner]: {
          ...state.players[owner]!,
          heroId: "xyy.hero.xj302",
        },
        [target]: { ...state.players[target]!, hp: 1 },
      },
    };
    state = applyPlannedDamage(
      state,
      "jn30201-lethal",
      planDamageBatch(state, [
        {
          itemId: "jn30201-lethal:damage:0",
          sourcePlayerId: owner,
          targetPlayerId: target,
          amount: 1,
          element: "neutral",
        },
      ]),
      100,
    );
    expect(state.players[target]!.hp).toBe(0);
    expect(state.pendingChoice?.prompt).toBe("hero-skill:xyy.skill.jn30201");
    expect(state.dyingBatch).toBeNull();
    let activated = accepted(
      JSON.parse(JSON.stringify(state)) as MatchState,
      owner,
      "jn30201-lethal-activate",
      {
        type: "submit-choice",
        choiceId: state.pendingChoice!.choiceId,
        selections: ["xyy.card.jp01@1"],
      },
      101,
    );
    activated = passAllReactions(activated, 102);
    expect(activated.players[target]!.hp).toBe(0);
    expect(activated.players[owner]!.hand).toEqual([]);
    expect(activated.discardPile).toContain("xyy.card.jp01@1");
    expect(activated.dyingBatch?.currentTargetPlayerId).toBe(target);
    const deadline = collectSystemDeadlines(state).find((candidate) =>
      candidate.targetId.startsWith("choice:"),
    );
    expect(deadline).toBeDefined();
    const result = applyCommand(state, {
      origin: "system-timeout",
      commandId: "jn30201-timeout",
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
    expect(result.state.players[owner]!.hand).toEqual(["xyy.card.jp01@1"]);
    expect(result.state.discardPile).not.toContain("xyy.card.jp01@1");
    expect(result.state.pendingChoice).not.toBeNull();
    expect(result.state.dyingBatch?.currentTargetPlayerId).toBe(target);
  });

  it("applies JN50501 water/fire immunity with IMMUNE_INVAO bypass", () => {
    const initial = playing("jn50501-elements");
    const actor = initial.activePlayerId!;
    const target = initial.turnOrder.find((playerId) => playerId !== actor)!;
    const state: MatchState = {
      ...initial,
      players: {
        ...initial.players,
        [target]: {
          ...initial.players[target]!,
          heroId: "xyy.hero.xj405",
        },
      },
    };
    const intent = (
      element: string,
      hpEvoMask = [] as const,
    ): DamageIntent => ({
      itemId: `jn50501-${element}`,
      sourcePlayerId: actor,
      targetPlayerId: target,
      amount: 2,
      element,
      hpEvoMask,
    });

    expect(planDamageBatch(state, [intent("water")])).toEqual([]);
    expect(planDamageBatch(state, [intent("fire")])).toEqual([]);
    expect(planDamageBatch(state, [intent("thunder")])).toMatchObject([
      { amount: 2, element: "thunder", targetPlayerId: target },
    ]);
    expect(
      planDamageBatch(state, [intent("fire", ["immune-inavo"])]),
    ).toMatchObject([
      {
        amount: 2,
        element: "fire",
        hpEvoMask: ["immune-inavo"],
        targetPlayerId: target,
      },
    ]);

    const ordinaryId = state.turnOrder.find(
      (playerId) => playerId !== actor && playerId !== target,
    )!;
    expect(
      planDamageBatch(state, [
        intent("water"),
        {
          ...intent("fire"),
          itemId: "ordinary-fire",
          targetPlayerId: ordinaryId,
        },
      ]),
    ).toMatchObject([
      { itemId: "ordinary-fire", amount: 2, targetPlayerId: ordinaryId },
    ]);
    expect(
      planDamageBatch(state, [{ ...intent("fire"), amount: 0 }]),
    ).toHaveLength(1);
    expect(
      planDamageBatch(state, [
        intent("fire"),
        { ...intent("water"), itemId: "jn50501-zero-water", amount: 0 },
      ]),
    ).toEqual([]);

    const checkpoint = JSON.parse(JSON.stringify(state)) as MatchState;
    expect(planDamageBatch(checkpoint, [intent("water")])).toEqual([]);
  });

  it("orders replacement/addition/reduction deterministically and floors damage at zero", () => {
    const state = playing("modifier-order");
    const target = state.turnOrder[0]!;
    const alternate = state.turnOrder[1]!;
    const intent: DamageIntent = {
      itemId: "damage-1",
      sourcePlayerId: target,
      targetPlayerId: target,
      amount: 2,
      element: "thunder",
    };
    expect(
      planDamageBatch(
        state,
        [intent],
        [
          {
            effectId: "effect-reduce",
            sourcePlayerId: target,
            priority: 30,
            kind: "reduction",
            amount: 9,
          },
          {
            effectId: "effect-add",
            sourcePlayerId: target,
            priority: 20,
            kind: "addition",
            amount: 3,
          },
          {
            effectId: "effect-replace",
            sourcePlayerId: target,
            priority: 10,
            kind: "replacement",
            amount: 4,
            replacementTargetPlayerId: alternate,
          },
        ],
      ),
    ).toEqual([
      {
        ...intent,
        targetPlayerId: alternate,
        amount: 0,
        hpEvoMask: [],
        appliedReplacementEffectIds: ["effect-replace"],
        appliedModifierCardInstanceIds: [],
      },
    ]);
    expect(() =>
      planDamageBatch(
        state,
        [intent],
        [
          {
            effectId: "effect-invalid",
            sourcePlayerId: target,
            priority: 0,
            kind: "addition",
            amount: -1,
          },
        ],
      ),
    ).toThrow("Damage modifier amount must be a nonnegative safe integer.");
  });

  it("applies FJ03 reduction and FJ04 FROM_JP immunity before damage responses", () => {
    const initial = playing("equipment-damage-masks");
    const actor = initial.activePlayerId!;
    const target = initial.turnOrder.find((playerId) => playerId !== actor)!;
    const baseIntent: DamageIntent = {
      itemId: "equipment-damage",
      sourcePlayerId: actor,
      targetPlayerId: target,
      amount: 2,
      element: "thunder",
      hpEvoMask: ["from-jp"],
    };
    const armorState = (armor: CardInstanceId) =>
      arrange(initial, {}, { [target]: { weapon: null, armor } });

    expect(
      planDamageBatch(armorState("xyy.card.fj03@54"), [baseIntent]),
    ).toEqual([
      {
        ...baseIntent,
        amount: 1,
        hpEvoMask: ["from-jp"],
        appliedReplacementEffectIds: [],
        appliedModifierCardInstanceIds: ["xyy.card.fj03@54"],
      },
    ]);
    for (const bypass of ["termin-at", "decr-inavo"] as const) {
      expect(
        planDamageBatch(armorState("xyy.card.fj03@54"), [
          { ...baseIntent, hpEvoMask: [bypass, "from-jp"] },
        ])[0],
      ).toMatchObject({
        amount: 2,
        appliedModifierCardInstanceIds: [],
      });
    }
    expect(
      planDamageBatch(armorState("xyy.card.fj03@54"), [
        { ...baseIntent, amount: 1 },
      ]),
    ).toEqual([]);

    expect(
      planDamageBatch(armorState("xyy.card.fj04@55"), [baseIntent]),
    ).toEqual([]);
    expect(
      planDamageBatch(armorState("xyy.card.fj04@55"), [
        {
          ...baseIntent,
          hpEvoMask: ["immune-inavo", "from-jp"],
        },
      ])[0],
    ).toMatchObject({ amount: 2, hpEvoMask: ["immune-inavo", "from-jp"] });
    expect(
      planDamageBatch(armorState("xyy.card.fj04@55"), [
        { ...baseIntent, hpEvoMask: [] },
      ])[0],
    ).toMatchObject({ amount: 2, hpEvoMask: [] });

    let live = arrange(
      initial,
      { [actor]: ["xyy.card.jp05@10"], [target]: ["xyy.card.tp03@39"] },
      { [target]: { weapon: null, armor: "xyy.card.fj04@55" } },
    );
    const hpBefore = live.players[target]!.hp;
    live = accepted(
      live,
      actor,
      "fj04-jp05",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
      1_000,
    );
    live = passAllReactions(live, 2_000);
    expect(live.players[target]!.hp).toBe(hpBefore);
    expect(live.players[target]!.hand).toContain("xyy.card.tp03@39");
    expect(live.players[target]!.equipment.armor).toBe("xyy.card.fj04@55");
    expect(live.reactionWindow).toBeNull();
    expect(live.dyingBatch).toBeNull();
  });

  it("resolves JP05 only after reactions and lets the dying target use TP02", () => {
    let state = playing("single-rescue");
    const actor = state.activePlayerId!;
    const target = Object.values(state.players)
      .sort((left, right) => left.seat - right.seat)
      .find((player) => player.id !== actor)!.id;
    state = arrange(
      state,
      {
        [actor]: ["xyy.card.jp05@10"],
        [target]: ["xyy.card.tp02@36"],
      },
      {
        [target]: { weapon: "xyy.card.wq02@48", armor: null },
      },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [target]: { ...state.players[target]!, hp: 2 },
      },
    };
    state = accepted(
      state,
      actor,
      "play-jp05",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
      1_000,
    );
    expect(state.players[target]!.hp).toBe(2);
    state = passAllReactions(state, 2_000);
    expect(state.players[target]).toMatchObject({ hp: 0, alive: true });
    expect(state.dyingBatch?.currentTargetPlayerId).toBe(target);
    expect(createPlayerView(state, target).availableActions).toEqual([
      {
        type: "play-rescue-card",
        cardInstanceId: "xyy.card.tp02@36",
        targetPlayerId: target,
      },
      { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
    ]);
    state = accepted(
      state,
      target,
      "self-rescue",
      {
        type: "play-rescue-card",
        cardInstanceId: "xyy.card.tp02@36",
        targetPlayerId: target,
      },
      3_000,
    );
    expect(state.players[target]).toMatchObject({ hp: 3, alive: true });
    expect(state.dyingBatch).toBeNull();
    expect(state.pendingChoice).toBeNull();
    expect(state.discardPile).toEqual(
      expect.arrayContaining(["xyy.card.jp05@10", "xyy.card.tp02@36"]),
    );
  });

  it("lets zero-HP XJ206 discard FJ01 to rescue before JN20602 can transform", () => {
    let state = playing("fj01-self-rescue");
    const actor = state.activePlayerId!;
    const target = state.turnOrder.find((playerId) => playerId !== actor)!;
    state = arrange(
      state,
      { [actor]: ["xyy.card.jp05@10"] },
      {
        [target]: {
          weapon: "xyy.card.wq02@48",
          armor: "xyy.card.fj01@52",
        },
      },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [target]: {
          ...state.players[target]!,
          heroId: "xyy.hero.xj206",
          hp: 2,
          maxHp: 10,
          strength: 4,
          dexterity: 2,
          handLimit: 3,
        },
      },
    };
    state = accepted(
      state,
      actor,
      "fj01-play-jp05",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
      1_000,
    );
    state = passAllReactions(state, 2_000);
    expect(state.players[target]!.hp).toBe(0);
    expect(createPlayerView(state, target).availableActions[0]).toEqual({
      type: "activate-rescue-equipment",
      cardInstanceId: "xyy.card.fj01@52",
      targetPlayerId: target,
    });
    state = accepted(
      state,
      target,
      "fj01-activate",
      {
        type: "activate-rescue-equipment",
        cardInstanceId: "xyy.card.fj01@52",
        targetPlayerId: target,
      },
      3_000,
    );
    expect(state.players[target]).toMatchObject({
      heroId: "xyy.hero.xj206",
      alive: true,
      hp: 3,
      equipment: { weapon: "xyy.card.wq02@48", armor: null },
    });
    expect(state.discardPile).toEqual(
      expect.arrayContaining(["xyy.card.jp05@10", "xyy.card.fj01@52"]),
    );
    expect(state.dyingBatch).toBeNull();
    expect(state.pendingChoice).toBeNull();
  });

  it("lets the damaged owner discard FJ05 against preventable masks and cure", () => {
    const initial = playing("fj05-damage-burst");
    const actor = initial.activePlayerId!;
    const target = initial.turnOrder.find((playerId) => playerId !== actor)!;
    let state = arrange(
      initial,
      {},
      {
        [target]: {
          weapon: "xyy.card.wq02@48",
          armor: "xyy.card.fj05@56",
        },
      },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [target]: {
          ...state.players[target]!,
          hp: state.players[target]!.maxHp - 2,
        },
      },
    };
    const damage = planDamageBatch(state, [
      {
        itemId: "fj05-tux-inavo",
        sourcePlayerId: actor,
        targetPlayerId: target,
        amount: 2,
        element: "thunder",
        hpEvoMask: ["tux-inavo"],
      },
    ]);
    state = beginDamageResponse(state, "fj05-effect", actor, damage, 1_000);
    expect(state.reactionWindow?.priorityOrder).toEqual([target]);
    expect(createPlayerView(state, target).availableActions[0]).toEqual({
      type: "activate-damage-equipment",
      cardInstanceId: "xyy.card.fj05@56",
      targetEffectId: "fj05-effect:damage-batch",
    });
    state = accepted(
      state,
      target,
      "fj05-activate",
      {
        type: "activate-damage-equipment",
        cardInstanceId: "xyy.card.fj05@56",
        targetEffectId: "fj05-effect:damage-batch",
      },
      2_000,
    );
    expect(state.players[target]).toMatchObject({
      hp: state.players[target]!.maxHp,
      equipment: { weapon: "xyy.card.wq02@48", armor: null },
    });
    expect(state.discardPile).toContain("xyy.card.fj05@56");
    expect(state.reactionWindow).toBeNull();
    expect(state.dyingBatch).toBeNull();

    for (const bypass of ["decr-inavo", "immune-inavo"] as const) {
      const bypassState = arrange(
        initial,
        {},
        { [target]: { weapon: null, armor: "xyy.card.fj05@56" } },
      );
      const hpBefore = bypassState.players[target]!.hp;
      const planned = planDamageBatch(bypassState, [
        {
          itemId: `fj05-${bypass}`,
          sourcePlayerId: actor,
          targetPlayerId: target,
          amount: 1,
          element: "thunder",
          hpEvoMask: ["tux-inavo", bypass],
        },
      ]);
      const appliedState = beginDamageResponse(
        bypassState,
        `fj05-${bypass}-effect`,
        actor,
        planned,
        3_000,
      );
      expect(appliedState.reactionWindow).toBeNull();
      expect(appliedState.players[target]!.hp).toBe(hpBefore - 1);
      expect(appliedState.players[target]!.equipment.armor).toBe(
        "xyy.card.fj05@56",
      );
    }
  });

  it("lets FJ02 pay an arbitrary own hand card into the normal TP03 counter-chain", () => {
    const initial = playing("fj02-hand-conversion");
    const actor = initial.activePlayerId!;
    const target = initial.turnOrder.find((playerId) => playerId !== actor)!;
    const ordered = Object.values(initial.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const counter =
      ordered[(ordered.findIndex((player) => player.id === target) + 1) % 6]!
        .id;
    const open = (seed: string, withCounter = false) => {
      let state = arrange(
        initial,
        {
          [target]: ["xyy.card.jp01@1"],
          ...(withCounter ? { [counter]: ["xyy.card.tp01@33"] } : {}),
        },
        {
          [target]: { weapon: null, armor: "xyy.card.fj02@53" },
        },
      );
      const hpBefore = state.players[target]!.hp;
      state = beginDamageResponse(
        state,
        `${seed}-effect`,
        actor,
        planDamageBatch(state, [
          {
            itemId: `${seed}-damage`,
            sourcePlayerId: actor,
            targetPlayerId: target,
            amount: 2,
            element: "thunder",
          },
        ]),
        1_000,
      );
      return { state, hpBefore };
    };

    const successful = open("fj02-success");
    const damageEffectId = successful.state.effectStack.at(-1)!.effectId;
    expect(createPlayerView(successful.state, target).availableActions).toEqual(
      [
        {
          type: "play-converted-reaction-card",
          cardInstanceId: "xyy.card.jp01@1",
          equipmentCardInstanceId: "xyy.card.fj02@53",
          targetEffectId: damageEffectId,
        },
        {
          type: "pass-reaction",
          windowId: successful.state.reactionWindow!.windowId,
        },
      ],
    );
    expect(createPlayerView(successful.state, actor).availableActions).toEqual(
      [],
    );
    for (const command of [
      {
        type: "play-converted-reaction-card" as const,
        cardInstanceId: "xyy.card.tp01@33",
        equipmentCardInstanceId: "xyy.card.fj02@53",
        targetEffectId: damageEffectId,
      },
      {
        type: "play-converted-reaction-card" as const,
        cardInstanceId: "xyy.card.jp01@1",
        equipmentCardInstanceId: "xyy.card.fj05@56",
        targetEffectId: damageEffectId,
      },
      {
        type: "play-converted-reaction-card" as const,
        cardInstanceId: "xyy.card.jp01@1",
        equipmentCardInstanceId: "xyy.card.fj02@53",
        targetEffectId: "wrong-effect",
      },
    ]) {
      expect(
        applied(
          successful.state,
          target,
          `fj02-reject-${command.cardInstanceId}-${command.targetEffectId}`,
          command,
          2_000,
        ),
      ).toEqual({
        accepted: false,
        reason: "forbidden",
        currentVersion: successful.state.version,
      });
    }
    let resolved = accepted(
      successful.state,
      target,
      "fj02-convert-success",
      {
        type: "play-converted-reaction-card",
        cardInstanceId: "xyy.card.jp01@1",
        equipmentCardInstanceId: "xyy.card.fj02@53",
        targetEffectId: damageEffectId,
      },
      2_000,
    );
    expect(resolved.effectStack.at(-1)).toMatchObject({
      kind: "card:xyy.card.tp03",
      sourcePlayerId: target,
      payload: {
        cardInstanceId: "xyy.card.jp01@1",
        equipmentCardInstanceId: "xyy.card.fj02@53",
      },
    });
    expect(resolved.players[target]!.equipment.armor).toBe("xyy.card.fj02@53");
    resolved = passAllReactions(resolved, 3_000);
    expect(resolved.players[target]!.hp).toBe(successful.hpBefore);
    expect(resolved.players[target]!.hand).toEqual([]);
    expect(resolved.discardPile).toContain("xyy.card.jp01@1");

    const cancelled = open("fj02-cancelled", true);
    let countered = accepted(
      cancelled.state,
      target,
      "fj02-convert-cancelled",
      {
        type: "play-converted-reaction-card",
        cardInstanceId: "xyy.card.jp01@1",
        equipmentCardInstanceId: "xyy.card.fj02@53",
        targetEffectId: cancelled.state.effectStack.at(-1)!.effectId,
      },
      2_000,
    );
    countered = accepted(
      countered,
      counter,
      "fj02-bingxin-counter",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: countered.effectStack.at(-1)!.effectId,
      },
      3_000,
    );
    countered = passAllReactions(countered, 4_000);
    expect(countered.players[target]!.hp).toBe(cancelled.hpBefore - 2);
    expect(countered.players[target]!.equipment.armor).toBe("xyy.card.fj02@53");

    const timed = open("fj02-timeout");
    const deadline = collectSystemDeadlines(timed.state).find((candidate) =>
      candidate.targetId.startsWith("reaction:"),
    )!;
    const timeout = applyCommand(timed.state, {
      origin: "system-timeout",
      commandId: "fj02-default-pass",
      matchId: timed.state.matchId,
      expectedVersion: timed.state.version,
      deadlineAt: deadline.deadlineAt,
      targetId: deadline.targetId,
    });
    expect(timeout.accepted).toBe(true);
    if (!timeout.accepted) throw new Error(timeout.reason);
    expect(timeout.state.players[target]).toMatchObject({
      hp: timed.hpBefore - 2,
      hand: ["xyy.card.jp01@1"],
      equipment: { armor: "xyy.card.fj02@53" },
    });

    let immune = arrange(
      initial,
      { [target]: ["xyy.card.jp01@1"] },
      { [target]: { weapon: null, armor: "xyy.card.fj02@53" } },
    );
    const immuneHp = immune.players[target]!.hp;
    immune = beginDamageResponse(
      immune,
      "fj02-tux-inavo",
      actor,
      planDamageBatch(immune, [
        {
          itemId: "fj02-tux-inavo-damage",
          sourcePlayerId: actor,
          targetPlayerId: target,
          amount: 1,
          element: "none",
          hpEvoMask: ["tux-inavo"],
        },
      ]),
      9_000,
    );
    expect(immune.reactionWindow).toBeNull();
    expect(immune.players[target]).toMatchObject({
      hp: immuneHp - 1,
      hand: ["xyy.card.jp01@1"],
      equipment: { armor: "xyy.card.fj02@53" },
    });
  });

  it("lets only the damaged owner use TP03, supports Bingxin cancellation, and excludes TUX_INAVO", () => {
    const initial = playing("tp03-damage-gate");
    const actor = initial.activePlayerId!;
    const target = Object.values(initial.players)
      .sort((left, right) => left.seat - right.seat)
      .find(
        (player) =>
          player.id !== actor &&
          (player.seat + 1) % 6 !== initial.players[actor]!.seat,
      )!.id;
    const counter = Object.values(initial.players)
      .sort((left, right) => left.seat - right.seat)
      .find(
        (player) => player.seat === (initial.players[target]!.seat + 1) % 6,
      )!.id;

    const openDamageWindow = (input: MatchState, prefix: string) => {
      let next = accepted(
        input,
        actor,
        `${prefix}-play-jp05`,
        {
          type: "play-card",
          cardInstanceId: "xyy.card.jp05@10",
          targetPlayerIds: [target],
        },
        1_000,
      );
      let passIndex = 0;
      while (next.effectStack.at(-1)?.kind !== "damage-batch") {
        const window = next.reactionWindow!;
        const priority = window.priorityOrder[window.priorityIndex]!;
        next = accepted(
          next,
          priority,
          `${prefix}-original-pass-${passIndex}`,
          { type: "pass-reaction", windowId: window.windowId },
          2_000 + passIndex,
        );
        passIndex += 1;
        if (passIndex > 6) throw new Error("JP05 window did not close.");
      }
      return next;
    };

    let protectedState = arrange(initial, {
      [actor]: ["xyy.card.jp05@10"],
      [target]: ["xyy.card.tp03@39"],
    });
    protectedState = {
      ...protectedState,
      players: {
        ...protectedState.players,
        [target]: { ...protectedState.players[target]!, hp: 2 },
      },
    };
    protectedState = openDamageWindow(protectedState, "tp03-protect");
    const damageEffectId = protectedState.effectStack.at(-1)!.effectId;
    expect(protectedState.players[target]!.hp).toBe(2);
    expect(protectedState.reactionWindow?.priorityOrder).toEqual([target]);
    expect(createPlayerView(protectedState, target).availableActions).toEqual([
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp03@39",
        targetEffectId: damageEffectId,
      },
      {
        type: "pass-reaction",
        windowId: protectedState.reactionWindow!.windowId,
      },
    ]);
    expect(createPlayerView(protectedState, actor).availableActions).toEqual(
      [],
    );
    protectedState = accepted(
      protectedState,
      target,
      "tp03-protect-card",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp03@39",
        targetEffectId: damageEffectId,
      },
      3_000,
    );
    protectedState = passAllReactions(protectedState, 4_000);
    expect(protectedState.players[target]).toMatchObject({
      hp: 2,
      alive: true,
    });
    expect(protectedState.dyingBatch).toBeNull();
    expect(protectedState.discardPile).toEqual(
      expect.arrayContaining(["xyy.card.jp05@10", "xyy.card.tp03@39"]),
    );

    let timeoutState = arrange(initial, {
      [actor]: ["xyy.card.jp05@10"],
      [target]: ["xyy.card.tp03@39"],
    });
    timeoutState = {
      ...timeoutState,
      players: {
        ...timeoutState.players,
        [target]: { ...timeoutState.players[target]!, hp: 2 },
      },
    };
    timeoutState = openDamageWindow(timeoutState, "tp03-timeout");
    const deadline = collectSystemDeadlines(timeoutState).find((candidate) =>
      candidate.targetId.startsWith("reaction:"),
    )!;
    expect(deadline.playerId).toBe(target);
    expect(deadline.deadlineAt - timeoutState.reactionWindow!.openedAt).toBe(
      15_000,
    );
    const timedOut = applyCommand(timeoutState, {
      origin: "system-timeout",
      commandId: "tp03-damage-timeout",
      matchId: timeoutState.matchId,
      expectedVersion: timeoutState.version,
      deadlineAt: deadline.deadlineAt,
      targetId: deadline.targetId,
    });
    expect(timedOut.accepted).toBe(true);
    if (!timedOut.accepted) throw new Error(timedOut.reason);
    expect(timedOut.state.players[target]!.hp).toBe(0);
    expect(timedOut.state.players[target]!.hand).toEqual(["xyy.card.tp03@39"]);

    let cancelledState = arrange(initial, {
      [actor]: ["xyy.card.jp05@10"],
      [target]: ["xyy.card.tp03@39"],
      [counter]: ["xyy.card.tp01@33"],
    });
    cancelledState = {
      ...cancelledState,
      players: {
        ...cancelledState.players,
        [target]: { ...cancelledState.players[target]!, hp: 2 },
      },
    };
    cancelledState = openDamageWindow(cancelledState, "tp03-cancel");
    cancelledState = accepted(
      cancelledState,
      target,
      "tp03-cancel-card",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp03@39",
        targetEffectId: cancelledState.effectStack.at(-1)!.effectId,
      },
      3_000,
    );
    expect(
      cancelledState.reactionWindow?.priorityOrder[
        cancelledState.reactionWindow.priorityIndex
      ],
    ).toBe(counter);
    cancelledState = accepted(
      cancelledState,
      counter,
      "tp03-bingxin",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: cancelledState.effectStack.at(-1)!.effectId,
      },
      4_000,
    );
    cancelledState = passAllReactions(cancelledState, 5_000);
    expect(cancelledState.players[target]).toMatchObject({
      hp: 0,
      alive: true,
    });
    expect(cancelledState.dyingBatch?.currentTargetPlayerId).toBe(target);

    let inclinationState = arrange(initial, {
      [target]: ["xyy.card.tp03@39"],
    });
    inclinationState = {
      ...inclinationState,
      players: {
        ...inclinationState.players,
        [target]: { ...inclinationState.players[target]!, hp: 2 },
      },
    };
    const inclination = planDamageBatch(inclinationState, [
      {
        itemId: "inclination-damage",
        sourcePlayerId: actor,
        targetPlayerId: target,
        amount: 2,
        element: "none",
        hpEvoMask: ["tux-inavo"],
      },
    ]);
    inclinationState = beginDamageResponse(
      inclinationState,
      "inclination-effect",
      actor,
      inclination,
      9_000,
    );
    expect(inclinationState.reactionWindow).toBeNull();
    expect(inclinationState.players[target]!.hp).toBe(0);
    expect(inclinationState.players[target]!.hand).toEqual([
      "xyy.card.tp03@39",
    ]);

    let multiState = arrange(initial, {
      [target]: ["xyy.card.tp03@39"],
    });
    const hpBefore = multiState.players[target]!.hp;
    const multiple = planDamageBatch(multiState, [
      {
        itemId: "multi-normal-one",
        sourcePlayerId: actor,
        targetPlayerId: target,
        amount: 1,
        element: "fire",
      },
      {
        itemId: "multi-normal-two",
        sourcePlayerId: actor,
        targetPlayerId: target,
        amount: 2,
        element: "thunder",
      },
    ]);
    multiState = beginDamageResponse(
      multiState,
      "multi-damage-effect",
      actor,
      multiple,
      10_000,
    );
    multiState = accepted(
      multiState,
      target,
      "tp03-multi-card",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp03@39",
        targetEffectId: multiState.effectStack.at(-1)!.effectId,
      },
      11_000,
    );
    multiState = passAllReactions(multiState, 12_000);
    expect(multiState.players[target]!.hp).toBe(hpBefore);
    expect(multiState.dyingBatch).toBeNull();
  });

  it("lets Bingxin cancel JP05 before damage and enforces rescue privacy and deadline", () => {
    let state = playing("cancel-damage");
    const actor = state.activePlayerId!;
    const ordered = Object.values(state.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const actorIndex = ordered.findIndex((player) => player.id === actor);
    const responder = ordered[(actorIndex + 1) % ordered.length]!.id;
    const target = ordered[(actorIndex + 2) % ordered.length]!.id;
    state = arrange(state, {
      [actor]: ["xyy.card.jp05@10"],
      [responder]: ["xyy.card.tp01@33"],
    });
    state = {
      ...state,
      players: {
        ...state.players,
        [target]: { ...state.players[target]!, hp: 2 },
      },
    };
    state = accepted(
      state,
      actor,
      "cancelled-jp05",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [target],
      },
      1_000,
    );
    state = accepted(
      state,
      responder,
      "cancel-jp05-with-bingxin",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: state.effectStack[0]!.effectId,
      },
      2_000,
    );
    state = passAllReactions(state, 3_000);
    expect(state.players[target]).toMatchObject({ hp: 2, alive: true });
    expect(state.dyingBatch).toBeNull();

    const damage = planDamageBatch(state, [
      {
        itemId: "privacy-damage",
        sourcePlayerId: actor,
        targetPlayerId: target,
        amount: 2,
        element: "thunder",
      },
    ]);
    state = applyPlannedDamage(state, "privacy-effect", damage, 10_000);
    const priority = state.dyingBatch!.priorityOrder[0]!;
    const other = state.dyingBatch!.priorityOrder[1]!;
    expect(createPlayerView(state, other).availableActions).toEqual([]);
    expect(
      applied(
        state,
        other,
        "wrong-rescue-priority",
        { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
        11_000,
      ),
    ).toEqual({
      accepted: false,
      reason: "not-available",
      currentVersion: state.version,
    });
    expect(
      applied(
        state,
        priority,
        "late-rescue-pass",
        { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
        state.pendingChoice!.deadlineAt + 1,
      ),
    ).toEqual({
      accepted: false,
      reason: "expired-window",
      currentVersion: state.version,
    });
  });

  it("processes simultaneous dying by seat, then cleans every dead card zone", () => {
    let state = playing("multi-dying");
    const ordered = Object.values(state.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const first = ordered[0]!.id;
    const second = ordered[1]!.id;
    state = arrange(
      state,
      {
        [first]: ["xyy.card.tp02@36"],
        [second]: ["xyy.card.jp01@1"],
      },
      {
        [second]: { weapon: "xyy.card.wq01@47", armor: "xyy.card.fj01@52" },
      },
    );
    state = {
      ...state,
      players: {
        ...state.players,
        [first]: { ...state.players[first]!, hp: 1 },
        [second]: { ...state.players[second]!, hp: 1 },
      },
    };
    const applied = planDamageBatch(state, [
      {
        itemId: "batch-first",
        sourcePlayerId: null,
        targetPlayerId: first,
        amount: 1,
        element: "thunder",
      },
      {
        itemId: "batch-second",
        sourcePlayerId: null,
        targetPlayerId: second,
        amount: 1,
        element: "thunder",
      },
    ]);
    state = applyPlannedDamage(state, "batch-effect", applied, 1_000);
    expect(state.dyingBatch?.targetPlayerIds).toEqual([first, second]);
    state = accepted(
      state,
      first,
      "rescue-first",
      {
        type: "play-rescue-card",
        cardInstanceId: "xyy.card.tp02@36",
        targetPlayerId: first,
      },
      2_000,
    );
    expect(state.dyingBatch?.currentTargetPlayerId).toBe(second);
    state = passAllRescue(state, 3_000);
    expect(state.players[first]).toMatchObject({ alive: true, hp: 2 });
    expect(state.players[second]).toMatchObject({
      alive: false,
      hp: 0,
      hand: [],
      equipment: { weapon: null, armor: null },
    });
    expect(state.dyingBatch).toBeNull();
    expect(state.discardPile).toEqual(
      expect.arrayContaining([
        "xyy.card.tp02@36",
        "xyy.card.jp01@1",
        "xyy.card.wq01@47",
        "xyy.card.fj01@52",
      ]),
    );
  });

  it("defers victory until a simultaneous two-team death cycle completes", () => {
    let state = playing("simultaneous-draw");
    const teamOne = Object.values(state.players).find(
      (player) => player.team === 1,
    )!;
    const teamTwo = Object.values(state.players).find(
      (player) => player.team === 2,
    )!;
    state = arrange(state, {});
    state = {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          player.id === teamOne.id || player.id === teamTwo.id
            ? {
                ...player,
                heroId: "xyy.hero.xj201",
                alive: true,
                hp: 1,
              }
            : { ...player, alive: false, hp: 0 },
        ]),
      ),
    };
    const damage = planDamageBatch(state, [
      {
        itemId: "wipe-team-one",
        sourcePlayerId: null,
        targetPlayerId: teamOne.id,
        amount: 1,
        element: "thunder",
      },
      {
        itemId: "wipe-team-two",
        sourcePlayerId: null,
        targetPlayerId: teamTwo.id,
        amount: 1,
        element: "thunder",
      },
    ]);
    state = applyPlannedDamage(state, "wipe-effect", damage, 1_000);
    const firstTarget = state.dyingBatch!.currentTargetPlayerId;
    state = passAllRescue(state, 2_000);
    expect(state.phase).toBe("playing");
    expect(state.winner).toBeNull();
    expect(state.dyingBatch?.currentTargetPlayerId).not.toBe(firstTarget);
    state = passAllRescue(state, 3_000);
    expect(state.phase).toBe("finished");
    expect(state.winner).toBe("draw");
    expect(state.dyingBatch).toBeNull();
  });
});
