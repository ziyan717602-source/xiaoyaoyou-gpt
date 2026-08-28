import { describe, expect, it } from "vitest";
import { beginNpcAction } from "./npc-effects.js";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type CardInstanceId,
  type MatchState,
} from "./index.js";
import {
  acceptNpcCommand,
  npcCommand,
  npcFixture,
  grantPets,
} from "./testing/npc-fixture.js";

const start = (state: MatchState) => beginNpcAction(state, "start-npc", 1_001);
function setHand(
  state: MatchState,
  owner: string,
  hand: readonly CardInstanceId[],
): MatchState {
  return {
    ...state,
    players: { ...state.players, [owner]: { ...state.players[owner]!, hand } },
    drawPile: state.drawPile.filter((id) => !hand.includes(id)),
  };
}
function passDamageAndRescue(input: MatchState): MatchState {
  let state = input;
  for (let step = 0; state.encounterState.npc !== null; step++) {
    if (step > 20) throw new Error("NPC damage failed to terminate");
    const window = state.reactionWindow;
    const batch = state.dyingBatch;
    const actor =
      window !== null
        ? window.priorityOrder[window.priorityIndex]!
        : batch!.priorityOrder[batch!.priorityIndex]!;
    const command = npcCommand(
      state,
      actor,
      window !== null
        ? { type: "pass-reaction", windowId: window.windowId }
        : { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
    );
    const result = applyCommand(state, command);
    if (!result.accepted) throw new Error(result.reason);
    expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
    state = migrateMatchState(JSON.parse(JSON.stringify(result.state)));
  }
  return state;
}
describe("CS03-03B concrete NPC effects through MatchState and command/event pipeline", () => {
  it("NJ05 ordinary FROM_NMB damage can be prevented by a real TP03 response and still finishes the NPC", () => {
    let input = npcFixture("xyy.npc-action.nj05");
    const actor = input.activePlayerId!,
      target = input.turnOrder.find((id) => id !== actor)!;
    input = setHand(input, target, ["xyy.card.tp03@39"]);
    const waiting = acceptNpcCommand(start(input).state, actor, [target]).state;
    const command = npcCommand(waiting, target, {
      type: "play-reaction-card",
      cardInstanceId: "xyy.card.tp03@39",
      targetEffectId: waiting.effectStack.at(-1)!.effectId,
    });
    const response = applyCommand(
      migrateMatchState(JSON.parse(JSON.stringify(waiting))),
      command,
    );
    if (!response.accepted) throw new Error(response.reason);
    expect(response.events.reduce(reduceEvent, waiting)).toEqual(
      response.state,
    );
    const finished = passDamageAndRescue(response.state);
    expect(finished.players[target]!.hp).toBe(input.players[target]!.hp);
    expect(finished.discardPile).toContain("xyy.card.tp03@39");
    expect(finished.encounterState.npc).toBeNull();
  });
  it("NJ03 waits through JN50203 loot and its nested self-damage, while death companions are already discarded", () => {
    let input = npcFixture("xyy.npc-action.nj03");
    const actor = input.activePlayerId!,
      owner = input.turnOrder.find((id) => id !== actor)!;
    const companion = input.encounterDeck.find((id) =>
      id.startsWith("xyy.npc."),
    )!;
    input = setHand(input, actor, ["xyy.card.jp02@3"]);
    input = {
      ...input,
      players: {
        ...input.players,
        [actor]: { ...input.players[actor]!, hp: 1 },
        [owner]: {
          ...input.players[owner]!,
          heroId: "xyy.hero.xj402",
          hp: 3,
          maxHp: 3,
        },
      },
      encounterDeck: input.encounterDeck.filter((id) => id !== companion),
      encounterState: {
        ...input.encounterState,
        companions: { [actor]: [companion as `xyy.npc.${string}`] },
      },
    };
    input = grantPets(input, actor, ["xyy.monster.gs04", "xyy.monster.gl04"]);
    let state = acceptNpcCommand(start(input).state, actor, [owner]).state;
    for (
      let step = 0;
      state.dyingBatch?.status !== "distributing-loot";
      step++
    ) {
      if (step > 10) throw new Error("NPC never reached death loot");
      const w = state.reactionWindow,
        b = state.dyingBatch;
      const who =
        w !== null
          ? w.priorityOrder[w.priorityIndex]!
          : b!.priorityOrder[b!.priorityIndex]!;
      const result = applyCommand(
        state,
        npcCommand(
          state,
          who,
          w !== null
            ? { type: "pass-reaction", windowId: w.windowId }
            : { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
        ),
      );
      if (!result.accepted) throw new Error(result.reason);
      expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
      state = migrateMatchState(JSON.parse(JSON.stringify(result.state)));
    }
    expect(state.encounterState.pets[actor]).toBeUndefined();
    expect(state.encounterDiscard).toEqual(
      expect.arrayContaining(["xyy.monster.gs04", "xyy.monster.gl04"]),
    );
    expect(state.players[actor]!.strength).toBe(
      input.players[actor]!.strength - 1,
    );
    expect(state.players[actor]!.dexterity).toBe(
      input.players[actor]!.dexterity - 1,
    );
    expect(state.encounterState.weaponDisabledReasons).toEqual({});
    expect(state.encounterDiscard).toEqual([
      "xyy.monster.gs04",
      "xyy.monster.gl04",
      companion,
    ]);
    expect(state.encounterState.companions[actor]).toBeUndefined();
    expect(state.encounterState.resolution!.heldCardId).toBe(
      input.encounterState.resolution!.heldCardId,
    );
    expect(state.players[owner]!.hand).toEqual(["xyy.card.jp02@3"]);
    const finishedLoot = applyCommand(
      state,
      npcCommand(state, owner, {
        type: "finish-death-loot",
        choiceId: state.pendingChoice!.choiceId,
      }),
    );
    if (!finishedLoot.accepted) throw new Error(finishedLoot.reason);
    expect(finishedLoot.events.reduce(reduceEvent, state)).toEqual(
      finishedLoot.state,
    );
    expect(finishedLoot.state.encounterState.npc).not.toBeNull();
    const finished = passDamageAndRescue(finishedLoot.state);
    expect(finished.players[owner]!.hand).toEqual([
      "xyy.card.jp02@3",
      input.drawPile[0],
    ]);
    expect(finished.players[owner]!.hp).toBe(2);
    expect(finished.encounterDiscard).toEqual([
      "xyy.monster.gs04",
      "xyy.monster.gl04",
      companion,
      input.encounterState.resolution!.heldCardId,
    ]);
  });
  it("death clears a player's companion into the encounter discard without consuming the held NPC early or another player's companion", () => {
    let input = npcFixture("xyy.npc-action.nj03");
    const actor = input.activePlayerId!;
    const other = input.turnOrder.find((id) => id !== actor)!;
    const companions = input.encounterDeck
      .filter((id) => id.startsWith("xyy.npc."))
      .slice(0, 2);
    input = {
      ...input,
      players: {
        ...input.players,
        [actor]: { ...input.players[actor]!, hp: 1 },
      },
      encounterDeck: input.encounterDeck.filter(
        (id) => !companions.includes(id),
      ),
      encounterState: {
        ...input.encounterState,
        companions: {
          [actor]: [companions[0] as `xyy.npc.${string}`],
          [other]: [companions[1] as `xyy.npc.${string}`],
        },
      },
    };
    input = grantPets(input, actor, ["xyy.monster.gt04"]);
    const waiting = acceptNpcCommand(start(input).state, actor, [other]).state;
    const finished = passDamageAndRescue(waiting);
    expect(finished.encounterState.companions[actor] ?? []).toEqual([]);
    expect(finished.encounterState.companions[other]).toEqual([companions[1]]);
    expect(finished.encounterDiscard).toEqual([
      "xyy.monster.gt04",
      companions[0],
      input.encounterState.resolution!.heldCardId,
    ]);
    expect(finished.encounterState.pets[actor]).toBeUndefined();
    expect(finished.players[actor]!.strength).toBe(
      input.players[actor]!.strength - 2,
    );
    expect(finished.players[actor]!.dexterity).toBe(
      input.players[actor]!.dexterity - 1,
    );
  });
  it("NJ05 completes real damage/death/victory and disposes its held NPC even when victory clears the active player", () => {
    let input = npcFixture("xyy.npc-action.nj05");
    const actor = input.activePlayerId!;
    const enemyTeam = input.players[actor]!.team === 1 ? 2 : 1;
    const target = input.turnOrder.find(
      (id) => input.players[id]!.team === enemyTeam,
    )!;
    input = {
      ...input,
      players: Object.fromEntries(
        Object.values(input.players).map((p) => [
          p.id,
          p.team !== enemyTeam
            ? p
            : { ...p, alive: p.id === target, hp: p.id === target ? 1 : 0 },
        ]),
      ),
    };
    const waiting = acceptNpcCommand(start(input).state, actor, [target]).state;
    const finished = passDamageAndRescue(waiting);
    expect(finished.phase).toBe("finished");
    expect(finished.winner).toBe(input.players[actor]!.team);
    expect(finished.activePlayerId).toBeNull();
    expect(finished.encounterState.resolution!.heldCardId).toBeNull();
    expect(finished.encounterDiscard).toContain(
      input.encounterState.resolution!.heldCardId,
    );
  });
  it("NJ03 draws for a living recipient after source death, but fizzles a dead recipient without consuming the deck (SEM-010)", () => {
    for (const selfTarget of [true, false]) {
      let input = npcFixture("xyy.npc-action.nj03");
      const actor = input.activePlayerId!;
      const target = selfTarget
        ? actor
        : input.turnOrder.find((id) => id !== actor)!;
      input = {
        ...input,
        players: {
          ...input.players,
          [actor]: { ...input.players[actor]!, hp: 1 },
        },
      };
      const waiting = acceptNpcCommand(start(input).state, actor, [
        target,
      ]).state;
      const finished = passDamageAndRescue(waiting);
      expect(finished.players[actor]!.alive).toBe(false);
      expect(finished.players[target]!.hand).toHaveLength(selfTarget ? 0 : 1);
      expect(finished.drawPile).toEqual(
        selfTarget ? input.drawPile : input.drawPile.slice(1),
      );
    }
  });
  it("NJ08 discards exactly one seeded random hand card; NJ09 transfers the NPC; unsupported handlers remain explicit", () => {
    let input = npcFixture("xyy.npc-action.nj08");
    const actor = input.activePlayerId!,
      target = input.turnOrder.find((id) => id !== actor)!;
    input = setHand(input, target, ["xyy.card.jp02@3", "xyy.card.tp01@33"]);
    const opened = start(input).state;
    const result = acceptNpcCommand(opened, actor, [target]);
    expect(result.state.players[target]!.hand).toHaveLength(1);
    expect(result.state.discardPile).toHaveLength(1);
    expect(
      [
        ...result.state.players[target]!.hand,
        ...result.state.discardPile,
      ].sort(),
    ).toEqual([...input.players[target]!.hand].sort());
    expect(result.state.rng.cursor).toBeGreaterThan(input.rng.cursor);
    expect(
      acceptNpcCommand(
        migrateMatchState(JSON.parse(JSON.stringify(opened))),
        actor,
        [target],
      ),
    ).toEqual(result);
    const companionInput = npcFixture("xyy.npc-action.nj09");
    const companion = start(companionInput).state;
    expect(
      companion.encounterState.companions[companion.activePlayerId!],
    ).toEqual([companionInput.encounterState.resolution!.heldCardId]);
    expect(companion.encounterDiscard).toEqual([]);
    expect(() => start(npcFixture("xyy.npc-action.nj01"))).toThrow(
      "not implemented",
    );
    expect(() => start(npcFixture("xyy.npc-action.nj07"))).toThrow(
      "no legal target",
    );
  });
  it("NJ04 actually draws one, closes the held NPC once, and replays the authoritative event", () => {
    const input = npcFixture("xyy.npc-action.nj04");
    const result = start(input);
    const actor = input.activePlayerId!;
    expect(result.state.players[actor]!.hand).toEqual([input.drawPile[0]]);
    expect(result.state.drawPile).toEqual(input.drawPile.slice(1));
    expect(result.state.encounterState.resolution).toMatchObject({
      stage: "completed",
      heldCardId: null,
      rewardDrawCount: 2,
    });
    expect(result.state.encounterDiscard).toContain(
      input.encounterState.resolution!.heldCardId,
    );
    expect(result.events.reduce(reduceEvent, input)).toEqual(result.state);
    expect(() => start(result.state)).toThrow();
    for (const other of Object.keys(input.players).filter((id) => id !== actor))
      expect(
        JSON.stringify(createPlayerView(result.state, other)),
      ).not.toContain(input.drawPile[0]!);
  });
  it("NJ02 offers all living targets, then heals with null source/from-nmb and existing equipment modifiers", () => {
    let input = npcFixture("xyy.npc-action.nj02");
    const actor = input.activePlayerId!;
    const target = input.turnOrder.find((id) => id !== actor)!;
    input = {
      ...input,
      players: {
        ...input.players,
        [target]: {
          ...input.players[target]!,
          hp: 1,
          maxHp: 4,
          equipment: { weapon: "xyy.card.wq02@48", armor: null },
        },
      },
      drawPile: input.drawPile.filter((id) => id !== "xyy.card.wq02@48"),
    };
    const begun = start(input);
    expect(begun.state.pendingChoice).toMatchObject({
      playerIds: [actor],
      optionIds: Object.keys(input.players),
      openedAt: 1_001,
      deadlineAt: 16_001,
      optional: false,
    });
    const result = acceptNpcCommand(begun.state, actor, [target]);
    expect(result.state.players[target]!.hp).toBe(3);
    expect(result.state.pendingChoice).toBeNull();
    expect(result.state.encounterState.npc).toBeNull();
    expect(result.events.reduce(reduceEvent, begun.state)).toEqual(
      result.state,
    );
    expect(JSON.stringify(result.events)).toContain("from-nmb");
    expect(JSON.stringify(result.events)).toContain('"sourcePlayerId":null');
    for (const other of Object.keys(input.players).filter((id) => id !== actor))
      expect(createPlayerView(begun.state, other).availableActions).toEqual([]);
  });
  it("NJ06 makes the donor choose privately, transfers to a different living teammate, and keeps 56 cards", () => {
    let input = npcFixture("xyy.npc-action.nj06");
    const actor = input.activePlayerId!;
    const donor = Object.keys(input.players).find((id) => id !== actor)!;
    const recipient = Object.keys(input.players).find(
      (id) =>
        id !== donor && input.players[id]!.team === input.players[donor]!.team,
    )!;
    const hand = ["xyy.card.jp02@3", "xyy.card.tp01@33"] as const;
    input = setHand(input, donor, hand);
    let state = start(input).state;
    state = acceptNpcCommand(state, actor, [donor]).state;
    expect(state.pendingChoice!.optionIds).toContain(recipient);
    expect(state.pendingChoice!.optionIds).not.toContain(donor);
    state = acceptNpcCommand(state, actor, [recipient]).state;
    expect(state.pendingChoice!.playerIds).toEqual([donor]);
    expect(createPlayerView(state, donor).pendingChoice!.optionIds).toEqual(
      hand,
    );
    for (const other of Object.keys(state.players).filter(
      (id) => id !== donor,
    )) {
      const view = createPlayerView(state, other);
      expect(view.encounter.npcOperation).toMatchObject({
        actionId: "xyy.npc-action.nj06",
        stage: "card",
        ownerPlayerId: donor,
        deadlineAt: state.pendingChoice!.deadlineAt,
      });
      expect(view.pendingChoice).toBeNull();
      expect(view.availableActions).toEqual([]);
      for (const card of hand) expect(JSON.stringify(view)).not.toContain(card);
    }
    const restored = migrateMatchState(JSON.parse(JSON.stringify(state)));
    const result = acceptNpcCommand(restored, donor, [hand[1]]);
    expect(result.state.players[donor]!.hand).toEqual([hand[0]]);
    expect(result.state.players[recipient]!.hand).toEqual([hand[1]]);
    expect(result.events.reduce(reduceEvent, restored)).toEqual(result.state);
    expect([
      ...result.state.drawPile,
      ...result.state.discardPile,
      ...Object.values(result.state.players).flatMap((p) => p.hand),
    ]).toHaveLength(56);
  });
  it("mandatory target timeout is replayable, disconnection preserves 15s, and foreign/stale/late commands fail without effects", () => {
    const input = npcFixture("xyy.npc-action.nj02");
    let state = start(input).state;
    const actor = state.activePlayerId!,
      foreign = Object.keys(state.players).find((id) => id !== actor)!;
    const originalChoice = state.pendingChoice!;
    const denied = applyCommand(
      state,
      npcCommand(state, foreign, {
        type: "submit-choice",
        choiceId: originalChoice.choiceId,
        selections: [actor],
      }),
    );
    expect(denied.accepted).toBe(false);
    expect(
      applyCommand(
        state,
        npcCommand(state, actor, {
          type: "submit-choice",
          choiceId: "old",
          selections: [actor],
        }),
      ).accepted,
    ).toBe(false);
    expect(
      applyCommand(
        state,
        npcCommand(
          state,
          actor,
          {
            type: "submit-choice",
            choiceId: originalChoice.choiceId,
            selections: [actor],
          },
          16_002,
        ),
      ).accepted,
    ).toBe(false);
    const disconnect = applyCommand(state, {
      origin: "system-presence",
      commandId: "disconnect",
      matchId: state.matchId,
      expectedVersion: state.version,
      playerId: actor,
      status: "disconnected",
      occurredAt: 2_000,
    });
    if (!disconnect.accepted) throw new Error(disconnect.reason);
    state = disconnect.state;
    expect(state.pendingChoice!.deadlineAt).toBe(16_001);
    const deadline = collectSystemDeadlines(state).find((d) =>
      d.targetId.startsWith("choice:"),
    )!;
    const command = {
      origin: "system-timeout" as const,
      commandId: deadline.id,
      matchId: state.matchId,
      expectedVersion: state.version,
      deadlineAt: deadline.deadlineAt,
      targetId: deadline.targetId,
    };
    const result = applyCommand(state, command);
    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error(result.reason);
    expect(
      applyCommand(
        migrateMatchState(JSON.parse(JSON.stringify(state))),
        command,
      ),
    ).toEqual(result);
    expect(result.state.rng.cursor).toBeGreaterThan(state.rng.cursor);
    expect(result.state.pendingChoice).toBeNull();
    expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
  });
  it("NJ03 self-harm waits for real rescue before its selected player draws; no early NPC discard or double draw", () => {
    let input = npcFixture("xyy.npc-action.nj03");
    const actor = input.activePlayerId!,
      target = input.turnOrder.find((id) => id !== actor)!;
    input = {
      ...input,
      players: {
        ...input.players,
        [actor]: { ...input.players[actor]!, hp: 1 },
      },
    };
    input = setHand(input, actor, ["xyy.card.tp02@36"]);
    const begun = start(input).state;
    let state = acceptNpcCommand(begun, actor, [target]).state;
    expect(state.reactionWindow).not.toBeNull();
    expect(state.players[actor]!.hp).toBe(1);
    const response = applyCommand(
      state,
      npcCommand(state, actor, {
        type: "pass-reaction",
        windowId: state.reactionWindow!.windowId,
      }),
    );
    if (!response.accepted) throw new Error(response.reason);
    expect(response.events.reduce(reduceEvent, state)).toEqual(response.state);
    state = response.state;
    expect(state.players[actor]!.hp).toBe(0);
    expect(state.dyingBatch).not.toBeNull();
    expect(state.players[target]!.hand).toEqual([]);
    expect(state.encounterState.resolution!.heldCardId).not.toBeNull();
    expect(state.encounterDiscard).toEqual([]);
    let guard = 0;
    while (state.dyingBatch !== null) {
      if (++guard > 10) throw new Error("NPC rescue did not terminate");
      const priority =
        state.dyingBatch.priorityOrder[state.dyingBatch.priorityIndex]!;
      const cmd = npcCommand(
        state,
        priority,
        priority === actor
          ? {
              type: "play-rescue-card",
              choiceId: state.pendingChoice!.choiceId,
              cardInstanceId: "xyy.card.tp02@36",
              targetPlayerId: actor,
            }
          : { type: "pass-rescue", choiceId: state.pendingChoice!.choiceId },
      );
      const before = migrateMatchState(JSON.parse(JSON.stringify(state)));
      const result = applyCommand(before, cmd);
      if (!result.accepted) throw new Error(result.reason);
      expect(result.events.reduce(reduceEvent, before)).toEqual(result.state);
      state = result.state;
    }
    expect(state.players[actor]!.hp).toBeGreaterThan(0);
    expect(state.players[target]!.hand).toHaveLength(1);
    expect(state.encounterState.npc).toBeNull();
    expect(state.encounterState.resolution!.stage).toBe("completed");
  });
});
