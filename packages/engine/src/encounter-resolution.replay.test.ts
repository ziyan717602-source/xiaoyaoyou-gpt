import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createEncounterDecks,
  SETUP_MONSTER_IDS,
  SETUP_NPC_IDS,
  type EncounterCardId,
} from "./encounter-content.js";
import { encounterDefinition } from "./encounter-definitions.js";
import type { EncounterDecisionState } from "./encounter.js";
import {
  assertEncounterOwnership,
  beginEncounterResolution,
  chooseNpcAction,
  defaultCapturedPet,
  defaultNpcAction,
  finishMonsterBattle,
  finishNpcAction,
  openNpcDecision,
  projectEncounterResolution,
  type EncounterResolutionResult,
} from "./encounter-resolution.js";
import type { RngState } from "./index.js";

const choice: EncounterDecisionState = {
  kind: "encounter-decision",
  activePlayerId: "p1",
  stage: "ready-reveal",
  outcome: "fight",
  decisionOwnerPlayerId: null,
  supporter: { kind: "player", playerId: "p3" },
  hinder: { kind: "player", playerId: "p2" },
  supportOptions: [],
  hinderOptions: [],
  configuredExtraHinderOptions: [],
  revealedCardId: null,
  openedAt: 1_000,
  deadlineAt: 1_000,
};
function roundtrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function entities(
  state: EncounterResolutionResult,
  reserve: readonly EncounterCardId[] = [],
) {
  return [
    ...state.zones.encounterDeck,
    ...state.zones.encounterDiscard,
    ...Object.values(state.zones.pets).flat(),
    ...Object.values(state.zones.companions).flat(),
    ...(state.flow.heldCardId === null ? [] : [state.flow.heldCardId]),
    ...reserve,
  ].sort();
}

describe("CS03-03 serialized routing (not concrete effect execution)", () => {
  it("routes every scoped card after JSON restoration without losing or duplicating its physical identity", () => {
    for (const card of [...SETUP_MONSTER_IDS, ...SETUP_NPC_IDS]) {
      const start = beginEncounterResolution(`card:${card}`, choice, {
        encounterDeck: [card],
        encounterDiscard: [],
        pets: {},
        companions: {},
      });
      expect(entities(start)).toEqual([card]);
      const definition = encounterDefinition(card);
      if (definition.kind === "monster") {
        for (const outcome of ["win", "lose"] as const) {
          const result = {
            outcome,
            capture: outcome === "win",
            ownerPlayerId: "p1",
          };
          const actual = finishMonsterBattle(start.flow, start.zones, result);
          const restored = roundtrip(start);
          expect(
            finishMonsterBattle(restored.flow, restored.zones, result),
          ).toEqual(actual);
          expect(entities(actual)).toEqual([card]);
        }
      } else {
        for (const actionId of definition.actionIds) {
          const opened = openNpcDecision(
            start.flow,
            start.zones,
            definition.actionIds,
            2_000,
          );
          const selected = chooseNpcAction(
            opened.flow,
            opened.zones,
            "p1",
            opened.flow.npcDecision!.choiceId,
            actionId,
            2_001,
          );
          expect(selected.flow.stage).toBe("npc-effect");
          // This exercises only the completion hook; no NPC effect is simulated as a no-op.
          const actual = finishNpcAction(
            selected.flow,
            selected.zones,
            selected.flow.pendingEffect!.effectId,
          );
          const restored = roundtrip(selected);
          expect(
            finishNpcAction(
              restored.flow,
              restored.zones,
              restored.flow.pendingEffect!.effectId,
            ),
          ).toEqual(actual);
          expect(entities(actual)).toEqual([card]);
        }
      }
    }
  });

  it("bounds NPC skip chains by deck size and preserves all 46 identities across seeded mixed decks and capture conflicts", () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const decks = createEncounterDecks(`route:${seed}`);
        let zones = {
          encounterDeck: decks.encounterDeck,
          encounterDiscard: decks.encounterDiscard,
          pets: {},
          companions: {},
        } as EncounterResolutionResult["zones"];
        let rng: RngState = {
          algorithm: "sha256-counter-v1",
          seed: `choices:${seed}`,
          cursor: 0,
        };
        const universe = [...SETUP_MONSTER_IDS, ...SETUP_NPC_IDS].sort();
        let turn = 0;
        let transitions = 0;
        while (zones.encounterDeck.length > 0) {
          const initialLength = zones.encounterDeck.length;
          let current = beginEncounterResolution(
            `turn:${turn++}`,
            choice,
            zones,
          );
          const run = (
            transition: (
              input: EncounterResolutionResult,
            ) => EncounterResolutionResult,
          ) => {
            const before = JSON.stringify(current);
            const normal = transition(current);
            const restarted = transition(roundtrip(current));
            expect(restarted).toEqual(normal);
            expect(JSON.stringify(current)).toBe(before);
            current = normal;
            assertEncounterOwnership(current.flow, current.zones);
            expect(entities(current, decks.reserveNpcDeck)).toEqual(universe);
            for (const viewer of ["p1", "p2", "p3", "p4", "p5", "p6"]) {
              expect(
                projectEncounterResolution(roundtrip(current.flow), viewer),
              ).toEqual(projectEncounterResolution(current.flow, viewer));
            }
            if (++transitions > 200)
              throw new Error("Encounter chain failed to terminate.");
          };
          while (
            current.flow.stage !== "completed" &&
            current.flow.stage !== "deck-exhausted"
          ) {
            if (current.flow.stage === "monster-effects") {
              run((s) =>
                finishMonsterBattle(s.flow, s.zones, {
                  outcome: "win",
                  capture: true,
                  ownerPlayerId: "p1",
                }),
              );
            } else if (current.flow.stage === "npc-options") {
              const definition = encounterDefinition(current.flow.heldCardId!);
              if (definition.kind !== "npc")
                throw new Error("Wrong reveal branch.");
              // Includes no-options chains as well as legal final forced choices.
              const options = seed % 2 === 0 ? [] : definition.actionIds;
              run((s) =>
                openNpcDecision(s.flow, s.zones, options, s.flow.updatedAt),
              );
            } else if (current.flow.stage === "npc-choice") {
              const randomBefore = rng;
              const at = current.flow.npcDecision!.deadlineAt;
              const resolved = defaultNpcAction(
                current.flow,
                current.zones,
                rng,
                at,
              );
              run((s) => defaultNpcAction(s.flow, s.zones, randomBefore, at));
              rng = resolved.rng;
            } else if (current.flow.stage === "npc-effect") {
              run((s) =>
                finishNpcAction(
                  s.flow,
                  s.zones,
                  s.flow.pendingEffect!.effectId,
                ),
              );
            } else if (current.flow.stage === "pet-choice") {
              const randomBefore = rng;
              const at = current.flow.petDecision!.deadlineAt;
              const resolved = defaultCapturedPet(
                current.flow,
                current.zones,
                rng,
                at,
              );
              run((s) => defaultCapturedPet(s.flow, s.zones, randomBefore, at));
              rng = resolved.rng;
            }
          }
          expect(current.zones.encounterDeck.length).toBeLessThan(
            initialLength,
          );
          zones = current.zones;
        }
        expect(turn).toBeLessThanOrEqual(30);
      }),
      { numRuns: 60, seed: 20260828 },
    );
  });

  it("does not expose future deck order or another player's legal NPC subset", () => {
    const a = beginEncounterResolution("privacy", choice, {
      encounterDeck: ["xyy.npc.nc207", "xyy.monster.gs01", "xyy.monster.gs02"],
      encounterDiscard: [],
      pets: {},
      companions: {},
    });
    const b = beginEncounterResolution("privacy", choice, {
      encounterDeck: ["xyy.npc.nc207", "xyy.monster.gs02", "xyy.monster.gs01"],
      encounterDiscard: [],
      pets: {},
      companions: {},
    });
    const openedA = openNpcDecision(
      a.flow,
      a.zones,
      ["xyy.npc-action.nj04"],
      2_000,
    );
    const openedB = openNpcDecision(
      b.flow,
      b.zones,
      ["xyy.npc-action.nj04", "xyy.npc-action.nj05"],
      2_000,
    );
    for (const viewer of ["p2", "p3", "p4", "p5", "p6"]) {
      expect(projectEncounterResolution(openedA.flow, viewer)).toEqual(
        projectEncounterResolution(openedB.flow, viewer),
      );
    }
  });
});
