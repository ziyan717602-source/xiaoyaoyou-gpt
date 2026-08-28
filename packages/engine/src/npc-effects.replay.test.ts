import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { beginNpcAction } from "./npc-effects.js";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type EngineCommand,
  type MatchState,
} from "./index.js";
import {
  npcFixture,
  npcCommand,
  acceptNpcCommand,
  grantPets,
} from "./testing/npc-fixture.js";
import { inspectionFixture } from "./testing/inspection-fixture.js";

const restore = (state: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(state)));
function identities(state: MatchState) {
  const cards = [
    ...state.drawPile,
    ...state.discardPile,
    ...Object.values(state.players).flatMap((p) => [
      ...p.hand,
      ...Object.values(p.equipment).filter((c) => c !== null),
    ]),
  ];
  const encounters = [
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
  expect(cards).toHaveLength(56);
  expect(new Set(cards).size).toBe(56);
  expect(encounters).toHaveLength(46);
  expect(new Set(encounters).size).toBe(46);
}
describe("CS03 NPC persistence and event integrity", () => {
  it("rejects forged choice ownership, deadlines, resume steps, and lost continuation targets", () => {
    const base = npcFixture("xyy.npc-action.nj06");
    const donor = base.turnOrder.find((id) => id !== base.activePlayerId)!;
    const recipient = base.turnOrder.find(
      (id) =>
        id !== donor && base.players[id]!.team === base.players[donor]!.team,
    )!;
    const hand = [base.drawPile[0]!];
    const initial = {
      ...base,
      drawPile: base.drawPile.slice(1),
      players: { ...base.players, [donor]: { ...base.players[donor]!, hand } },
    };
    let state = beginNpcAction(initial, "start", 1_001).state;
    state = acceptNpcCommand(state, base.activePlayerId!, [donor]).state;
    state = acceptNpcCommand(state, base.activePlayerId!, [recipient]).state;
    for (const mutate of [
      (s: any) => {
        s.pendingChoice.playerIds = [s.activePlayerId];
      },
      (s: any) => {
        s.pendingChoice.deadlineAt += 1;
      },
      (s: any) => {
        s.pendingChoice.continuation.step = "target";
      },
      (s: any) => {
        s.encounterState.npc.targets = [donor];
      },
      (s: any) => {
        s.encounterState.npc.stage = "damage";
      },
      (s: any) => {
        s.encounterState.resolution.pendingEffect.npcId = s.encounterDeck[0];
      },
    ]) {
      const corrupt = JSON.parse(JSON.stringify(state));
      mutate(corrupt);
      expect(() => migrateMatchState(corrupt)).toThrow("schema v10");
    }
    expect(restore(state)).toEqual(state);
  });
  it("upgrades schema 8 without inventing an encounter or changing knowledge, deck order or RNG", () => {
    const initial = inspectionFixture("npc-schema-8");
    const legacy = JSON.parse(JSON.stringify(initial));
    legacy.schemaVersion = 8;
    delete legacy.encounterState;
    const restored = migrateMatchState(legacy);
    expect(restored.encounterState).toEqual({
      resolution: null,
      npc: null,
      pets: {},
      companions: {},
      weaponDisabledReasons: {},
    });
    expect(restored.encounterDeck).toEqual(initial.encounterDeck);
    expect(restored.encounterInspections).toEqual(initial.encounterInspections);
    expect(restored.rng).toEqual(initial.rng);
    expect(() =>
      migrateMatchState({ ...restored, encounterState: undefined }),
    ).toThrow("schema v10");
  });
  it("recomputes authoritative NPC event results and rejects changed reports, actors and timestamps", () => {
    const initial = npcFixture("xyy.npc-action.nj02");
    const before = beginNpcAction(initial, "start", 1_001).state;
    const accepted = acceptNpcCommand(before, before.activePlayerId!, [
      before.activePlayerId!,
    ]);
    const event = accepted.events[0]!;
    for (const payload of [
      {
        ...event.payload,
        report: { ...(event.payload.report as object), rngCursorEnd: -1 },
      },
      {
        ...event.payload,
        operation: {
          ...(event.payload.operation as object),
          actor: "intruder",
        },
      },
      { ...event.payload, resolvedAt: 16_002 },
      { ...event.payload, matchVersion: before.version },
    ])
      expect(() => reduceEvent(before, { ...event, payload })).toThrow();
    expect(() => reduceEvent(accepted.state, event)).toThrow();
  });
  it("executes seeded legal choices and timeouts identically after every JSON boundary, preserving 56/46 entities and six views", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.constantFrom(
          "xyy.npc-action.nj02",
          "xyy.npc-action.nj04",
          "xyy.npc-action.nj06",
          "xyy.npc-action.nj07",
          "xyy.npc-action.nj08",
          "xyy.npc-action.nj09",
        ),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        (seed, action, timeouts) => {
          let initial = npcFixture(action, `npc-${seed}`);
          const players = Object.fromEntries(
            Object.values(initial.players).map((p, i) => [
              p.id,
              { ...p, hp: 1, hand: initial.drawPile.slice(i * 2, i * 2 + 2) },
            ]),
          );
          initial = {
            ...initial,
            players,
            drawPile: initial.drawPile.slice(12),
          };
          if (action === "xyy.npc-action.nj07") {
            for (const [i, pet] of (
              [
                "xyy.monster.gs04",
                "xyy.monster.gs01",
                "xyy.monster.gt04",
                "xyy.monster.gl04",
              ] as const
            ).entries())
              initial = grantPets(initial, initial.turnOrder[i]!, [pet]);
          }
          const begun = beginNpcAction(initial, "start", 1_001);
          expect(beginNpcAction(restore(initial), "start", 1_001)).toEqual(
            begun,
          );
          expect(begun.events.reduce(reduceEvent, initial)).toEqual(
            begun.state,
          );
          let normal = begun.state,
            resumed = restore(normal);
          for (let step = 0; normal.pendingChoice !== null; step++) {
            if (step > 3) throw new Error("NPC choice chain did not terminate");
            const choice = normal.pendingChoice;
            let command: EngineCommand;
            if (timeouts[step]) {
              const d = collectSystemDeadlines(normal).find(
                (d) => d.origin === "system-timeout",
              )!;
              command = {
                origin: "system-timeout",
                commandId: d.id,
                targetId: d.targetId,
                deadlineAt: d.deadlineAt,
                matchId: normal.matchId,
                expectedVersion: normal.version,
              };
            } else
              command = npcCommand(
                normal,
                choice.playerIds[0]!,
                {
                  type: "submit-choice",
                  choiceId: choice.choiceId,
                  selections: [
                    choice.optionIds[Math.abs(seed) % choice.optionIds.length]!,
                  ],
                },
                choice.openedAt + 1,
              );
            const a = applyCommand(normal, command),
              b = applyCommand(resumed, command);
            expect(b).toEqual(a);
            if (!a.accepted) throw new Error(a.reason);
            expect(a.events.reduce(reduceEvent, normal)).toEqual(a.state);
            normal = a.state;
            resumed = restore(b.accepted ? b.state : normal);
            identities(normal);
            for (const owner of normal.turnOrder) {
              const view = createPlayerView(normal, owner);
              expect(createPlayerView(resumed, owner)).toEqual(view);
              for (const other of normal.turnOrder.filter(
                (id) => id !== owner,
              )) {
                for (const card of normal.players[other]!.hand)
                  expect(JSON.stringify(view)).not.toContain(card);
              }
            }
          }
          identities(normal);
          expect(normal.encounterState.resolution!.stage).toBe("completed");
        },
      ),
      { numRuns: 60, seed: 20260828 },
    );
  });
  it("already-auto NPC choice owners use the opening instant, with one deterministic decision", () => {
    const initial = npcFixture("xyy.npc-action.nj02");
    const actor = initial.activePlayerId!;
    const state = beginNpcAction(
      {
        ...initial,
        connections: {
          ...initial.connections,
          [actor]: { status: "auto", disconnectedAt: 0, autoAt: 60_000 },
        },
      },
      "start",
      60_001,
    ).state;
    const d = collectSystemDeadlines(state).find(
      (d) => d.origin === "system-timeout",
    )!;
    expect(d.deadlineAt).toBe(60_001);
    const command: EngineCommand = {
      origin: "system-timeout",
      commandId: d.id,
      matchId: state.matchId,
      expectedVersion: state.version,
      targetId: d.targetId,
      deadlineAt: d.deadlineAt,
    };
    const a = applyCommand(state, command);
    expect(a.accepted).toBe(true);
    expect(applyCommand(restore(state), command)).toEqual(a);
    if (!a.accepted) throw new Error(a.reason);
    expect(a.events.reduce(reduceEvent, state)).toEqual(a.state);
    expect(a.state.pendingChoice).toBeNull();
    expect(applyCommand(a.state, command).accepted).toBe(false);
  });
});
