import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type MatchState,
  type EngineCommand,
} from "./index.js";
import { beginNpcAction } from "./npc-effects.js";
import { exchangePet, discardOwnedPets } from "./pet-effects.js";
import {
  grantPets,
  npcFixture,
  npcCommand,
  acceptNpcCommand,
} from "./testing/npc-fixture.js";

const restore = (s: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(s)));
describe("CS03 NJ07 persistence, authority and deterministic timeout", () => {
  it("already-auto owner completes all three mandatory decisions at their opening instant exactly once", () => {
    let state = npcFixture("xyy.npc-action.nj07");
    const actor = state.activePlayerId!;
    state = grantPets(state, actor, ["xyy.monster.gs04"]);
    state = {
      ...state,
      connections: {
        ...state.connections,
        [actor]: { status: "auto", disconnectedAt: 0, autoAt: 60000 },
      },
    };
    const cursor = state.rng.cursor;
    state = beginNpcAction(state, "start", 60001).state;
    for (let i = 0; i < 3; i++) {
      const d = collectSystemDeadlines(state).find(
        (d) => d.origin === "system-timeout",
      )!;
      expect(d.deadlineAt).toBe(60001);
      const command: EngineCommand = {
        origin: "system-timeout",
        commandId: d.id,
        matchId: state.matchId,
        targetId: d.targetId,
        deadlineAt: d.deadlineAt,
        expectedVersion: state.version,
      };
      const result = applyCommand(state, command);
      expect(applyCommand(restore(state), command)).toEqual(result);
      if (!result.accepted) throw new Error(result.reason);
      expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
      expect(applyCommand(result.state, command).accepted).toBe(false);
      state = result.state;
    }
    expect(state.pendingChoice).toBeNull();
    expect(state.encounterState.npc).toBeNull();
    expect(state.rng.cursor).toBe(cursor + 3);
    expect(state.encounterDiscard).toHaveLength(1);
  });
  it("migrates v9 ownership once, preserving an existing wait, deck, identity and RNG", () => {
    let base = npcFixture("xyy.npc-action.nj06");
    const owner = base.activePlayerId!;
    base = {
      ...base,
      drawPile: base.drawPile.slice(1),
      players: {
        ...base.players,
        [owner]: { ...base.players[owner]!, hand: [base.drawPile[0]!] },
      },
    };
    const waiting = beginNpcAction(base, "start", 1001).state;
    const current = grantPets(waiting, owner, [
      "xyy.monster.gs04",
      "xyy.monster.gl04",
    ]);
    const legacy = JSON.parse(JSON.stringify(current));
    legacy.schemaVersion = 9;
    legacy.players = waiting.players;
    delete legacy.encounterState.weaponDisabledReasons;
    expect(migrateMatchState(legacy)).toEqual(current);
    expect(restore(current)).toEqual(current);
    expect(current.pendingChoice).toEqual(waiting.pendingChoice);
    expect(current.rng).toEqual(waiting.rng);
  });
  it("rejects corruption of pet-choice ownership, routing, deadlines and weapon disable reasons", () => {
    let state = npcFixture("xyy.npc-action.nj07");
    const actor = state.activePlayerId!,
      donor = state.turnOrder.find((id) => id !== actor)!;
    const recipient = state.turnOrder.find(
      (id) =>
        id !== donor && state.players[id]!.team === state.players[donor]!.team,
    )!;
    state = grantPets(state, donor, ["xyy.monster.gl04"]);
    state = beginNpcAction(state, "start", 1001).state;
    state = acceptNpcCommand(state, actor, [donor]).state;
    state = acceptNpcCommand(state, actor, [recipient]).state;
    for (const mutate of [
      (s: any) => {
        s.pendingChoice.playerIds = [donor];
      },
      (s: any) => {
        s.encounterState.npc.stage = "card";
      },
      (s: any) => {
        s.encounterState.npc.targets = [donor, donor];
      },
      (s: any) => {
        s.pendingChoice.deadlineAt++;
      },
      (s: any) => {
        s.encounterState.weaponDisabledReasons = {};
      },
      (s: any) => {
        delete s.encounterState.weaponDisabledReasons;
      },
      (s: any) => {
        s.encounterState.pets[recipient] = ["xyy.monster.gl04"];
      },
    ]) {
      const corrupt = JSON.parse(JSON.stringify(state));
      mutate(corrupt);
      expect(() => migrateMatchState(corrupt)).toThrow();
    }
    const result = acceptNpcCommand(state, actor, ["xyy.monster.gl04"]);
    const event = result.events[0]!;
    expect(() =>
      reduceEvent(state, {
        ...event,
        payload: { ...event.payload, report: {} },
      }),
    ).toThrow();
    expect(() => reduceEvent(result.state, event)).toThrow();
  });
  it("losing GT03 removes its campaign participant without erasing unrelated participants", () => {
    const base = npcFixture("xyy.npc-action.nj07"),
      actor = base.activePlayerId!;
    const teammate = base.turnOrder.find(
      (id) =>
        id !== actor && base.players[id]!.team === base.players[actor]!.team,
    )!;
    let state = grantPets(base, actor, ["xyy.monster.gt03"]);
    state = {
      ...state,
      encounterState: {
        ...state.encounterState,
        resolution: {
          ...state.encounterState.resolution!,
          supporter: {
            kind: "pet",
            ownerPlayerId: actor,
            cardId: "xyy.monster.gt03",
          },
          hinder: { kind: "player", playerId: teammate },
        },
      },
    };
    const result = exchangePet(state, actor, teammate, "xyy.monster.gt03");
    expect(result.encounterState.resolution!.supporter).toBeNull();
    expect(result.encounterState.resolution!.hinder).toEqual(
      state.encounterState.resolution!.hinder,
    );
    expect(result.encounterState.pets[teammate]).toEqual(["xyy.monster.gt03"]);
    expect(restore(discardOwnedPets(result, [teammate]))).toEqual(
      discardOwnedPets(result, [teammate]),
    );
  });
  it("mixed legal/timeout commands survive every wait, reject stale/foreign/early commands and preserve 46 entities", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
        (seed, timeouts) => {
          let initial = npcFixture("xyy.npc-action.nj07", `pets-${seed}`);
          for (const [i, pet] of (
            [
              "xyy.monster.gs01",
              "xyy.monster.gs04",
              "xyy.monster.gt04",
              "xyy.monster.gl04",
            ] as const
          ).entries())
            initial = grantPets(initial, initial.turnOrder[i]!, [pet]);
          let state = beginNpcAction(initial, "start", 1001).state;
          const actor = state.activePlayerId!,
            stranger = state.turnOrder.find((id) => id !== actor)!;
          for (let step = 0; state.pendingChoice !== null; step++) {
            if (step >= 3) throw new Error("NJ07 exceeded its three choices");
            const choice = state.pendingChoice;
            expect(choice.playerIds).toEqual([actor]);
            expect(choice.deadlineAt - choice.openedAt).toBe(15000);
            const selection = [...choice.optionIds].sort()[
              Math.abs(seed) % choice.optionIds.length
            ]!;
            const command = npcCommand(
              state,
              actor,
              {
                type: "submit-choice",
                choiceId: choice.choiceId,
                selections: [selection],
              },
              choice.openedAt + 1,
            );
            expect(
              applyCommand(
                state,
                npcCommand(
                  state,
                  stranger,
                  {
                    type: "submit-choice",
                    choiceId: choice.choiceId,
                    selections: [selection],
                  },
                  choice.openedAt + 1,
                ),
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
                    choiceId: choice.choiceId,
                    selections: [selection],
                  },
                  choice.deadlineAt + 1,
                ),
              ).accepted,
            ).toBe(false);
            let actual: EngineCommand = command;
            if (timeouts[step]) {
              const d = collectSystemDeadlines(state).find(
                (d) => d.origin === "system-timeout",
              )!;
              actual = {
                origin: "system-timeout",
                commandId: d.id,
                targetId: d.targetId,
                deadlineAt: d.deadlineAt,
                expectedVersion: state.version,
                matchId: state.matchId,
              };
              expect(
                applyCommand(state, { ...actual, deadlineAt: d.deadlineAt - 1 })
                  .accepted,
              ).toBe(false);
            }
            const result = applyCommand(state, actual);
            expect(applyCommand(restore(state), actual)).toEqual(result);
            if (!result.accepted) throw new Error(result.reason);
            expect(result.events.reduce(reduceEvent, state)).toEqual(
              result.state,
            );
            expect(applyCommand(result.state, actual).accepted).toBe(false);
            state = result.state;
            for (const id of state.turnOrder) {
              const view = createPlayerView(state, id);
              expect(view.encounter.weaponDisabledReasons).toEqual(
                state.encounterState.weaponDisabledReasons,
              );
              expect(createPlayerView(restore(state), id)).toEqual(view);
              if (id !== actor) {
                expect(view.pendingChoice).toBeNull();
                expect(view.availableActions).toEqual([]);
              }
            }
          }
          const ids = [
            ...state.encounterDeck,
            ...state.encounterDiscard,
            ...state.reserveNpcDeck,
            ...state.reserveNpcDiscard,
            ...Object.values(state.encounterState.pets).flat(),
          ];
          expect(ids).toHaveLength(46);
          expect(new Set(ids).size).toBe(46);
          expect(state.encounterState.resolution!.stage).toBe("completed");
        },
      ),
      { numRuns: 80, seed: 20260828 },
    );
  });
});
