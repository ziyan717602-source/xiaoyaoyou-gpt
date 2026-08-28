import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ClientCommand } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  collectSystemDeadlines,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type MatchState,
  type EngineCommand,
} from "./index.js";
import { monsterFixture, fundMonsterHands } from "./testing/monster-fixture.js";
import { npcCommand } from "./testing/npc-fixture.js";
import { beginMonsterDebut } from "./monster-debut.js";
import { beginBattleCards } from "./battle-cards.js";
import { beginMonsterOutcome } from "./monster-outcome.js";
import { ENCOUNTER_DEFINITIONS } from "./encounter-definitions.js";

const restore = (s: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(s)));
function dispatch(s: MatchState, cmd: EngineCommand) {
  const r = applyCommand(s, cmd);
  expect(applyCommand(restore(s), cmd)).toEqual(r);
  if (!r.accepted) throw new Error(r.reason);
  expect(r.events.reduce(reduceEvent, s)).toEqual(r.state);
  expect(applyCommand(r.state, cmd).accepted).toBe(false);
  return restore(r.state);
}
function prepare(index: number, win: boolean) {
  const monster = ENCOUNTER_DEFINITIONS.filter((d) => d.kind === "monster")[
    index
  ]!;
  let s = fundMonsterHands(
    monsterFixture(monster.id as Parameters<typeof monsterFixture>[0], {
      seed: `outcome:${index}:${win}`,
      supporter: null,
      hinder: null,
    }),
    [2, 2, 2, 2, 2, 2],
  );
  s = {
    ...s,
    players: Object.fromEntries(
      Object.values(s.players).map((p) => [
        p.id,
        {
          ...p,
          hp: 100,
          maxHp: 120,
          strength: p.id === s.activePlayerId && win ? 100 : 0,
        },
      ]),
    ),
  };
  s = beginMonsterDebut(s, "debut", 1003).state;
  let at = 1004;
  while (s.reactionWindow) {
    const w = s.reactionWindow;
    s = dispatch(
      s,
      npcCommand(
        s,
        w.priorityOrder[w.priorityIndex]!,
        { type: "pass-reaction", windowId: w.windowId },
        at++,
      ),
    );
  }
  s = beginBattleCards(s, "cards", at++).state;
  while (s.encounterState.battle!.stage === "card-window") {
    const w = s.encounterState.battle!.cardWindow!;
    s = dispatch(
      s,
      npcCommand(
        s,
        w.playerIds.find((id) => !w.passedPlayerIds.includes(id))!,
        { type: "pass-battle", windowId: w.windowId },
        at++,
      ),
    );
  }
  const r = beginMonsterOutcome(s, "outcome", at++);
  expect(r.events.reduce(reduceEvent, s)).toEqual(r.state);
  return { state: restore(r.state), at };
}
function invariant(s: MatchState) {
  const cards = [
    ...s.drawPile,
    ...s.discardPile,
    ...Object.values(s.players).flatMap((p) => [
      ...p.hand,
      ...Object.values(p.equipment).filter((c) => c !== null),
    ]),
  ];
  expect(cards).toHaveLength(56);
  expect(new Set(cards).size).toBe(56);
  const entities = [
    ...s.encounterDeck,
    ...s.encounterDiscard,
    ...s.reserveNpcDeck,
    ...s.reserveNpcDiscard,
    ...Object.values(s.encounterState.pets).flat(),
    ...Object.values(s.encounterState.companions).flat(),
    ...(s.encounterState.resolution?.heldCardId
      ? [s.encounterState.resolution.heldCardId]
      : []),
  ];
  expect(entities).toHaveLength(46);
  expect(new Set(entities).size).toBe(46);
  for (const viewer of s.turnOrder) {
    const v = createPlayerView(s, viewer);
    for (const p of v.players) if (p.id !== viewer) expect(p.hand).toBeNull();
    expect(JSON.stringify(v)).not.toContain('"baselineStrength"');
    expect(JSON.stringify(v)).not.toContain('"passiveCapture"');
    expect(JSON.stringify(v)).not.toContain('"rng"');
  }
}
describe("CS03 outcome deterministic command-sequence replay", () => {
  it("migrates a v13 live battle-card window without starting effects or resetting the deadline", () => {
    const base = monsterFixture("xyy.monster.gf01", {
      supporter: null,
      hinder: null,
    });
    const current = beginBattleCards(
      beginMonsterDebut(base, "debut", 1003).state,
      "cards",
      1004,
    ).state;
    const legacy = JSON.parse(JSON.stringify(current));
    legacy.schemaVersion = 13;
    expect(migrateMatchState(legacy)).toEqual(current);
    expect(migrateMatchState(legacy).schemaVersion).toBe(14);
    expect(
      migrateMatchState(legacy).encounterState.battle!.outcome,
    ).toBeUndefined();
    expect(collectSystemDeadlines(migrateMatchState(legacy))).toEqual(
      collectSystemDeadlines(current),
    );
  });
  it("shrinks mixed manual/timeout choices with nonempty hands and preserves all entities at every JSON boundary", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 19 }),
        fc.boolean(),
        fc.array(fc.nat(1000), { minLength: 1, maxLength: 30 }),
        (index, win, choices) => {
          const initial = prepare(index, win);
          let s = initial.state,
            at = initial.at;
          for (let n = 0; s.encounterState.battle!.stage !== "complete"; n++) {
            invariant(s);
            if (n > 150) throw new Error("Outcome sequence stalled");
            const number = choices[n % choices.length]!;
            const deadlines = collectSystemDeadlines(s).filter(
              (d) => d.origin === "system-timeout",
            );
            if (number % 3 === 0 && deadlines.length) {
              const d = deadlines[number % deadlines.length]!;
              s = dispatch(s, {
                origin: "system-timeout",
                matchId: s.matchId,
                expectedVersion: s.version,
                commandId: `timeout:${n}`,
                deadlineAt: d.deadlineAt,
                targetId: d.targetId,
              });
              at = Math.max(at, d.deadlineAt);
              continue;
            }
            const actions = s.turnOrder
              .flatMap((id) =>
                createPlayerView(s, id).availableActions.map((a) => ({
                  id,
                  a,
                })),
              )
              .filter(
                ({ a }) =>
                  a.type === "submit-choice" ||
                  a.type === "pass-reaction" ||
                  a.type === "pass-rescue",
              );
            const entry = actions[number % actions.length];
            if (!entry) throw new Error("Outcome has no legal continuation");
            let cmd: ClientCommand;
            if (entry.a.type === "submit-choice") {
              const a = entry.a;
              const count =
                a.optional && number % 2 === 0
                  ? 0
                  : a.minSelections +
                    (number % (a.maxSelections - a.minSelections + 1));
              const offset = number % a.optionIds.length;
              const options = [
                ...a.optionIds.slice(offset),
                ...a.optionIds.slice(0, offset),
              ];
              cmd = {
                type: "submit-choice",
                choiceId: a.choiceId,
                selections: options.slice(0, count),
              };
            } else if (
              entry.a.type === "pass-reaction" ||
              entry.a.type === "pass-rescue"
            )
              cmd = entry.a;
            else throw new Error("Unexpected test action");
            s = dispatch(s, npcCommand(s, entry.id, cmd, at));
          }
          invariant(s);
          expect(s.encounterState.battle!.outcome!.result).toBe(
            win ? "win" : "lose",
          );
        },
      ),
      { seed: 30303, numRuns: 80, endOnFailure: false },
    );
  });
  it("tampered outcome event reports cannot inject a second capture or replace deterministic choices", () => {
    const { state } = prepare(8, true); // GL01 mandatory cure target
    const a = createPlayerView(state, state.activePlayerId!)
      .availableActions[0]!;
    if (a.type !== "submit-choice") throw new Error("Missing GL01 choice");
    const r = applyCommand(
      state,
      npcCommand(
        state,
        state.activePlayerId!,
        {
          type: "submit-choice",
          choiceId: a.choiceId,
          selections: [a.optionIds[0]!],
        },
        1200,
      ),
    );
    if (!r.accepted) throw new Error(r.reason);
    const raw = JSON.parse(JSON.stringify(r.events[0]));
    raw.payload.report.pets = {};
    expect(() => reduceEvent(state, raw)).toThrow();
    expect(() => reduceEvent(r.state, r.events[0]!)).toThrow();
  });
});
