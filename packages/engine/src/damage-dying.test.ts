import { describe, expect, it } from "vitest";
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

  it("lets the zero-HP owner discard FJ01 to cure and resume the dying batch", () => {
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
        [target]: { ...state.players[target]!, hp: 2 },
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
