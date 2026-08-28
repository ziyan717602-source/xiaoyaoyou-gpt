import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  collectSystemDeadlines,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type EngineCommand,
} from "./index.js";
import {
  acceptInspection,
  inspectionCommand,
  inspectionFixture,
  passInspectionReactions,
  startInspection,
} from "./testing/inspection-fixture.js";

describe("JP02 private knowledge and command replay", () => {
  it("replays seeded keep/swap/timeout across every serialized response and choice boundary", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.constantFrom("keep-order", "swap-top-two", "timeout"),
        (seed, option) => {
          const initial = inspectionFixture(`jp02-${seed}`);
          let normal = initial;
          let restarted = migrateMatchState(
            JSON.parse(JSON.stringify(initial)),
          );
          let eventReplay = initial;
          const run = (command: EngineCommand) => {
            const a = acceptInspection(normal, command);
            const b = acceptInspection(restarted, command);
            expect(b).toEqual(a);
            eventReplay = a.events.reduce(reduceEvent, eventReplay);
            expect(eventReplay).toEqual(a.state);
            normal = a.state;
            restarted = migrateMatchState(JSON.parse(JSON.stringify(b.state)));
            for (const id of Object.keys(normal.players))
              expect(createPlayerView(restarted, id)).toEqual(
                createPlayerView(normal, id),
              );
          };
          run(
            inspectionCommand(normal, normal.activePlayerId!, {
              type: "play-card",
              cardInstanceId: "xyy.card.jp02@3",
              targetPlayerIds: [normal.activePlayerId!],
            }),
          );
          let guard = 0;
          while (normal.reactionWindow !== null) {
            if (++guard > 6) throw new Error("Response failed to terminate");
            const w = normal.reactionWindow;
            run(
              inspectionCommand(normal, w.priorityOrder[w.priorityIndex]!, {
                type: "pass-reaction",
                windowId: w.windowId,
              }),
            );
          }
          if (option === "timeout") {
            const d = collectSystemDeadlines(normal).find((d) =>
              d.targetId.startsWith("choice:"),
            )!;
            run({
              origin: "system-timeout",
              commandId: d.id,
              targetId: d.targetId,
              deadlineAt: d.deadlineAt,
              matchId: normal.matchId,
              expectedVersion: normal.version,
            });
          } else {
            run(
              inspectionCommand(
                normal,
                normal.activePlayerId!,
                {
                  type: "submit-choice",
                  choiceId: normal.pendingChoice!.choiceId,
                  selections: [option],
                },
                2_000,
              ),
            );
          }
          expect(normal.encounterDeck).toEqual(
            option === "swap-top-two"
              ? [
                  initial.encounterDeck[1],
                  initial.encounterDeck[0],
                  ...initial.encounterDeck.slice(2),
                ]
              : initial.encounterDeck,
          );
          expect(normal.rng).toEqual(initial.rng);
          expect(normal.effectStack).toEqual([]);
          expect(normal.pendingChoice).toBeNull();
        },
      ),
      { numRuns: 40, seed: 20260828 },
    );
  });

  it("upgrades schema 7 without reshuffling or granting anyone knowledge", () => {
    const initial = inspectionFixture();
    const legacy = JSON.parse(JSON.stringify(initial));
    legacy.schemaVersion = 7;
    delete legacy.encounterInspections;
    const upgraded = migrateMatchState(legacy);
    expect(upgraded).toEqual(initial);
    expect(upgraded.encounterInspections).toEqual({});
    const broken = { ...initial, encounterInspections: undefined };
    expect(() => migrateMatchState(broken)).toThrow("schema v11");
  });

  it("rejects tampered inspection/order events instead of silently replaying different deck results", () => {
    const waiting = passInspectionReactions(
      startInspection(inspectionFixture()),
    );
    const result = acceptInspection(
      waiting,
      inspectionCommand(
        waiting,
        waiting.activePlayerId!,
        {
          type: "submit-choice",
          choiceId: waiting.pendingChoice!.choiceId,
          selections: ["swap-top-two"],
        },
        2_000,
      ),
    );
    const event = result.events[0]!;
    for (const payload of [
      { ...event.payload, timeout: true },
      { ...event.payload, playerId: "intruder" },
      { ...event.payload, choiceId: "old-choice" },
      { ...event.payload, resolvedAt: 16_001 },
    ])
      expect(() => reduceEvent(waiting, { ...event, payload })).toThrow();
    expect(() =>
      reduceEvent(
        { ...waiting, encounterDeck: [...waiting.encounterDeck].reverse() },
        event,
      ),
    ).toThrow();
  });
});
