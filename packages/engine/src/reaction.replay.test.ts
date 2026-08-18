import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  createSetupMatch,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  type CardInstanceId,
  type DomainEvent,
  type MatchState,
} from "./index.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `reaction-replay-${index + 1}`,
  nickname: `Reaction Replay ${index + 1}`,
}));

function apply(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
  serverReceivedAt: number,
): { readonly state: MatchState; readonly events: readonly DomainEvent[] } {
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

function started(): MatchState {
  let state = createSetupMatch({
    matchId: "m04-reaction-replay-match",
    rulesetVersion: "standard-fengmingyushi@1",
    seed: "m04-reaction-replay-seed",
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
  return state;
}

function arranged(): {
  readonly state: MatchState;
  readonly actor: PlayerId;
  readonly first: PlayerId;
  readonly second: PlayerId;
} {
  const state = started();
  const actor = state.activePlayerId!;
  const order = Object.values(state.players)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  const actorIndex = order.indexOf(actor);
  const first = order[(actorIndex + 1) % order.length]!;
  const second = order[(actorIndex + 2) % order.length]!;
  const hands: Record<PlayerId, readonly CardInstanceId[]> = {
    [actor]: ["xyy.card.jp04@7"],
    [first]: ["xyy.card.tp01@33"],
    [second]: ["xyy.card.tp01@34"],
  };
  const claimed = new Set(Object.values(hands).flat());
  return {
    actor,
    first,
    second,
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
  };
}

describe("M04 reaction event replay", () => {
  it("resumes the mixed-zone JP06 choice identically after a JSON restart", () => {
    const startedState = started();
    const actor = startedState.activePlayerId!;
    const ordered = Object.values(startedState.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const actorIndex = ordered.findIndex((player) => player.id === actor);
    const target = ordered[(actorIndex + 1) % ordered.length]!.id;
    const claimed = new Set<CardInstanceId>([
      "xyy.card.jp06@13",
      "xyy.card.jp04@7",
      "xyy.card.wq01@47",
    ]);
    const initial: MatchState = {
      ...startedState,
      players: Object.fromEntries(
        Object.values(startedState.players).map((player) => [
          player.id,
          {
            ...player,
            hand:
              player.id === actor
                ? ["xyy.card.jp06@13"]
                : player.id === target
                  ? ["xyy.card.jp04@7"]
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
    const events: DomainEvent[] = [];
    let next = apply(
      initial,
      actor,
      "jp06-play",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp06@13",
        targetPlayerIds: [target],
      },
      1_000,
    );
    events.push(...next.events);
    let passSequence = 0;
    while (next.state.reactionWindow !== null) {
      const window = next.state.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      next = apply(
        next.state,
        priority,
        `jp06-pass-${passSequence}`,
        { type: "pass-reaction", windowId: window.windowId },
        2_000 + passSequence * 100,
      );
      events.push(...next.events);
      passSequence += 1;
    }
    expect(next.state.pendingChoice?.optionIds).toEqual([
      "opaque-hand-slot-1",
      "equipment:weapon",
    ]);
    const uninterrupted = next.state;
    const restarted = JSON.parse(JSON.stringify(next.state)) as MatchState;
    const choice = {
      type: "submit-choice" as const,
      choiceId: uninterrupted.pendingChoice!.choiceId,
      selections: ["equipment:weapon"],
    };
    const primary = apply(uninterrupted, actor, "jp06-choose", choice, 3_000);
    const recovered = apply(restarted, actor, "jp06-choose", choice, 3_000);
    expect(recovered).toEqual(primary);
    events.push(...primary.events);
    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(primary.state);
    expect(primary.state.players[target]!.equipment.weapon).toBeNull();
    expect(primary.state.discardPile).toEqual(
      expect.arrayContaining(["xyy.card.jp06@13", "xyy.card.wq01@47"]),
    );
  });

  it("resumes the opaque JP01 hand choice identically after a JSON restart", () => {
    const startedState = started();
    const actor = startedState.activePlayerId!;
    const ordered = Object.values(startedState.players).sort(
      (left, right) => left.seat - right.seat,
    );
    const actorIndex = ordered.findIndex((player) => player.id === actor);
    const target = ordered[(actorIndex + 1) % ordered.length]!.id;
    const claimed = new Set<CardInstanceId>([
      "xyy.card.jp01@1",
      "xyy.card.jp04@7",
      "xyy.card.jp05@10",
    ]);
    const initial: MatchState = {
      ...startedState,
      players: Object.fromEntries(
        Object.values(startedState.players).map((player) => [
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
    const events: DomainEvent[] = [];
    let next = apply(
      initial,
      actor,
      "jp01-play",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp01@1",
        targetPlayerIds: [target],
      },
      1_000,
    );
    events.push(...next.events);
    let passSequence = 0;
    while (next.state.reactionWindow !== null) {
      const window = next.state.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      next = apply(
        next.state,
        priority,
        `jp01-pass-${passSequence}`,
        { type: "pass-reaction", windowId: window.windowId },
        2_000 + passSequence * 100,
      );
      events.push(...next.events);
      passSequence += 1;
    }
    expect(next.state.pendingChoice?.optionIds).toEqual([
      "opaque-hand-slot-1",
      "opaque-hand-slot-2",
    ]);
    const uninterrupted = next.state;
    const restarted = JSON.parse(JSON.stringify(next.state)) as MatchState;
    const choice = {
      type: "submit-choice" as const,
      choiceId: uninterrupted.pendingChoice!.choiceId,
      selections: ["opaque-hand-slot-2"],
    };
    const primary = apply(uninterrupted, actor, "jp01-choose", choice, 3_000);
    const recovered = apply(restarted, actor, "jp01-choose", choice, 3_000);
    expect(recovered).toEqual(primary);
    events.push(...primary.events);
    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(primary.state);
    expect(primary.state.players[actor]!.hand).toEqual(["xyy.card.jp05@10"]);
    expect(primary.state.players[target]!.hand).toEqual(["xyy.card.jp04@7"]);
  });

  it("replays JP03 team healing identically after a JSON restart", () => {
    const startedState = started();
    const actor = startedState.activePlayerId!;
    const team = startedState.players[actor]!.team;
    const allies = Object.values(startedState.players)
      .filter((player) => player.alive && player.team === team)
      .sort((left, right) => left.seat - right.seat)
      .map((player) => player.id);
    const initial: MatchState = {
      ...startedState,
      players: Object.fromEntries(
        Object.values(startedState.players).map((player) => [
          player.id,
          {
            ...player,
            hp: player.maxHp - 1,
            hand:
              player.id === actor
                ? (["xyy.card.jp03@5"] as readonly CardInstanceId[])
                : [],
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter(
        (card) => card !== "xyy.card.jp03@5",
      ),
      discardPile: [],
    };
    const played = apply(
      initial,
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
    const events = [...played.events];
    let uninterrupted = played.state;
    let restarted = JSON.parse(JSON.stringify(played.state)) as MatchState;
    let passSequence = 0;
    while (uninterrupted.reactionWindow !== null) {
      const window = uninterrupted.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      const command = {
        type: "pass-reaction" as const,
        windowId: window.windowId,
      };
      const commandId = `jp03-pass-${passSequence}`;
      const now = 2_000 + passSequence * 100;
      const primary = apply(uninterrupted, priority, commandId, command, now);
      const recovered = apply(restarted, priority, commandId, command, now);
      expect(recovered).toEqual(primary);
      uninterrupted = primary.state;
      restarted = recovered.state;
      events.push(...primary.events);
      passSequence += 1;
    }
    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(restarted).toEqual(uninterrupted);
    expect(replayed).toEqual(uninterrupted);
    for (const playerId of allies) {
      expect(uninterrupted.players[playerId]!.hp).toBe(
        uninterrupted.players[playerId]!.maxHp,
      );
    }
    for (const player of Object.values(uninterrupted.players)) {
      if (!allies.includes(player.id)) expect(player.hp).toBe(player.maxHp - 1);
    }
  });

  it("replays TP02 normal healing identically after a JSON restart", () => {
    const initialState = started();
    const actor = initialState.activePlayerId!;
    const initial: MatchState = {
      ...initialState,
      players: Object.fromEntries(
        Object.values(initialState.players).map((player) => [
          player.id,
          {
            ...player,
            hp: player.id === actor ? player.maxHp - 2 : player.hp,
            hand:
              player.id === actor
                ? (["xyy.card.tp02@36"] as readonly CardInstanceId[])
                : [],
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter(
        (card) => card !== "xyy.card.tp02@36",
      ),
      discardPile: [],
    };
    const played = apply(
      initial,
      actor,
      "tp02-normal",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.tp02@36",
        targetPlayerIds: [actor],
      },
      1_000,
    );
    const events = [...played.events];
    let uninterrupted = played.state;
    let restarted = JSON.parse(JSON.stringify(played.state)) as MatchState;
    let passSequence = 0;
    while (uninterrupted.reactionWindow !== null) {
      const window = uninterrupted.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      const command = {
        type: "pass-reaction" as const,
        windowId: window.windowId,
      };
      const commandId = `tp02-pass-${passSequence}`;
      const now = 2_000 + passSequence * 100;
      const primary = apply(uninterrupted, priority, commandId, command, now);
      const recovered = apply(restarted, priority, commandId, command, now);
      expect(recovered).toEqual(primary);
      uninterrupted = primary.state;
      restarted = recovered.state;
      events.push(...primary.events);
      passSequence += 1;
    }
    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(restarted).toEqual(uninterrupted);
    expect(replayed).toEqual(uninterrupted);
    expect(uninterrupted.players[actor]!.hp).toBe(
      uninterrupted.players[actor]!.maxHp,
    );
  });

  it("replays and resumes identically across a JSON restart in a nested window", () => {
    const fixture = arranged();
    const initial = fixture.state;
    const events: DomainEvent[] = [];
    let next = apply(
      initial,
      fixture.actor,
      "play-original",
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp04@7",
        targetPlayerIds: [fixture.actor],
      },
      1_000,
    );
    events.push(...next.events);
    const originalEffectId = next.state.effectStack[0]!.effectId;
    next = apply(
      next.state,
      fixture.first,
      "play-first-bingxin",
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: originalEffectId,
      },
      2_000,
    );
    events.push(...next.events);

    let uninterrupted = next.state;
    let restarted = JSON.parse(JSON.stringify(next.state)) as MatchState;
    const firstBingxinId = uninterrupted.effectStack.at(-1)!.effectId;
    const counter = {
      type: "play-reaction-card" as const,
      cardInstanceId: "xyy.card.tp01@34",
      targetEffectId: firstBingxinId,
    };
    const primaryCounter = apply(
      uninterrupted,
      fixture.second,
      "play-second-bingxin",
      counter,
      3_000,
    );
    const restartedCounter = apply(
      restarted,
      fixture.second,
      "play-second-bingxin",
      counter,
      3_000,
    );
    expect(restartedCounter).toEqual(primaryCounter);
    uninterrupted = primaryCounter.state;
    restarted = restartedCounter.state;
    events.push(...primaryCounter.events);

    let passSequence = 0;
    while (uninterrupted.reactionWindow !== null) {
      const window = uninterrupted.reactionWindow;
      const priority = window.priorityOrder[window.priorityIndex]!;
      const command = {
        type: "pass-reaction" as const,
        windowId: window.windowId,
      };
      const commandId = `pass-${passSequence}`;
      const now = 4_000 + passSequence * 100;
      const primaryPass = apply(
        uninterrupted,
        priority,
        commandId,
        command,
        now,
      );
      const restartedPass = apply(restarted, priority, commandId, command, now);
      expect(restartedPass).toEqual(primaryPass);
      uninterrupted = primaryPass.state;
      restarted = restartedPass.state;
      events.push(...primaryPass.events);
      passSequence += 1;
      if (passSequence > 12)
        throw new Error("Reaction replay did not converge.");
    }

    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted);
    expect(restarted).toEqual(uninterrupted);
    expect(uninterrupted.effectStack).toEqual([]);
    expect(uninterrupted.players[fixture.actor]!.hand).toHaveLength(2);
  });
});
