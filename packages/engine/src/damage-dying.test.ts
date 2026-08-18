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
  while (next.dyingBatch?.currentTargetPlayerId === target) {
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
        appliedReplacementEffectIds: ["effect-replace"],
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

  it("resolves JP05 only after reactions and lets the dying target use TP02", () => {
    let state = playing("single-rescue");
    const actor = state.activePlayerId!;
    const target = Object.values(state.players)
      .sort((left, right) => left.seat - right.seat)
      .find((player) => player.id !== actor)!.id;
    state = arrange(state, {
      [actor]: ["xyy.card.jp05@10"],
      [target]: ["xyy.card.tp02@36"],
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
    expect(state.players[target]).toMatchObject({ hp: 2, alive: true });
    expect(state.dyingBatch).toBeNull();
    expect(state.pendingChoice).toBeNull();
    expect(state.discardPile).toEqual(
      expect.arrayContaining(["xyy.card.jp05@10", "xyy.card.tp02@36"]),
    );
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
            ? { ...player, alive: true, hp: 1 }
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
