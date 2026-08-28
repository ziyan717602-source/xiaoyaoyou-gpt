import { describe, expect, it } from "vitest";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type MatchState,
} from "./index.js";
import { beginMonsterDebut } from "./monster-debut.js";
import { ENCOUNTER_DEFINITIONS } from "./encounter-definitions.js";
import { monsterFixture, fundMonsterHands } from "./testing/monster-fixture.js";
import { npcCommand, grantPets } from "./testing/npc-fixture.js";

const restore = (state: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(state)));
function start(state: MatchState) {
  const result = beginMonsterDebut(
    state,
    "start-monster-debut",
    state.encounterState.resolution!.updatedAt + 1,
  );
  expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
  expect(restore(result.state)).toEqual(result.state);
  return result.state;
}
function finishChildren(input: MatchState, timeouts = false) {
  let state = input;
  for (
    let step = 0;
    state.reactionWindow !== null || state.pendingChoice !== null;
    step++
  ) {
    if (step > 80) throw new Error("Monster debut child did not terminate");
    const window = state.reactionWindow;
    const actor =
      window === null
        ? state.pendingChoice!.playerIds[0]!
        : window.priorityOrder[window.priorityIndex]!;
    const command =
      window !== null
        ? { type: "pass-reaction" as const, windowId: window.windowId }
        : {
            type: "pass-rescue" as const,
            choiceId: state.pendingChoice!.choiceId,
          };
    const deadline = collectSystemDeadlines(state).find(
      (d) => d.origin === "system-timeout",
    )!;
    const result = applyCommand(
      state,
      timeouts
        ? {
            origin: "system-timeout",
            commandId: deadline.id,
            matchId: state.matchId,
            expectedVersion: state.version,
            targetId: deadline.targetId,
            deadlineAt: deadline.deadlineAt,
          }
        : npcCommand(
            state,
            actor,
            command,
            (window?.openedAt ?? state.pendingChoice!.openedAt) + 1,
          ),
    );
    if (!result.accepted) throw new Error(result.reason);
    expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
    state = restore(result.state);
  }
  return state;
}
describe("CS03 monster debut actual effects", () => {
  it("GS01 swaps whole hands with real living hinder without RNG or leaking to four bystanders", () => {
    const initial = fundMonsterHands(
      monsterFixture("xyy.monster.gs01"),
      [2, 1, 3, 1, 2, 1],
    );
    const actor = initial.activePlayerId!,
      hinder = initial.encounterState.resolution!.hinder!;
    if (hinder.kind !== "player") throw new Error("Expected real hinder");
    const state = start(initial);
    expect(state.players[actor]!.hand).toEqual(
      initial.players[hinder.playerId]!.hand,
    );
    expect(state.players[hinder.playerId]!.hand).toEqual(
      initial.players[actor]!.hand,
    );
    expect(state.rng).toEqual(initial.rng);
    expect(state.drawPile).toEqual(initial.drawPile);
    expect(state.encounterState.battle?.stage).toBe("combat-ready");
    for (const id of state.turnOrder) {
      const view = createPlayerView(state, id);
      for (const p of Object.values(state.players).filter((p) => p.id !== id))
        for (const card of p.hand)
          expect(JSON.stringify(view)).not.toContain(card);
      expect(view.availableActions).toEqual([]);
    }
    expect(() => start(state)).toThrow();
  });

  it.each([null, "dead", "pet"] as const)(
    "GS01 does not exchange with %s hinder",
    (kind) => {
      let initial = fundMonsterHands(
        monsterFixture("xyy.monster.gs01", { hinder: null }),
        [2, 1, 0, 0, 0, 0],
      );
      const enemy = initial.turnOrder.find(
        (id) => id !== initial.activePlayerId,
      )!;
      if (kind === "dead")
        initial = {
          ...initial,
          players: {
            ...initial.players,
            [enemy]: { ...initial.players[enemy]!, alive: false, hp: 0 },
          },
        };
      if (kind === "pet")
        initial = grantPets(initial, enemy, ["xyy.monster.gt03"]);
      initial = {
        ...initial,
        encounterState: {
          ...initial.encounterState,
          resolution: {
            ...initial.encounterState.resolution!,
            hinder:
              kind === null
                ? null
                : kind === "dead"
                  ? { kind: "player", playerId: enemy }
                  : {
                      kind: "pet",
                      ownerPlayerId: enemy,
                      cardId: "xyy.monster.gt03",
                    },
          },
        },
      };
      expect(start(initial).players).toEqual(initial.players);
    },
  );

  it("GH03 creates real fire damage to the living supporter using current actor strength", () => {
    let input = fundMonsterHands(
      monsterFixture("xyy.monster.gh03"),
      [1, 1, 1, 1, 1, 1],
    );
    const actor = input.activePlayerId!,
      supporter = input.turnOrder.find((id) => id !== actor)!;
    input = {
      ...input,
      players: {
        ...input.players,
        [actor]: { ...input.players[actor]!, strength: 4 },
      },
      encounterState: {
        ...input.encounterState,
        resolution: {
          ...input.encounterState.resolution!,
          supporter: { kind: "player", playerId: supporter },
        },
      },
    };
    const waiting = start(input);
    expect(waiting.encounterState.battle?.stage).toBe("debut-damage");
    expect(waiting.effectStack.at(-1)!.payload.damageItems).toEqual([
      expect.objectContaining({
        sourcePlayerId: null,
        sourceMonsterId: "xyy.monster.gh03",
        targetPlayerId: supporter,
        amount: 3,
        element: "fire",
        hpEvoMask: ["from-nmb"],
      }),
    ]);
    const result = finishChildren(waiting);
    expect(result.players[supporter]!.hp).toBe(
      input.players[supporter]!.hp - 3,
    );
    expect(result.encounterState.battle?.stage).toBe("combat-ready");
    expect(result.encounterState.resolution!.heldCardId).toBe(
      "xyy.monster.gh03",
    );
  });

  it("GH04 damages all six in one batch, completes simultaneous dying, discards held monster once on game end", () => {
    let input = monsterFixture("xyy.monster.gh04");
    input = {
      ...input,
      players: Object.fromEntries(
        Object.values(input.players).map((p) => [p.id, { ...p, hp: 1 }]),
      ),
    };
    const waiting = start(input);
    expect(waiting.encounterState.battle?.stage).toBe("debut-damage");
    const result = finishChildren(waiting, true);
    expect(result.phase).toBe("finished");
    expect(Object.values(result.players).every((p) => !p.alive)).toBe(true);
    expect(result.encounterState.battle?.stage).toBe("aborted");
    expect(result.encounterState.resolution).toMatchObject({
      heldCardId: null,
      rewardDrawCount: 0,
    });
    expect(
      result.encounterDiscard.filter((id) => id === "xyy.monster.gh04"),
    ).toHaveLength(1);
  });

  it("GL02 uses battle-local +2 strength, GT03 adds three to monster strength, neither rewrites player base stats", () => {
    for (const id of ["xyy.monster.gl02", "xyy.monster.gt03"] as const) {
      const input = monsterFixture(id),
        state = start(input),
        actor = input.activePlayerId!;
      expect(state.players).toEqual(input.players);
      expect(state.encounterState.battle).toMatchObject({
        stage: "combat-ready",
        strength: id === "xyy.monster.gt03" ? 7 : 8,
        playerStrengthBonuses: id === "xyy.monster.gl02" ? { [actor]: 2 } : {},
      });
    }
  });

  it("GT02 hits non-attending real players by own hand count; a participating pet does not exempt its owner", () => {
    let input = fundMonsterHands(
      monsterFixture("xyy.monster.gt02"),
      [1, 2, 3, 0, 1, 2],
    );
    const actor = input.activePlayerId!,
      owner = input.turnOrder.find((id) => id !== actor)!;
    input = grantPets(input, owner, ["xyy.monster.gt03"]);
    input = {
      ...input,
      encounterState: {
        ...input.encounterState,
        resolution: {
          ...input.encounterState.resolution!,
          hinder: {
            kind: "pet",
            ownerPlayerId: owner,
            cardId: "xyy.monster.gt03",
          },
        },
      },
    };
    const waiting = start(input);
    const items = waiting.effectStack.at(-1)!.payload.damageItems as Array<{
      targetPlayerId: string;
      amount: number;
      element: string;
    }>;
    expect(items.map((i) => i.targetPlayerId).sort()).toEqual(
      Object.values(input.players)
        .filter((p) => p.id !== actor && p.hand.length > 0)
        .map((p) => p.id)
        .sort(),
    );
    for (const item of items)
      expect(item).toMatchObject({
        amount: input.players[item.targetPlayerId]!.hand.length,
        element: "earth",
      });
    expect(finishChildren(waiting).encounterState.battle?.stage).toBe(
      "combat-ready",
    );
  });

  it("explicitly leaves the fourteen no-debut monsters ready for combat without inventing victory or consuming cards", () => {
    const hasDebut = new Set(
      ["gs01", "gh03", "gh04", "gl02", "gt02", "gt03"].map(
        (s) => `xyy.monster.${s}`,
      ),
    );
    const monsters = ENCOUNTER_DEFINITIONS.filter(
      (d) => d.kind === "monster" && !hasDebut.has(d.id),
    );
    expect(monsters).toHaveLength(14);
    for (const monster of monsters) {
      const input = monsterFixture(monster.id as `xyy.monster.${string}`),
        state = start(input);
      expect(state.players).toEqual(input.players);
      expect(state.drawPile).toEqual(input.drawPile);
      expect(state.rng).toEqual(input.rng);
      expect(state.encounterState.resolution!.heldCardId).toBe(monster.id);
      expect(state.encounterState.resolution!.result).toBeNull();
      expect(state.encounterState.battle?.stage).toBe("combat-ready");
    }
  });
});
