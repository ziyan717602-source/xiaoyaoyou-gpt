import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  createSetupMatch,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  type DomainEvent,
  type MatchState,
} from "./index.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `dying-replay-${index + 1}`,
  nickname: `Dying Replay ${index + 1}`,
}));

function apply(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
  serverReceivedAt: number,
) {
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
  if (!result.accepted) throw new Error(`${commandId}: ${result.reason}`);
  return result;
}

function fixture(): {
  readonly state: MatchState;
  readonly actor: PlayerId;
  readonly target: PlayerId;
  readonly rescuer: PlayerId;
} {
  let state = createSetupMatch({
    matchId: "m05-dying-replay",
    rulesetVersion: "standard-fengmingyushi@1",
    seed: "m05-dying-replay-seed",
    players: seats,
  });
  for (const playerId of state.turnOrder) {
    state = apply(
      state,
      playerId,
      `choose-${playerId}`,
      {
        type: "choose-hero",
        heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
      },
      0,
    ).state;
  }
  const actor = state.activePlayerId!;
  const ordered = Object.values(state.players).sort(
    (left, right) => left.seat - right.seat,
  );
  const actorSeat = ordered.findIndex((player) => player.id === actor);
  const target = ordered[(actorSeat + 1) % ordered.length]!.id;
  const rescuer = ordered[(actorSeat + 2) % ordered.length]!.id;
  const claimed = new Set([
    "xyy.card.jp05@10",
    "xyy.card.tp02@36",
    "xyy.card.wq02@48",
    "xyy.card.fj03@54",
  ]);
  state = {
    ...state,
    players: Object.fromEntries(
      Object.values(state.players).map((player) => [
        player.id,
        {
          ...player,
          hp: player.id === target ? 1 : player.hp,
          hand:
            player.id === actor
              ? ["xyy.card.jp05@10"]
              : player.id === rescuer
                ? ["xyy.card.tp02@36"]
                : [],
          equipment:
            player.id === target
              ? { weapon: "xyy.card.wq02@48", armor: "xyy.card.fj03@54" }
              : { weapon: null, armor: null },
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
    discardPile: [],
  };
  return { state, actor, target, rescuer };
}

describe("M05 damage/dying event replay", () => {
  it("resumes FJ01 equipment rescue identically from a JSON checkpoint", () => {
    const setup = fixture();
    const claimed = new Set([
      "xyy.card.jp05@10",
      "xyy.card.wq02@48",
      "xyy.card.fj01@52",
    ]);
    const initial: MatchState = {
      ...setup.state,
      players: Object.fromEntries(
        Object.values(setup.state.players).map((player) => [
          player.id,
          {
            ...player,
            hp: player.id === setup.target ? 2 : player.hp,
            hand: player.id === setup.actor ? ["xyy.card.jp05@10"] : [],
            equipment:
              player.id === setup.target
                ? {
                    weapon: "xyy.card.wq02@48",
                    armor: "xyy.card.fj01@52",
                  }
                : { weapon: null, armor: null },
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    const events: DomainEvent[] = [];
    let result = apply(
      initial,
      setup.actor,
      "fj01-replay-jp05",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [setup.target],
      },
      1_000,
    );
    events.push(...result.events);
    let sequence = 0;
    while (result.state.reactionWindow !== null) {
      const window = result.state.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      result = apply(
        result.state,
        priority,
        `fj01-replay-pass-${sequence}`,
        { type: "pass-reaction", windowId: window.windowId },
        2_000 + sequence,
      );
      events.push(...result.events);
      sequence += 1;
    }
    const checkpoint = result.state;
    const restarted = JSON.parse(JSON.stringify(checkpoint)) as MatchState;
    const activation = {
      type: "activate-rescue-equipment" as const,
      cardInstanceId: "xyy.card.fj01@52",
      targetPlayerId: setup.target,
    };
    const uninterrupted = apply(
      checkpoint,
      setup.target,
      "fj01-replay-activate",
      activation,
      3_000,
    );
    const resumed = apply(
      restarted,
      setup.target,
      "fj01-replay-activate",
      activation,
      3_000,
    );
    expect(resumed).toEqual(uninterrupted);
    events.push(...uninterrupted.events);
    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.players[setup.target]).toMatchObject({
      hp: 3,
      equipment: { weapon: "xyy.card.wq02@48", armor: null },
    });
  });

  it("resumes TP03 prevention identically from the serialized damage window", () => {
    const setup = fixture();
    const claimed = new Set(["xyy.card.jp05@10", "xyy.card.tp03@39"]);
    const initial: MatchState = {
      ...setup.state,
      players: Object.fromEntries(
        Object.values(setup.state.players).map((player) => [
          player.id,
          {
            ...player,
            hand:
              player.id === setup.actor
                ? ["xyy.card.jp05@10"]
                : player.id === setup.target
                  ? ["xyy.card.tp03@39"]
                  : [],
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
    };
    const events: DomainEvent[] = [];
    let result = apply(
      initial,
      setup.actor,
      "tp03-replay-jp05",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [setup.target],
      },
      1_000,
    );
    events.push(...result.events);
    let sequence = 0;
    while (result.state.effectStack.at(-1)?.kind !== "damage-batch") {
      const window = result.state.reactionWindow!;
      const priority = window.priorityOrder[window.priorityIndex]!;
      result = apply(
        result.state,
        priority,
        `tp03-replay-original-pass-${sequence}`,
        { type: "pass-reaction", windowId: window.windowId },
        2_000 + sequence,
      );
      events.push(...result.events);
      sequence += 1;
    }
    const checkpoint = result.state;
    const restarted = JSON.parse(JSON.stringify(checkpoint)) as MatchState;
    const damageEffectId = checkpoint.effectStack.at(-1)!.effectId;
    const prevention = {
      type: "play-reaction-card" as const,
      cardInstanceId: "xyy.card.tp03@39",
      targetEffectId: damageEffectId,
    };
    let uninterrupted = apply(
      checkpoint,
      setup.target,
      "tp03-replay-prevent",
      prevention,
      3_000,
    );
    let resumed = apply(
      restarted,
      setup.target,
      "tp03-replay-prevent",
      prevention,
      3_000,
    );
    expect(resumed).toEqual(uninterrupted);
    events.push(...uninterrupted.events);
    sequence = 0;
    while (uninterrupted.state.reactionWindow !== null) {
      const window = uninterrupted.state.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      const command = {
        type: "pass-reaction" as const,
        windowId: window.windowId,
      };
      const commandId = `tp03-replay-child-pass-${sequence}`;
      const now = 4_000 + sequence;
      const next = apply(
        uninterrupted.state,
        priority,
        commandId,
        command,
        now,
      );
      const recovered = apply(resumed.state, priority, commandId, command, now);
      expect(recovered).toEqual(next);
      uninterrupted = next;
      resumed = recovered;
      events.push(...next.events);
      sequence += 1;
      if (sequence > 6) throw new Error("TP03 child window did not close.");
    }
    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(resumed.state).toEqual(uninterrupted.state);
    expect(uninterrupted.state.players[setup.target]).toMatchObject({
      hp: 1,
      alive: true,
    });
    expect(uninterrupted.state.dyingBatch).toBeNull();
  });

  it("resumes identically from a JSON checkpoint inside the rescue window", () => {
    const setup = fixture();
    const initial = setup.state;
    const events: DomainEvent[] = [];
    let result = apply(
      initial,
      setup.actor,
      "play-jp05",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp05@10",
        targetPlayerIds: [setup.target],
      },
      1_000,
    );
    events.push(...result.events);
    let state = result.state;
    let sequence = 0;
    while (state.reactionWindow !== null) {
      const window = state.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      result = apply(
        state,
        priority,
        `reaction-pass-${sequence}`,
        { type: "pass-reaction", windowId: window.windowId },
        2_000 + sequence,
      );
      events.push(...result.events);
      state = result.state;
      sequence += 1;
    }
    expect(state.dyingBatch?.currentTargetPlayerId).toBe(setup.target);

    result = apply(
      state,
      setup.target,
      "target-passes-rescue",
      { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
      3_000,
    );
    events.push(...result.events);
    state = result.state;
    const restarted = JSON.parse(JSON.stringify(state)) as MatchState;
    expect(restarted).toEqual(state);
    expect(
      state.dyingBatch?.priorityOrder[state.dyingBatch.priorityIndex],
    ).toBe(setup.rescuer);

    const rescue = {
      type: "play-rescue-card" as const,
      cardInstanceId: "xyy.card.tp02@36",
      targetPlayerId: setup.target,
    };
    const uninterrupted = apply(
      state,
      setup.rescuer,
      "rescue-after-restart",
      rescue,
      4_000,
    );
    const resumed = apply(
      restarted,
      setup.rescuer,
      "rescue-after-restart",
      rescue,
      4_000,
    );
    expect(resumed).toEqual(uninterrupted);
    events.push(...uninterrupted.events);

    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.players[setup.target]).toMatchObject({
      alive: true,
      hp: 3,
    });
    expect(uninterrupted.state.dyingBatch).toBeNull();
  });
});
