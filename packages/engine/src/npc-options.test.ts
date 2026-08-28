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
import {
  npcCommand,
  acceptNpcCommand,
  grantPets,
} from "./testing/npc-fixture.js";
import {
  ENCOUNTER_DEFINITIONS,
  type NpcActionId,
} from "./encounter-definitions.js";
import { nextInt } from "./random.js";

const start = (state: MatchState) => beginNpcOptions(state, "open-npc", 1001);
function timeout(state: MatchState): EngineCommand {
  const deadline = collectSystemDeadlines(state).find(
    (d) => d.origin === "system-timeout",
  )!;
  return {
    origin: "system-timeout",
    commandId: deadline.id,
    matchId: state.matchId,
    expectedVersion: state.version,
    targetId: deadline.targetId,
    deadlineAt: deadline.deadlineAt,
  };
}
function paid(state: MatchState) {
  const actor = state.activePlayerId!;
  return {
    ...state,
    drawPile: state.drawPile.slice(2),
    players: {
      ...state.players,
      [actor]: { ...state.players[actor]!, hand: state.drawPile.slice(0, 2) },
    },
  };
}
const restore = (s: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(s)));

describe("NPC action window through real commands", () => {
  it("publishes only legal generic actions to the active player, one waiting summary to all six", () => {
    const input = npcOptionsFixture();
    const result = start(input),
      state = result.state;
    expect(result.events.reduce(reduceEvent, input)).toEqual(state);
    expect(state.pendingChoice).toMatchObject({
      minSelections: 0,
      maxSelections: 1,
      optional: true,
      fallback: "pass",
      optionIds: ["xyy.npc-action.nj04"],
      openedAt: 1001,
      deadlineAt: 16001,
    });
    for (const id of state.turnOrder) {
      const view = createPlayerView(state, id);
      expect(view.encounter.resolution).toMatchObject({
        stage: "npc-choice",
        decisionOwnerPlayerId: state.activePlayerId,
        deadlineAt: 16001,
      });
      expect(view.encounter.resolution).not.toHaveProperty("availableActions");
      if (id === state.activePlayerId)
        expect(view.availableActions).toEqual([
          {
            type: "submit-choice",
            choiceId: state.pendingChoice!.choiceId,
            optionIds: ["xyy.npc-action.nj04"],
            minSelections: 0,
            maxSelections: 1,
          },
        ]);
      else {
        expect(view.availableActions).toEqual([]);
        expect(view.pendingChoice).toBeNull();
      }
    }
    expect(restore(state)).toEqual(state);
  });

  it.each([false, true])(
    "manual/timeout pass (timeout=%s) reveals the next card without consuming random or rewarding the skipped NPC",
    (useTimeout) => {
      const input = npcOptionsFixture("xyy.npc.nc106", ["xyy.monster.gs01"]);
      const state = start(input).state;
      const command = useTimeout
        ? timeout(state)
        : npcCommand(state, state.activePlayerId!, {
            type: "submit-choice",
            choiceId: state.pendingChoice!.choiceId,
            selections: [],
          });
      const result = applyCommand(state, command);
      if (!result.accepted) throw new Error(result.reason);
      expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
      expect(result.state.encounterState.resolution).toMatchObject({
        stage: "monster-effects",
        heldCardId: "xyy.monster.gs01",
        rewardDrawCount: 0,
        revealCount: 2,
      });
      expect(result.state.encounterDiscard.at(-1)).toBe("xyy.npc.nc106");
      expect(result.state.pendingChoice).toBeNull();
      expect(result.state.rng).toEqual(input.rng);
      expect(result.state.players).toEqual(input.players);
    },
  );

  it("skips consecutive genuinely unusable NPCs, including an unusable last card, without a fake choice", () => {
    const input = npcOptionsFixture("xyy.npc.nc104", ["xyy.npc.nc107"]);
    const result = start(input);
    expect(result.state.pendingChoice).toBeNull();
    expect(result.state.encounterDiscard.slice(-2)).toEqual([
      "xyy.npc.nc104",
      "xyy.npc.nc107",
    ]);
    expect(result.state.encounterState.resolution).toMatchObject({
      stage: "deck-exhausted",
      heldCardId: null,
      scoreTiming: "immediate",
      rewardDrawCount: 0,
    });
    expect(result.events.reduce(reduceEvent, input)).toEqual(result.state);
    expect(result.state.rng).toEqual(input.rng);
  });

  it("last NPC forbids passing and seeded timeout executes one actual legal effect", () => {
    const input = paid(npcOptionsFixture("xyy.npc.nc106", []));
    const state = start(input).state,
      actor = state.activePlayerId!;
    const choice = state.pendingChoice!;
    expect(choice).toMatchObject({
      minSelections: 1,
      maxSelections: 1,
      optional: false,
      fallback: "deterministic-random",
      optionIds: ["xyy.npc-action.nj01", "xyy.npc-action.nj04"],
    });
    expect(
      applyCommand(
        state,
        npcCommand(state, actor, {
          type: "submit-choice",
          choiceId: choice.choiceId,
          selections: [],
        }),
      ).accepted,
    ).toBe(false);
    const random = nextInt(state.rng, 2);
    const selected = [...choice.optionIds].sort()[random.value]!;
    const result = applyCommand(state, timeout(state));
    if (!result.accepted) throw new Error(result.reason);
    expect(result.state.rng).toEqual(random.rng);
    expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
    expect(result.state.version).toBe(state.version + 1);
    expect(
      result.events.filter((e) => e.type === "npc.operation"),
    ).toHaveLength(1);
    if (selected === "xyy.npc-action.nj04")
      expect(result.state.players[actor]!.hand).toHaveLength(3);
    else
      expect(result.state.pendingChoice).toMatchObject({
        optionIds: [actor],
        continuation: { step: "donor" },
      });
  });

  it("passing to another NPC replaces the old window; expired/foreign/duplicate actions are rejected", () => {
    const input = npcOptionsFixture("xyy.npc.nc106", [
      "xyy.npc.nc203",
      "xyy.monster.gs01",
    ]);
    const state = start(input).state,
      actor = state.activePlayerId!;
    const old = npcCommand(state, actor, {
      type: "submit-choice",
      choiceId: state.pendingChoice!.choiceId,
      selections: [],
    });
    const result = applyCommand(state, old);
    if (!result.accepted) throw new Error(result.reason);
    expect(result.state.pendingChoice!.optionIds).toEqual([
      "xyy.npc-action.nj02",
    ]);
    expect(result.state.pendingChoice!.choiceId).not.toBe(
      state.pendingChoice!.choiceId,
    );
    expect(result.state.pendingChoice!.deadlineAt).toBe(17000);
    expect(applyCommand(result.state, old).accepted).toBe(false);
    const data = {
      type: "submit-choice" as const,
      choiceId: result.state.pendingChoice!.choiceId,
      selections: ["xyy.npc-action.nj02"],
    };
    expect(
      applyCommand(
        result.state,
        npcCommand(
          result.state,
          result.state.turnOrder.find((id) => id !== actor)!,
          data,
        ),
      ).accepted,
    ).toBe(false);
    expect(
      applyCommand(result.state, npcCommand(result.state, actor, data, 17001))
        .accepted,
    ).toBe(false);
    expect(() => start(result.state)).toThrow();
  });

  it.each(
    Array.from(
      { length: 9 },
      (_, i) => `xyy.npc-action.nj0${i + 1}` as NpcActionId,
    ),
  )(
    "selected %s reaches the real handler and terminates after its child choices/effects",
    (actionId) => {
      const npc =
        actionId === "xyy.npc-action.nj01"
          ? "xyy.npc.nc106"
          : (ENCOUNTER_DEFINITIONS.find(
              (d) => d.kind === "npc" && d.actionIds.includes(actionId),
            )!.id as `xyy.npc.${string}`);
      let input = paid(npcOptionsFixture(npc));
      if (actionId === "xyy.npc-action.nj07")
        input = grantPets(input, input.activePlayerId!, ["xyy.monster.gs04"]);
      let state = start(input).state;
      const selected = acceptNpcCommand(state, state.activePlayerId!, [
        actionId,
      ]);
      expect(selected.events.reduce(reduceEvent, state)).toEqual(
        selected.state,
      );
      state = selected.state;
      for (
        let step = 0;
        state.pendingChoice !== null || state.reactionWindow !== null;
        step++
      ) {
        if (step >= 30) throw new Error("NPC child failed to terminate");
        const data =
          state.reactionWindow !== null
            ? {
                type: "pass-reaction" as const,
                windowId: state.reactionWindow.windowId,
              }
            : state.dyingBatch !== null
              ? {
                  type: "pass-rescue" as const,
                  choiceId: state.pendingChoice!.choiceId,
                }
              : {
                  type: "submit-choice" as const,
                  choiceId: state.pendingChoice!.choiceId,
                  selections: [state.pendingChoice!.optionIds[0]!],
                };
        const actor =
          state.reactionWindow !== null
            ? state.reactionWindow.priorityOrder[
                state.reactionWindow.priorityIndex
              ]!
            : state.pendingChoice!.playerIds[0]!;
        const result = applyCommand(
          state,
          npcCommand(state, actor, data, 2001 + step),
        );
        if (!result.accepted) throw new Error(result.reason);
        expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
        state = restore(result.state);
      }
      expect(state.encounterState.resolution!.stage).toBe("completed");
      expect(state.encounterState.npc).toBeNull();
      expect(state.encounterState.resolution!.rewardDrawCount).toBe(2);
    },
  );
});
