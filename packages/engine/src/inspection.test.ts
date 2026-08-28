import { describe, expect, it } from "vitest";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  type MatchState,
} from "./index.js";
import {
  acceptInspection,
  inspectionCommand,
  inspectionFixture,
  passInspectionReactions,
  startInspection,
} from "./testing/inspection-fixture.js";

function conserved(state: MatchState) {
  const actionCards = [
    ...state.drawPile,
    ...state.discardPile,
    ...Object.values(state.players).flatMap((p) => p.hand),
  ];
  expect(actionCards.slice().sort()).toEqual([...SETUP_CARD_INSTANCES].sort());
  const encounters = [
    ...state.encounterDeck,
    ...state.encounterDiscard,
    ...state.reserveNpcDeck,
    ...state.reserveNpcDiscard,
  ];
  expect(encounters).toHaveLength(46);
  expect(new Set(encounters).size).toBe(46);
}

describe("JP02 authoritative encounter inspection", () => {
  it("different secret deck orders produce identical non-owner views and historical knowledge never tracks later draws", () => {
    const base = inspectionFixture();
    const other = { ...base, encounterDeck: [...base.encounterDeck].reverse() };
    const a = passInspectionReactions(startInspection(base));
    const b = passInspectionReactions(startInspection(other));
    const actor = base.activePlayerId!;
    for (const id of Object.keys(base.players).filter((id) => id !== actor)) {
      expect(createPlayerView(a, id)).toEqual(createPlayerView(b, id));
    }
    expect(createPlayerView(a, actor).encounter.lastInspection).not.toEqual(
      createPlayerView(b, actor).encounter.lastInspection,
    );
    const finished = acceptInspection(
      a,
      inspectionCommand(a, actor, {
        type: "submit-choice",
        choiceId: a.pendingChoice!.choiceId,
        selections: ["keep-order"],
      }),
    ).state;
    const later = {
      ...finished,
      encounterDeck: finished.encounterDeck.slice(1),
      encounterDiscard: [
        ...finished.encounterDiscard,
        finished.encounterDeck[0]!,
      ],
    };
    expect(createPlayerView(later, actor).encounter.lastInspection).toEqual(
      createPlayerView(finished, actor).encounter.lastInspection,
    );
    conserved(later);
  });

  it("disconnect grace does not extend the pending choice and reconnect does not re-open a timed-out choice", () => {
    const waiting = passInspectionReactions(
      startInspection(inspectionFixture()),
    );
    const actor = waiting.activePlayerId!;
    const grace = acceptInspection(waiting, {
      origin: "system-presence",
      commandId: "jp02-disconnect",
      matchId: waiting.matchId,
      expectedVersion: waiting.version,
      playerId: actor,
      status: "disconnected",
      occurredAt: 1_100,
    }).state;
    const deadlines = collectSystemDeadlines(grace);
    expect(deadlines.find((d) => d.origin === "system-auto")?.deadlineAt).toBe(
      61_100,
    );
    const deadline = deadlines.find((d) => d.targetId.startsWith("choice:"))!;
    expect(deadline.deadlineAt).toBe(16_000);
    const timedOut = acceptInspection(grace, {
      origin: "system-timeout",
      commandId: deadline.id,
      matchId: grace.matchId,
      expectedVersion: grace.version,
      deadlineAt: deadline.deadlineAt,
      targetId: deadline.targetId,
    }).state;
    const connected = acceptInspection(timedOut, {
      origin: "system-presence",
      commandId: "jp02-reconnect",
      matchId: timedOut.matchId,
      expectedVersion: timedOut.version,
      playerId: actor,
      status: "connected",
      occurredAt: 16_001,
    }).state;
    expect(connected.pendingChoice).toBeNull();
    expect(connected.encounterDeck).toEqual(waiting.encounterDeck);
    expect(connected.rng).toEqual(waiting.rng);
    expect(createPlayerView(connected, actor).encounter.lastInspection).toEqual(
      createPlayerView(waiting, actor).encounter.lastInspection,
    );
  });

  it("offers only self with a nonempty deck, rejects empty or foreign targets without payment", () => {
    const state = inspectionFixture();
    const actor = state.activePlayerId!;
    expect(createPlayerView(state, actor).availableActions).toContainEqual({
      type: "play-card",
      cardInstanceId: "xyy.card.jp02@3",
      targetPlayerIds: [actor],
    });
    for (const input of [state, { ...state, encounterDeck: [] }]) {
      const target =
        input === state
          ? Object.keys(state.players).find((id) => id !== actor)!
          : actor;
      expect(
        applyCommand(
          input,
          inspectionCommand(input, actor, {
            type: "play-card",
            cardInstanceId: "xyy.card.jp02@3",
            targetPlayerIds: [target],
          }),
        ).accepted,
      ).toBe(false);
    }
    expect(
      createPlayerView(
        { ...state, encounterDeck: [] },
        actor,
      ).availableActions.some(
        (a) =>
          a.type === "play-card" &&
          a.cardInstanceId.startsWith("xyy.card.jp02"),
      ),
    ).toBe(false);
  });

  it("reveals mixed monster/NPC top only to owner after all passes; swaps exactly two without RNG", () => {
    const initial = inspectionFixture();
    const top = [
      initial.encounterDeck.find((id) => id.startsWith("xyy.monster."))!,
      initial.encounterDeck.find((id) => id.startsWith("xyy.npc."))!,
    ];
    expect(top.every(Boolean)).toBe(true);
    const state = {
      ...initial,
      encounterDeck: [
        ...top,
        ...initial.encounterDeck.filter((id) => !top.includes(id)),
      ],
    };
    const actor = state.activePlayerId!;
    const started = startInspection(state);
    expect(started.discardPile).toContain("xyy.card.jp02@3");
    for (const id of Object.keys(state.players)) {
      expect(createPlayerView(started, id).encounter.lastInspection).toBeNull();
      expect(JSON.stringify(createPlayerView(started, id))).not.toContain(
        top[0],
      );
    }
    const waiting = passInspectionReactions(started);
    expect(waiting.pendingChoice).toMatchObject({
      optional: true,
      fallback: "pass",
      optionIds: ["keep-order", "swap-top-two"],
      openedAt: 1_000,
      deadlineAt: 16_000,
    });
    for (const id of Object.keys(state.players)) {
      const view = createPlayerView(waiting, id);
      if (id === actor) {
        expect(view.encounter.lastInspection?.cardIds).toEqual(top);
        expect(view.pendingChoice).not.toBeNull();
      } else {
        expect(view.encounter.lastInspection).toBeNull();
        expect(view.pendingChoice).toBeNull();
        expect(view.availableActions).toEqual([]);
        for (const card of top)
          expect(JSON.stringify(view)).not.toContain(card);
      }
    }
    const result = acceptInspection(
      waiting,
      inspectionCommand(
        waiting,
        actor,
        {
          type: "submit-choice",
          choiceId: waiting.pendingChoice!.choiceId,
          selections: ["swap-top-two"],
        },
        2_000,
      ),
    );
    expect(result.events.reduce(reduceEvent, waiting)).toEqual(result.state);
    expect(result.state.encounterDeck).toEqual([
      top[1],
      top[0],
      ...state.encounterDeck.slice(2),
    ]);
    expect(result.state.rng).toEqual(state.rng);
    expect(result.state.pendingChoice).toBeNull();
    expect(result.state.effectStack).toEqual([]);
    conserved(result.state);
  });

  it("one card creates a persistent private historical result without an artificial waiting point", () => {
    const base = inspectionFixture();
    const state = {
      ...base,
      encounterDeck: base.encounterDeck.slice(0, 1),
      encounterDiscard: base.encounterDeck.slice(1),
    };
    const result = passInspectionReactions(startInspection(state));
    expect(result.pendingChoice).toBeNull();
    expect(result.effectStack).toEqual([]);
    expect(
      createPlayerView(result, state.activePlayerId!).encounter.lastInspection
        ?.cardIds,
    ).toEqual(state.encounterDeck);
    expect(
      createPlayerView(
        migrateMatchState(JSON.parse(JSON.stringify(result))),
        state.activePlayerId!,
      ).encounter,
    ).toEqual(createPlayerView(result, state.activePlayerId!).encounter);
    conserved(result);
  });

  it("timeout and already-auto owner keep order, do not consume random, and reject stale/foreign choices", () => {
    const waiting = passInspectionReactions(
      startInspection(inspectionFixture()),
    );
    const actor = waiting.activePlayerId!;
    const choose = {
      type: "submit-choice" as const,
      choiceId: waiting.pendingChoice!.choiceId,
      selections: ["swap-top-two"],
    };
    for (const playerId of Object.keys(waiting.players).filter(
      (id) => id !== actor,
    )) {
      expect(
        applyCommand(waiting, inspectionCommand(waiting, playerId, choose))
          .accepted,
      ).toBe(false);
    }
    expect(
      applyCommand(waiting, inspectionCommand(waiting, actor, choose, 16_001)),
    ).toMatchObject({ accepted: false, reason: "expired-window" });
    expect(
      applyCommand(
        waiting,
        inspectionCommand(waiting, actor, {
          ...choose,
          selections: ["forged"],
        }),
      ).accepted,
    ).toBe(false);
    for (const state of [
      waiting,
      {
        ...waiting,
        connections: {
          ...waiting.connections,
          [actor]: {
            status: "auto" as const,
            disconnectedAt: 0,
            autoAt: 60_000,
          },
        },
      },
    ]) {
      const deadline = collectSystemDeadlines(state).find((d) =>
        d.targetId.startsWith("choice:"),
      )!;
      expect(deadline.deadlineAt).toBe(state === waiting ? 16_000 : 1_000);
      const result = acceptInspection(state, {
        origin: "system-timeout",
        commandId: deadline.id,
        matchId: state.matchId,
        expectedVersion: state.version,
        targetId: deadline.targetId,
        deadlineAt: deadline.deadlineAt,
      });
      expect(result.state.encounterDeck).toEqual(waiting.encounterDeck);
      expect(result.state.rng).toEqual(waiting.rng);
      expect(result.state.pendingChoice).toBeNull();
      expect(result.events.reduce(reduceEvent, state)).toEqual(result.state);
      expect(
        applyCommand(
          result.state,
          inspectionCommand(result.state, actor, choose),
        ).accepted,
      ).toBe(false);
      conserved(result.state);
    }
  });

  it("Bingxin cancellation reveals nothing; counter-cancellation restores exactly one inspection", () => {
    for (const counter of [false, true]) {
      let state = startInspection(inspectionFixture());
      const cards = ["xyy.card.tp01@33", "xyy.card.tp01@34"];
      for (const card of cards.slice(0, counter ? 2 : 1)) {
        const owner = Object.values(state.players).find((p) =>
          p.hand.includes(card as never),
        )!.id;
        while (
          state.reactionWindow!.priorityOrder[
            state.reactionWindow!.priorityIndex
          ] !== owner
        ) {
          const w = state.reactionWindow!;
          state = acceptInspection(
            state,
            inspectionCommand(state, w.priorityOrder[w.priorityIndex]!, {
              type: "pass-reaction",
              windowId: w.windowId,
            }),
          ).state;
        }
        state = acceptInspection(
          state,
          inspectionCommand(state, owner, {
            type: "play-reaction-card",
            cardInstanceId: card,
            targetEffectId: state.reactionWindow!.effectId,
          }),
        ).state;
      }
      state = passInspectionReactions(state);
      if (counter) {
        expect(state.pendingChoice?.prompt).toBe("inspect-encounter");
        expect(
          createPlayerView(state, state.activePlayerId!).encounter
            .lastInspection?.cardIds,
        ).toEqual(state.encounterDeck.slice(0, 2));
      } else {
        expect(state.pendingChoice).toBeNull();
        expect(state.effectStack).toEqual([]);
        for (const id of Object.keys(state.players))
          expect(
            createPlayerView(state, id).encounter.lastInspection,
          ).toBeNull();
      }
      conserved(state);
    }
  });
});
