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
import { beginNpcOptions } from "./npc-options.js";
import { npcOptionsFixture } from "./testing/npc-options-fixture.js";
import { npcCommand } from "./testing/npc-fixture.js";
import { heroAvailability } from "./hero-roster.js";

const restore = (s: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(s)));
const timeout = (s: MatchState): EngineCommand => {
  const d = collectSystemDeadlines(s).find(
    (d) => d.origin === "system-timeout",
  )!;
  return {
    origin: "system-timeout",
    commandId: d.id,
    matchId: s.matchId,
    expectedVersion: s.version,
    targetId: d.targetId,
    deadlineAt: d.deadlineAt,
  };
};
function identities(state: MatchState) {
  const cards = [
    ...state.drawPile,
    ...state.discardPile,
    ...Object.values(state.players).flatMap((p) => [
      ...p.hand,
      ...Object.values(p.equipment).filter((c) => c !== null),
    ]),
  ];
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
  expect(cards).toHaveLength(56);
  expect(new Set(cards).size).toBe(56);
  expect(entities).toHaveLength(46);
  expect(new Set(entities).size).toBe(46);
  const heroes = Object.values(heroAvailability(state)).flat();
  expect(heroes).toHaveLength(34);
  expect(new Set(heroes).size).toBe(34);
}
describe("NPC options replay and integrity", () => {
  it("rejects orphan, forged, extended, private-data-bearing and context-mismatched windows", () => {
    const state = beginNpcOptions(npcOptionsFixture(), "open", 1001).state;
    const actor = state.activePlayerId!,
      stranger = state.turnOrder.find((id) => id !== actor)!;
    for (const mutate of [
      (s: any) => (s.pendingChoice = null),
      (s: any) => (s.pendingChoice.playerIds = [stranger]),
      (s: any) => s.pendingChoice.optionIds.push("xyy.npc-action.nj09"),
      (s: any) => (s.pendingChoice.continuation.locals = { cards: s.drawPile }),
      (s: any) => (s.encounterState.resolution.npcDecision.canPass = false),
      (s: any) =>
        (s.encounterState.resolution.npcDecision.ownerPlayerId = stranger),
      (s: any) => (s.encounterState.resolution.npcDecision.actionIds = []),
      (s: any) => s.encounterState.resolution.npcDecision.deadlineAt++,
      (s: any) =>
        (s.encounterState.resolution.pendingEffect = { effectId: "forged" }),
      (s: any) => (s.encounterState.resolution.stage = "npc-options"),
      (s: any) => (s.turn.phase = "action"),
      (s: any) => (s.players[actor].alive = false),
    ]) {
      const bad = JSON.parse(JSON.stringify(state));
      mutate(bad);
      expect(() => migrateMatchState(bad)).toThrow();
    }
    expect(restore(state)).toEqual(state);
  });

  it("does not reveal which private cards make up another player's equally-sized hand", () => {
    const input = npcOptionsFixture("xyy.npc.nc104"),
      actor = input.activePlayerId!;
    const owner = input.turnOrder.find((id) => id !== actor)!;
    const variant = (index: number) => ({
      ...input,
      drawPile: input.drawPile.filter((_, i) => i !== index),
      players: {
        ...input.players,
        [owner]: { ...input.players[owner]!, hand: [input.drawPile[index]!] },
      },
    });
    const a = beginNpcOptions(variant(0), "open", 1001).state,
      b = beginNpcOptions(variant(1), "open", 1001).state;
    for (const viewer of input.turnOrder.filter((id) => id !== owner))
      expect(createPlayerView(a, viewer)).toEqual(createPlayerView(b, viewer));
  });

  it("rejects forged timeout choices, early timestamps, reports and chained action events", () => {
    const initial = npcOptionsFixture("xyy.npc.nc106", []);
    const waiting = beginNpcOptions(initial, "open", 1001).state;
    const command = timeout(waiting),
      result = applyCommand(waiting, command);
    if (!result.accepted) throw new Error(result.reason);
    const event = result.events.find(
      (e) => e.type === "npc-options.operation",
    )!;
    for (const patch of [
      { resolvedAt: 1002 },
      { operation: { ...(event.payload.operation as object), actionId: null } },
      { report: { ...(event.payload.report as object), rngCursorEnd: 999 } },
    ])
      expect(() =>
        reduceEvent(waiting, {
          ...event,
          payload: { ...event.payload, ...patch },
        }),
      ).toThrow();
    const optionsState = reduceEvent(waiting, event),
      effect = result.events.find((e) => e.type === "npc.operation")!;
    expect(() => reduceEvent(waiting, effect)).toThrow();
    expect(() =>
      reduceEvent(optionsState, {
        ...effect,
        payload: { ...effect.payload, matchVersion: optionsState.version + 1 },
      }),
    ).toThrow();
    expect(result.events.reduce(reduceEvent, waiting)).toEqual(result.state);
  });

  it("replays manual/timeout decisions and auto mode across successive NPCs without exposing hidden identities", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.boolean(),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        (seed, auto, bits) => {
          let input = npcOptionsFixture(
            "xyy.npc.nc104",
            ["xyy.npc.nc106", "xyy.npc.nc203"],
            { seed: `npc-options-${seed}` },
          );
          const actor = input.activePlayerId!;
          if (auto)
            input = {
              ...input,
              connections: {
                ...input.connections,
                [actor]: { ...input.connections[actor]!, status: "auto" },
              },
            };
          const opened = beginNpcOptions(input, "open", 1001);
          expect(opened.events.reduce(reduceEvent, input)).toEqual(
            opened.state,
          );
          let state = opened.state;
          for (let step = 0; state.pendingChoice !== null; step++) {
            if (step >= 8)
              throw new Error("NPC option/target chain failed to terminate");
            identities(state);
            const choice = state.pendingChoice;
            expect(choice.deadlineAt - choice.openedAt).toBe(15000);
            for (const id of state.turnOrder) {
              const view = createPlayerView(state, id);
              expect(createPlayerView(restore(state), id)).toEqual(view);
              if (id !== actor) {
                expect(view.pendingChoice).toBeNull();
                expect(view.availableActions).toEqual([]);
              }
              for (const other of Object.values(state.players).filter(
                (p) => p.id !== id,
              ))
                for (const card of other.hand)
                  expect(JSON.stringify(view)).not.toContain(card);
            }
            const selections =
              choice.optional && bits[(step + 1) % 8]
                ? []
                : [choice.optionIds[Math.abs(seed) % choice.optionIds.length]!];
            const data = {
              type: "submit-choice" as const,
              choiceId: choice.choiceId,
              selections,
            };
            let command: EngineCommand = npcCommand(
              state,
              actor,
              data,
              choice.openedAt + 1,
            );
            const outsider = state.turnOrder.find((id) => id !== actor)!;
            expect(
              applyCommand(
                state,
                npcCommand(state, outsider, data, choice.openedAt + 1),
              ).accepted,
            ).toBe(false);
            if (auto || bits[step]) {
              command = timeout(state);
              if (command.origin !== "system-timeout")
                throw new Error("Expected timeout");
              expect(command.deadlineAt).toBe(
                auto ? choice.openedAt : choice.deadlineAt,
              );
              expect(
                applyCommand(state, {
                  ...command,
                  deadlineAt: command.deadlineAt - 1,
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
          }
          identities(state);
          expect(state.encounterState.resolution!.stage).toBe("completed");
          expect(state.encounterState.npc).toBeNull();
        },
      ),
      { numRuns: 100, seed: 20260828 },
    );
  });
});
