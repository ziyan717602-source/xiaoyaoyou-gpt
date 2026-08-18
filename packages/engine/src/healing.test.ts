import { describe, expect, it } from "vitest";
import { createSetupMatch, type MatchState } from "./index.js";
import { planCureBatch, playersAfterCures } from "./healing.js";

function fixture(): { readonly state: MatchState; readonly target: string } {
  const state = createSetupMatch({
    matchId: "cs01d-wq02-healing",
    rulesetVersion: "standard-fengmingyushi@1",
    seed: "cs01d-wq02-healing-seed",
    players: Array.from({ length: 6 }, (_, index) => ({
      id: `healing-player-${index + 1}`,
      nickname: `Healing Player ${index + 1}`,
    })),
  });
  const target = state.turnOrder[0]!;
  return {
    target,
    state: {
      ...state,
      players: Object.fromEntries(
        Object.values(state.players).map((player) => [
          player.id,
          {
            ...player,
            alive: true,
            hp: 1,
            maxHp: 6,
            equipment:
              player.id === target
                ? { weapon: "xyy.card.wq02@48", armor: null }
                : { weapon: null, armor: null },
          },
        ]),
      ),
    },
  };
}

describe("CS01D deterministic cure planning", () => {
  it("applies WQ02 once to each positive non-TERMIN_AT owner cure item", () => {
    const { state, target } = fixture();
    const planned = planCureBatch(state, [
      {
        itemId: "ordinary",
        sourcePlayerId: target,
        targetPlayerId: target,
        amount: 2,
        element: "neutral",
      },
      {
        itemId: "from-jp",
        sourcePlayerId: target,
        targetPlayerId: target,
        amount: 1,
        element: "water",
        hpEvoMask: ["from-jp"],
      },
    ]);
    expect(planned).toEqual([
      {
        itemId: "ordinary",
        sourcePlayerId: target,
        targetPlayerId: target,
        baseAmount: 2,
        amount: 3,
        element: "neutral",
        hpEvoMask: [],
        hpBefore: 1,
        hpAfter: 4,
        appliedModifierCardInstanceIds: ["xyy.card.wq02@48"],
      },
      {
        itemId: "from-jp",
        sourcePlayerId: target,
        targetPlayerId: target,
        baseAmount: 1,
        amount: 2,
        element: "water",
        hpEvoMask: ["from-jp"],
        hpBefore: 4,
        hpAfter: 6,
        appliedModifierCardInstanceIds: ["xyy.card.wq02@48"],
      },
    ]);
    expect(playersAfterCures(state, planned)[target]!.hp).toBe(6);
  });

  it("does not modify TERMIN_AT, zero, unequipped, or another player's cure", () => {
    const { state, target } = fixture();
    const other = state.turnOrder[1]!;
    const termin = planCureBatch(state, [
      {
        itemId: "termin",
        sourcePlayerId: target,
        targetPlayerId: target,
        amount: 2,
        element: "neutral",
        hpEvoMask: ["termin-at"],
      },
      {
        itemId: "zero",
        sourcePlayerId: target,
        targetPlayerId: target,
        amount: 0,
        element: "neutral",
      },
      {
        itemId: "other",
        sourcePlayerId: target,
        targetPlayerId: other,
        amount: 1,
        element: "water",
      },
    ]);
    expect(termin.map((item) => item.amount)).toEqual([2, 0, 1]);
    expect(
      termin.every((item) => item.appliedModifierCardInstanceIds.length === 0),
    ).toBe(true);

    const unequipped: MatchState = {
      ...state,
      players: {
        ...state.players,
        [target]: {
          ...state.players[target]!,
          equipment: { weapon: null, armor: null },
        },
      },
    };
    expect(
      planCureBatch(unequipped, [
        {
          itemId: "unequipped",
          sourcePlayerId: other,
          targetPlayerId: target,
          amount: 2,
          element: "neutral",
        },
      ])[0],
    ).toMatchObject({ amount: 2, appliedModifierCardInstanceIds: [] });
  });
});
