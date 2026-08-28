import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type EngineCommand,
  type MatchState,
} from "./index.js";
import { beginNpcAction, legalNpcActions } from "./npc-effects.js";
import { heroAvailability } from "./hero-roster.js";
import { ENCOUNTER_DEFINITIONS } from "./encounter-definitions.js";
import {
  npcFixture,
  npcCommand,
  acceptNpcCommand,
  grantPets,
} from "./testing/npc-fixture.js";
const restore = (state: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(state)));

function fixture(seed = "join-replay", count = 2) {
  let state = npcFixture("xyy.npc-action.nj01", seed, {
    npcId: "xyy.npc.nc106",
  });
  const actor = state.activePlayerId!;
  const teammate = state.turnOrder.find(
    (id) =>
      id !== actor && state.players[id]!.team === state.players[actor]!.team,
  )!;
  state = {
    ...state,
    drawPile: state.drawPile.slice(count + 1),
    players: {
      ...state.players,
      [actor]: {
        ...state.players[actor]!,
        hand: state.drawPile.slice(0, count),
      },
      [teammate]: {
        ...state.players[teammate]!,
        hand: [state.drawPile[count]!],
      },
    },
  };
  return grantPets(state, actor, ["xyy.monster.gs04"]);
}
function identities(state: MatchState) {
  const cards = [
    ...state.drawPile,
    ...state.discardPile,
    ...Object.values(state.players).flatMap((p) => [
      ...p.hand,
      ...Object.values(p.equipment).filter((c) => c !== null),
    ]),
  ];
  expect(cards).toHaveLength(56);
  expect(new Set(cards).size).toBe(56);
  const entities = [
    ...state.encounterDeck,
    ...state.encounterDiscard,
    ...state.reserveNpcDeck,
    ...state.reserveNpcDiscard,
    ...Object.values(state.encounterState.pets).flat(),
    ...Object.values(state.encounterState.companions).flat(),
    ...(state.encounterState.resolution?.heldCardId == null
      ? []
      : [state.encounterState.resolution.heldCardId]),
  ];
  expect(entities).toHaveLength(46);
  expect(new Set(entities).size).toBe(46);
  const heroes = Object.values(heroAvailability(state)).flat();
  expect(heroes).toHaveLength(34);
  expect(new Set(heroes).size).toBe(34);
}

describe("NJ01 replay, legality and private projections", () => {
  it("upgrades v10 without resetting choices, RNG, pet stats or connection clocks", () => {
    const current = beginNpcAction(fixture(), "start", 1001).state;
    // This window could not exist in v10; use an actual v10-compatible NJ07 window.
    let prior = npcFixture("xyy.npc-action.nj07");
    prior = grantPets(prior, prior.activePlayerId!, ["xyy.monster.gs04"]);
    prior = beginNpcAction(prior, "start", 1001).state;
    const raw = JSON.parse(JSON.stringify(prior));
    raw.schemaVersion = 10;
    delete raw.encounterState.heroDiscards;
    delete raw.encounterState.bannedHeroes;
    expect(migrateMatchState(raw)).toEqual(prior);
    expect(restore(current)).toEqual(current);
  });

  it("rejects corrupted payers, role availability, saved choices and forged join reports", () => {
    const input = fixture(),
      actor = input.activePlayerId!;
    const waiting = acceptNpcCommand(
      beginNpcAction(input, "start", 1001).state,
      actor,
      [actor],
    ).state;
    const enemy = input.turnOrder.find(
      (id) => input.players[id]!.team !== input.players[actor]!.team,
    )!;
    for (const mutate of [
      (s: any) => (s.encounterState.npc.targets = [enemy]),
      (s: any) => (s.encounterState.npc.stage = "card"),
      (s: any) => s.pendingChoice.optionIds.push(enemy),
      (s: any) => (s.pendingChoice.playerIds = [enemy]),
      (s: any) => (s.encounterState.bannedHeroes = ["xyy.hero.xj106"]),
      (s: any) =>
        (s.encounterState.heroDiscards = ["xyy.hero.xj106", "xyy.hero.xj106"]),
      (s: any) => (s.players[actor].hand = []),
    ]) {
      const corrupt = JSON.parse(JSON.stringify(waiting));
      mutate(corrupt);
      expect(() => migrateMatchState(corrupt)).toThrow();
    }
    const result = acceptNpcCommand(waiting, actor, [actor]);
    const event = result.events[0]!;
    expect(result.events.reduce(reduceEvent, waiting)).toEqual(result.state);
    expect(() =>
      reduceEvent(waiting, {
        ...event,
        payload: {
          ...event.payload,
          report: { ...(event.payload.report as object), heroJoin: { hp: 99 } },
        },
      }),
    ).toThrow();
    identities(result.state);
  });

  it("checks every NPC's declared actions with and without publicly visible payment resources", () => {
    const input = fixture(),
      actor = input.activePlayerId!;
    const empty = {
      ...input,
      players: Object.fromEntries(
        Object.values(input.players).map((p) => [
          p.id,
          { ...p, heroId: null, hand: [] },
        ]),
      ),
      encounterState: { ...input.encounterState, pets: {} },
    };
    const funded = {
      ...empty,
      players: {
        ...empty.players,
        [actor]: { ...empty.players[actor]!, hand: input.players[actor]!.hand },
      },
      encounterState: {
        ...empty.encounterState,
        pets: { [actor]: ["xyy.monster.gs04" as const] },
      },
    };
    const unconditional = new Set([
      "xyy.npc-action.nj02",
      "xyy.npc-action.nj03",
      "xyy.npc-action.nj04",
      "xyy.npc-action.nj05",
      "xyy.npc-action.nj09",
    ]);
    for (const npc of ENCOUNTER_DEFINITIONS.filter((d) => d.kind === "npc")) {
      expect(legalNpcActions(empty, actor, npc.id)).toEqual(
        npc.actionIds.filter((a) => unconditional.has(a)),
      );
      expect(legalNpcActions(funded, actor, npc.id)).toEqual(npc.actionIds);
    }
    const enemy = input.turnOrder.find(
      (id) => input.players[id]!.team !== input.players[actor]!.team,
    )!;
    const foreignPay = {
      ...empty,
      players: {
        ...empty.players,
        [enemy]: { ...empty.players[enemy]!, hand: input.players[actor]!.hand },
      },
    };
    expect(legalNpcActions(foreignPay, actor, "xyy.npc.nc106")).toEqual([
      "xyy.npc-action.nj04",
    ]);
    expect(legalNpcActions(foreignPay, actor, "xyy.npc.nc104")).toEqual([
      "xyy.npc-action.nj06",
    ]);
  });

  it("replays seeded manual/timeout/automatic joins across both waits with 56/46/34 entity conservation", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 1, max: 5 }),
        fc.boolean(),
        fc.tuple(fc.boolean(), fc.boolean()),
        (seed, count, auto, timeouts) => {
          let input = fixture(`join-${seed}`, count),
            actor = input.activePlayerId!;
          if (auto)
            input = {
              ...input,
              connections: {
                ...input.connections,
                [actor]: { ...input.connections[actor]!, status: "auto" },
              },
            };
          let state = beginNpcAction(input, "start", 1001).state;
          identities(state);
          for (let i = 0; state.pendingChoice !== null; i++) {
            if (i >= 2) throw new Error("NJ01 exceeded its two choices");
            const choice = state.pendingChoice;
            expect(choice.deadlineAt - choice.openedAt).toBe(15000);
            expect(choice.optional).toBe(false);
            for (const id of state.turnOrder) {
              const view = createPlayerView(state, id);
              expect(createPlayerView(restore(state), id)).toEqual(view);
              if (id !== actor) {
                expect(view.pendingChoice).toBeNull();
                expect(view.availableActions).toEqual([]);
              }
              for (const p of Object.values(state.players).filter(
                (p) => p.id !== id,
              ))
                for (const card of p.hand)
                  expect(JSON.stringify(view)).not.toContain(card);
            }
            const selections = [
              choice.optionIds[Math.abs(seed) % choice.optionIds.length]!,
            ];
            const data = {
              type: "submit-choice" as const,
              choiceId: choice.choiceId,
              selections,
            };
            const stranger = state.turnOrder.find((id) => id !== actor)!;
            expect(
              applyCommand(
                state,
                npcCommand(state, stranger, data, choice.openedAt + 1),
              ).accepted,
            ).toBe(false);
            expect(
              applyCommand(
                state,
                npcCommand(state, actor, data, choice.deadlineAt + 1),
              ).accepted,
            ).toBe(false);
            let command: EngineCommand = npcCommand(
              state,
              actor,
              data,
              choice.openedAt + 1,
            );
            if (timeouts[i] || auto) {
              const d = collectSystemDeadlines(state).find(
                (d) => d.origin === "system-timeout",
              )!;
              expect(d.deadlineAt).toBe(
                auto ? choice.openedAt : choice.deadlineAt,
              );
              command = {
                origin: "system-timeout",
                commandId: d.id,
                targetId: d.targetId,
                deadlineAt: d.deadlineAt,
                expectedVersion: state.version,
                matchId: state.matchId,
              };
              expect(
                applyCommand(state, {
                  ...command,
                  deadlineAt: d.deadlineAt - 1,
                }).accepted,
              ).toBe(false);
            }
            const result = applyCommand(state, command);
            expect(applyCommand(restore(state), command)).toEqual(result);
            if (!result.accepted) throw new Error(result.reason);
            expect(result.events.reduce(reduceEvent, state)).toEqual(
              result.state,
            );
            expect(applyCommand(result.state, command).accepted).toBe(false);
            state = result.state;
            identities(state);
          }
          expect(state.encounterState.resolution!.stage).toBe("completed");
          expect(
            Object.values(state.players).filter(
              (p) => p.alive && p.heroId === "xyy.hero.xj106",
            ),
          ).toHaveLength(1);
        },
      ),
      { numRuns: 80, seed: 20260828 },
    );
  });
});
