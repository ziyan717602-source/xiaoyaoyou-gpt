import { describe, expect, it } from "vitest";
import {
  applyCommand,
  cardDefinition,
  heroDefinition,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type MatchState,
} from "./index.js";
import { beginNpcAction } from "./npc-effects.js";
import {
  discardOwnedPets,
  withPetOwnership,
  weaponEffectsEnabled,
} from "./pet-effects.js";
import { planCureBatch } from "./healing.js";
import { planDamageBatch } from "./damage-dying.js";
import {
  acceptNpcCommand,
  npcCommand,
  npcFixture,
  grantPets,
} from "./testing/npc-fixture.js";
import type { MonsterId } from "./encounter-content.js";

// Independent oracle from FG04 Incr/Decr handlers; zero means no gain/loss
// stat delta, NOT that the monster's debut/consume/win/loss effects are absent.
const PASSIVES = [
  ["gs01", 1, 0],
  ["gs02", 0, 0],
  ["gs03", 0, 0],
  ["gs04", 1, 1],
  ["gh01", 1, 0],
  ["gh02", 0, 0],
  ["gh03", 2, 0],
  ["gh04", 2, 0],
  ["gl01", 0, 0],
  ["gl02", 0, 0],
  ["gl03", 0, 2],
  ["gl04", 0, 0],
  ["gf01", 0, 0],
  ["gf02", 1, 0],
  ["gf03", 0, 0],
  ["gf04", 0, 0],
  ["gt01", 0, 0],
  ["gt02", 0, 1],
  ["gt03", 0, 0],
  ["gt04", 2, 1],
] as const;

function roundTrip(state: MatchState) {
  return migrateMatchState(JSON.parse(JSON.stringify(state)));
}
function choose(state: MatchState, owner: string, option: string) {
  const result = acceptNpcCommand(roundTrip(state), owner, [option]);
  expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
  return result.state;
}
describe("CS03 NJ07 and actual pet lifecycle", () => {
  it("equipping while GL04 is active keeps physical weapon hero skills and armor, but suppresses the new weapon effect", () => {
    let state = npcFixture("xyy.npc-action.nj04");
    state = beginNpcAction(state, "start", 1001).state;
    const actor = state.activePlayerId!,
      foe = state.turnOrder.find(
        (id) => state.players[id]!.team !== state.players[actor]!.team,
      )!;
    const hero = heroDefinition("xyy.hero.xj104");
    const wq = state.drawPile.find(
      (id) => cardDefinition(id).id === "xyy.card.wq02",
    )!;
    const armor = state.drawPile.find(
      (id) => cardDefinition(id).id === "xyy.card.fj03",
    )!;
    state = {
      ...state,
      turn: {
        ...state.turn!,
        phase: "action",
        openedAt: 1001,
        deadlineAt: 16001,
      },
      drawPile: state.drawPile.filter((id) => id !== wq && id !== armor),
      players: {
        ...state.players,
        [actor]: {
          ...state.players[actor]!,
          heroId: hero.id,
          strength: hero.strength,
          dexterity: hero.dexterity,
          hp: 1,
          maxHp: hero.maxHp,
          hand: [wq, armor],
        },
      },
    };
    state = grantPets(state, foe, ["xyy.monster.gl04"]);
    for (const card of [wq, armor]) {
      const result = applyCommand(
        state,
        npcCommand(state, actor, {
          type: "play-card",
          cardInstanceId: card,
          targetPlayerIds: [actor],
        }),
      );
      if (!result.accepted) throw new Error(result.reason);
      expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
      state = roundTrip(result.state);
    }
    expect(state.players[actor]!.strength).toBe(hero.strength + 1);
    expect(
      planCureBatch(state, [
        {
          itemId: "cure",
          sourcePlayerId: null,
          targetPlayerId: actor,
          amount: 1,
          element: "neutral",
        },
      ])[0]!.amount,
    ).toBe(1);
    expect(
      planDamageBatch(state, [
        {
          itemId: "harm",
          sourcePlayerId: null,
          targetPlayerId: actor,
          amount: 2,
          element: "neutral",
        },
      ])[0]!.amount,
    ).toBe(1);
    const restored = discardOwnedPets(state, [foe]);
    expect(restored.players[actor]).toEqual(state.players[actor]);
    expect(
      planCureBatch(restored, [
        {
          itemId: "cure",
          sourcePlayerId: null,
          targetPlayerId: actor,
          amount: 1,
          element: "neutral",
        },
      ])[0]!.amount,
    ).toBe(2);
  });
  it("discards pets in C# water/fire/thunder/wind/earth slot order, not code order", () => {
    const base = npcFixture("xyy.npc-action.nj07"),
      owner = base.activePlayerId!;
    const state = grantPets(base, owner, [
      "xyy.monster.gt04",
      "xyy.monster.gf02",
      "xyy.monster.gl04",
      "xyy.monster.gh03",
      "xyy.monster.gs04",
    ]);
    expect(discardOwnedPets(state, [owner]).encounterDiscard).toEqual([
      "xyy.monster.gs04",
      "xyy.monster.gh03",
      "xyy.monster.gl04",
      "xyy.monster.gf02",
      "xyy.monster.gt04",
    ]);
  });
  it.each(PASSIVES)(
    "%s acquisition/loss applies exactly STR %i DEX %i once",
    (code, str, dex) => {
      const input = npcFixture("xyy.npc-action.nj07"),
        owner = input.activePlayerId!;
      const pet: MonsterId = `xyy.monster.${code}`;
      const gained = grantPets(input, owner, [pet]);
      expect(gained.players[owner]!.strength).toBe(
        input.players[owner]!.strength + str,
      );
      expect(gained.players[owner]!.dexterity).toBe(
        input.players[owner]!.dexterity + dex,
      );
      expect(
        withPetOwnership(roundTrip(gained), gained.encounterState.pets),
      ).toEqual(gained);
      const lost = discardOwnedPets(gained, [owner]);
      expect(lost.players).toEqual(input.players);
      expect(lost.encounterState.pets[owner]).toBeUndefined();
      expect(lost.encounterDiscard).toContain(pet);
      expect(discardOwnedPets(roundTrip(lost), [owner])).toEqual(lost);
    },
  );
  it.each([false, true])(
    "current actor chooses all three stages; same-element KOKAN swap=%s",
    (swap) => {
      const base = npcFixture("xyy.npc-action.nj07"),
        actor = base.activePlayerId!;
      const donor = base.turnOrder.find(
        (id) => base.players[id]!.team !== base.players[actor]!.team,
      )!;
      const recipient = base.turnOrder.find(
        (id) =>
          id !== donor && base.players[id]!.team === base.players[donor]!.team,
      )!;
      let input = grantPets(base, donor, ["xyy.monster.gs04"]);
      input = grantPets(input, recipient, [
        swap ? "xyy.monster.gs01" : "xyy.monster.gt02",
      ]);
      let state = beginNpcAction(input, "nj07-start", 1001).state;
      for (const selection of [donor, recipient, "xyy.monster.gs04"]) {
        expect(state.pendingChoice!.playerIds).toEqual([actor]);
        for (const id of state.turnOrder) {
          const view = createPlayerView(state, id);
          if (id !== actor) {
            expect(view.pendingChoice).toBeNull();
            expect(view.availableActions).toEqual([]);
          }
        }
        const denied = applyCommand(
          state,
          npcCommand(state, donor, {
            type: "submit-choice",
            choiceId: state.pendingChoice!.choiceId,
            selections: [selection],
          }),
        );
        expect(denied.accepted).toBe(false);
        state = choose(state, actor, selection);
      }
      expect(state.pendingChoice).toBeNull();
      expect(state.encounterState.npc).toBeNull();
      expect(state.encounterState.resolution!.stage).toBe("completed");
      expect(state.encounterState.pets[donor] ?? []).toEqual(
        swap ? ["xyy.monster.gs01"] : [],
      );
      expect(state.encounterState.pets[recipient]).toContain(
        "xyy.monster.gs04",
      );
      expect(state.players[donor]!.dexterity).toBe(
        base.players[donor]!.dexterity,
      );
      expect(state.players[recipient]!.dexterity).toBe(
        base.players[recipient]!.dexterity + (swap ? 1 : 2),
      );
      expect(
        state.encounterDiscard.filter((id) => id.startsWith("xyy.monster.")),
      ).toEqual([]);
      const entities = [
        ...state.encounterDeck,
        ...state.encounterDiscard,
        ...state.reserveNpcDeck,
        ...state.reserveNpcDiscard,
        ...Object.values(state.encounterState.pets).flat(),
      ];
      expect(entities.length).toBe(46);
      expect(new Set(entities).size).toBe(46);
    },
  );
  it("GL04 disables equipped WQ02 and WQ04 but not hand pawn; removing it restores effects", () => {
    let state = npcFixture("xyy.npc-action.nj04");
    state = beginNpcAction(state, "finish-npc", 1001).state;
    const actor = state.activePlayerId!;
    const foe = state.turnOrder.find(
      (id) => state.players[id]!.team !== state.players[actor]!.team,
    )!;
    const wq02 = state.drawPile.find(
      (id) => cardDefinition(id).id === "xyy.card.wq02",
    )!;
    const wq04 = state.drawPile.find(
      (id) => cardDefinition(id).id === "xyy.card.wq04",
    )!;
    state = {
      ...state,
      turn: {
        ...state.turn!,
        phase: "action",
        openedAt: 1001,
        deadlineAt: 16001,
      },
      drawPile: state.drawPile.filter((id) => id !== wq02 && id !== wq04),
      players: {
        ...state.players,
        [actor]: {
          ...state.players[actor]!,
          hp: 1,
          hand: [wq04],
          equipment: { weapon: wq02, armor: null },
        },
      },
    };
    const cure = (s: MatchState) =>
      planCureBatch(s, [
        {
          itemId: "cure",
          sourcePlayerId: null,
          targetPlayerId: actor,
          amount: 1,
          element: "neutral",
        },
      ])[0]!;
    expect(cure(state).amount).toBe(2);
    const disabled = roundTrip(grantPets(state, foe, ["xyy.monster.gl04"]));
    expect(weaponEffectsEnabled(disabled, actor)).toBe(false);
    expect(weaponEffectsEnabled(disabled, foe)).toBe(true);
    expect(cure(disabled).amount).toBe(1);
    expect(disabled.players[actor]!.equipment.weapon).toBe(wq02);
    const pawn = {
      type: "play-card",
      cardInstanceId: wq04,
      targetPlayerIds: [],
      mode: "pawn",
    } as const;
    expect(
      applyCommand(disabled, npcCommand(disabled, actor, pawn)).accepted,
    ).toBe(true);
    const equipped = {
      ...disabled,
      discardPile: [...disabled.discardPile, wq02],
      players: {
        ...disabled.players,
        [actor]: {
          ...disabled.players[actor]!,
          hand: [],
          equipment: { weapon: wq04, armor: null },
        },
      },
    };
    expect(
      createPlayerView(equipped, actor).availableActions,
    ).not.toContainEqual(pawn);
    expect(
      applyCommand(equipped, npcCommand(equipped, actor, pawn)).accepted,
    ).toBe(false);
    const restored = roundTrip(discardOwnedPets(equipped, [foe]));
    expect(weaponEffectsEnabled(restored, actor)).toBe(true);
    const allowed = applyCommand(restored, npcCommand(restored, actor, pawn));
    expect(allowed.accepted).toBe(true);
    if (allowed.accepted) {
      expect(allowed.events.reduce(reduceEvent, restored)).toEqual(
        allowed.state,
      );
      expect(() => allowed.events.reduce(reduceEvent, equipped)).toThrow();
    }
    expect(cure(discardOwnedPets(disabled, [foe])).amount).toBe(2);
  });
});
