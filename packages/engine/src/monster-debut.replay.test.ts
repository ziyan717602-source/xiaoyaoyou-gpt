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
  type CardInstanceId,
} from "./index.js";
import { beginMonsterDebut } from "./monster-debut.js";
import { beginNpcOptions } from "./npc-options.js";
import { npcOptionsFixture } from "./testing/npc-options-fixture.js";
import { monsterFixture, fundMonsterHands } from "./testing/monster-fixture.js";
import { npcCommand } from "./testing/npc-fixture.js";
import { heroAvailability } from "./hero-roster.js";

const restore = (s: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(s)));
function start(s: MatchState) {
  const result = beginMonsterDebut(
    s,
    "debut",
    s.encounterState.resolution!.updatedAt + 1,
  );
  expect(result.events.reduce(reduceEvent, s)).toEqual(result.state);
  return restore(result.state);
}
function step(s: MatchState, command: EngineCommand) {
  const result = applyCommand(s, command);
  if (!result.accepted) throw new Error(result.reason);
  const restarted = applyCommand(restore(s), command);
  expect(restarted).toEqual(result);
  expect(result.events.reduce(reduceEvent, s)).toEqual(result.state);
  expect(result.state.version).toBe(s.version + 1);
  return restore(result.state);
}
function pass(s: MatchState, timeout = true) {
  if (timeout) {
    const d = collectSystemDeadlines(s).find(
      (d) => d.origin === "system-timeout",
    )!;
    return step(s, {
      origin: "system-timeout",
      commandId: d.id,
      matchId: s.matchId,
      expectedVersion: s.version,
      targetId: d.targetId,
      deadlineAt: d.deadlineAt,
    });
  }
  const w = s.reactionWindow,
    c = s.pendingChoice;
  return step(
    s,
    npcCommand(
      s,
      w ? w.priorityOrder[w.priorityIndex]! : c!.playerIds[0]!,
      w
        ? { type: "pass-reaction", windowId: w.windowId }
        : { type: "pass-rescue", choiceId: c!.choiceId },
      (w?.openedAt ?? c!.openedAt) + 1,
    ),
  );
}
function finish(input: MatchState) {
  let s = input;
  for (let n = 0; s.encounterState.battle?.stage === "debut-damage"; n++) {
    if (n > 80) throw new Error("Stalled monster continuation");
    s = pass(s);
  }
  return s;
}
function identities(s: MatchState) {
  const cards = [
    ...s.drawPile,
    ...s.discardPile,
    ...Object.values(s.players).flatMap((p) => [
      ...p.hand,
      ...Object.values(p.equipment).filter((c) => c !== null),
    ]),
  ];
  const encounters = [
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
  const heroes = Object.values(heroAvailability(s)).flat();
  for (const [entities, count] of [
    [cards, 56],
    [encounters, 46],
    [heroes, 34],
  ] as const) {
    expect(entities).toHaveLength(count);
    expect(new Set(entities).size).toBe(count);
  }
  for (const id of s.turnOrder) {
    const view = createPlayerView(s, id);
    for (const other of Object.values(s.players).filter((p) => p.id !== id))
      for (const card of other.hand)
        expect(JSON.stringify(view)).not.toContain(card);
  }
}
function hand(
  s: MatchState,
  owner: string,
  cards: readonly CardInstanceId[],
): MatchState {
  return {
    ...s,
    drawPile: s.drawPile.filter((c) => !cards.includes(c)),
    players: { ...s.players, [owner]: { ...s.players[owner]!, hand: cards } },
  };
}

describe("monster debut replay, private views and cursor integrity", () => {
  it("migrates a real v11 NPC wait without changing cards, choices, RNG or deadlines", () => {
    const state = beginNpcOptions(npcOptionsFixture(), "open", 1001).state;
    const old = JSON.parse(JSON.stringify(state));
    old.schemaVersion = 11;
    delete old.encounterState.battle;
    expect(migrateMatchState(old)).toEqual(state);
    expect(state.schemaVersion).toBe(12);
  });

  const corruptions: Record<string, (s: any) => void> = {
    "missing battle": (s) => (s.encounterState.battle = null),
    "orphan damage cursor": (s) => {
      s.effectStack = [];
      s.reactionWindow = null;
    },
    "wrong monster": (s) =>
      (s.encounterState.battle.monsterId = "xyy.monster.gh03"),
    "wrong effect": (s) => (s.encounterState.battle.effectId = "fake"),
    "early ready": (s) => (s.encounterState.battle.stage = "combat-ready"),
    "foreign source": (s) => (s.effectStack[0].payload.sourceEffectId = "fake"),
    "monster attributed to actor": (s) =>
      (s.effectStack[0].payload.damageItems[0].sourcePlayerId =
        s.activePlayerId),
    "wrong monster source": (s) =>
      (s.effectStack[0].payload.damageItems[0].sourceMonsterId =
        "xyy.monster.gt02"),
    "unknown window effect": (s) => (s.reactionWindow.effectId = "fake"),
    "extended deadline": (s) => s.reactionWindow.deadlineAt++,
    "permanent numerical forgery": (s) => s.encounterState.battle.strength++,
    "cyclic damage ancestry": (s) => {
      const root = s.encounterState.battle.effectId;
      s.encounterState.battle.damageSourceParents[root] = root;
    },
  };
  it.each(Object.keys(corruptions))("rejects %s on restart", (label) => {
    const bad = JSON.parse(
      JSON.stringify(start(monsterFixture("xyy.monster.gh04"))),
    );
    corruptions[label]!(bad);
    expect(() => migrateMatchState(bad)).toThrow();
  });

  it("rejects invented event reports and duplicate starts", () => {
    const input = monsterFixture("xyy.monster.gt03");
    const result = beginMonsterDebut(input, "start", 1003);
    const event = result.events[0]!;
    expect(() =>
      reduceEvent(input, {
        ...event,
        payload: { ...event.payload, report: {} },
      }),
    ).toThrow();
    expect(() => reduceEvent(result.state, event)).toThrow();
  });

  it.each([false, true])(
    "TP03 prevention with Bingxin counter=%s resumes the original monster batch",
    (counter) => {
      let input = monsterFixture("xyy.monster.gh04");
      input = hand(input, input.turnOrder[0]!, ["xyy.card.tp03@39"]);
      input = hand(input, input.turnOrder[1]!, ["xyy.card.tp01@33"]);
      let s = start(input);
      const owner = input.turnOrder[0]!,
        counterOwner = input.turnOrder[1]!;
      for (
        let n = 0;
        s.reactionWindow!.priorityOrder[s.reactionWindow!.priorityIndex] !==
        owner;
        n++
      ) {
        if (n > 6) throw new Error("No TP03 priority");
        s = pass(s, false);
      }
      const action = createPlayerView(s, owner).availableActions.find(
        (a) => a.type === "play-reaction-card",
      )!;
      if (action.type !== "play-reaction-card")
        throw new Error("No real TP03 action");
      s = step(s, npcCommand(s, owner, action, s.reactionWindow!.openedAt + 1));
      if (counter) {
        for (
          let n = 0;
          s.reactionWindow!.priorityOrder[s.reactionWindow!.priorityIndex] !==
          counterOwner;
          n++
        ) {
          if (n > 6) throw new Error("No counter priority");
          s = pass(s, false);
        }
        const cancel = createPlayerView(s, counterOwner).availableActions.find(
          (a) => a.type === "play-reaction-card",
        )!;
        if (cancel.type !== "play-reaction-card")
          throw new Error("No real Bingxin action");
        s = step(
          s,
          npcCommand(s, counterOwner, cancel, s.reactionWindow!.openedAt + 1),
        );
      }
      s = finish(s);
      expect(s.players[owner]!.hp).toBe(
        input.players[owner]!.hp - (counter ? 2 : 0),
      );
      for (const id of input.turnOrder.filter((id) => id !== owner))
        expect(s.players[id]!.hp).toBe(input.players[id]!.hp - 2);
      expect(s.encounterState.battle!.stage).toBe("combat-ready");
      identities(s);
    },
  );

  it("continues after an active player's death while both teams survive; also supports JN20602 transformation", () => {
    for (const transform of [false, true]) {
      let input = monsterFixture("xyy.monster.gh04");
      const actor = input.activePlayerId!;
      input = {
        ...input,
        players: {
          ...input.players,
          [actor]: {
            ...input.players[actor]!,
            hp: 1,
            ...(transform ? { heroId: "xyy.hero.xj206" as const } : {}),
          },
        },
      };
      const result = finish(start(input));
      expect(result.phase).toBe("playing");
      expect(result.players[actor]!.alive).toBe(transform);
      if (transform)
        expect(result.players[actor]).toMatchObject({
          heroId: "xyy.hero.xj207",
          hp: 5,
        });
      expect(result.encounterState.battle!.stage).toBe("combat-ready");
      identities(result);
    }
  });

  it("waits for JN30201 and actual rescue without losing the monster continuation", () => {
    let input = monsterFixture("xyy.monster.gh04");
    const owner = input.turnOrder[0]!,
      victim = input.turnOrder[1]!;
    input = hand(input, owner, ["xyy.card.tp02@36"]);
    input = {
      ...input,
      players: {
        ...input.players,
        [owner]: { ...input.players[owner]!, heroId: "xyy.hero.xj302" },
        [victim]: { ...input.players[victim]!, hp: 1 },
      },
    };
    let s = start(input);
    while (s.reactionWindow) s = pass(s);
    expect(s.pendingChoice?.prompt).toBe("hero-skill:xyy.skill.jn30201");
    s = pass(s);
    expect(s.dyingBatch?.currentTargetPlayerId).toBe(victim);
    for (let n = 0; s.pendingChoice!.playerIds[0] !== owner; n++) {
      if (n > 6) throw new Error("No rescue priority");
      s = pass(s);
    }
    s = step(
      s,
      npcCommand(
        s,
        owner,
        {
          type: "play-rescue-card",
          cardInstanceId: "xyy.card.tp02@36",
          targetPlayerId: victim,
        },
        s.pendingChoice!.openedAt + 1,
      ),
    );
    s = finish(s);
    expect(s.players[victim]).toMatchObject({ alive: true, hp: 2 });
    expect(s.encounterState.battle!.stage).toBe("combat-ready");
    identities(s);
  });

  it("shrinks seeded mixed manual/timeout runs and replays every wait with all 56 cards, 46 encounters and 34 heroes intact", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
        fc.array(fc.integer({ min: 1, max: 5 }), {
          minLength: 6,
          maxLength: 6,
        }),
        (seed, choices, hp) => {
          let input = fundMonsterHands(
            monsterFixture("xyy.monster.gh04", { seed: `debut-${seed}` }),
            [1, 2, 0, 3, 1, 0],
          );
          input = {
            ...input,
            players: Object.fromEntries(
              Object.values(input.players).map((p) => [
                p.id,
                { ...p, hp: Math.min(p.maxHp, hp[p.seat]!) },
              ]),
            ),
          };
          let s = start(input);
          for (
            let n = 0;
            s.encounterState.battle!.stage === "debut-damage";
            n++
          ) {
            if (n > 80) throw new Error("Nonterminating debut");
            identities(s);
            s = pass(s, choices[n % choices.length]!);
          }
          identities(s);
          expect(s.rng).toEqual(input.rng);
        },
      ),
      { numRuns: 60, seed: 30301 },
    );
  });

  it("keeps actual JN30201 paid pursuit and JN50203 aftermath damage attached to the monster", () => {
    for (const skill of ["pursuit", "loot"] as const) {
      let input = monsterFixture("xyy.monster.gh04");
      const owner = input.turnOrder[0]!,
        victim = input.turnOrder[1]!;
      input = hand(input, skill === "pursuit" ? owner : victim, [
        "xyy.card.tp01@33",
      ]);
      input = {
        ...input,
        players: {
          ...input.players,
          [owner]: {
            ...input.players[owner]!,
            heroId: skill === "pursuit" ? "xyy.hero.xj302" : "xyy.hero.xj402",
          },
          [victim]: {
            ...input.players[victim]!,
            hp: skill === "loot" ? 1 : input.players[victim]!.hp,
          },
        },
      };
      let s = start(input);
      while (s.reactionWindow !== null) s = pass(s);
      if (skill === "pursuit") {
        expect(s.pendingChoice!.prompt).toBe("hero-skill:xyy.skill.jn30201");
        s = step(
          s,
          npcCommand(
            s,
            owner,
            {
              type: "submit-choice",
              choiceId: s.pendingChoice!.choiceId,
              selections: ["xyy.card.tp01@33"],
            },
            s.pendingChoice!.openedAt + 1,
          ),
        );
        expect(s.reactionWindow).not.toBeNull();
      } else {
        for (
          let n = 0;
          s.pendingChoice?.prompt !== "jn50203-distribute-loot";
          n++
        ) {
          if (n > 10) throw new Error("No death loot");
          s = pass(s);
        }
        s = pass(s);
        expect(s.reactionWindow).not.toBeNull();
      }
      s = finish(s);
      expect(s.encounterState.battle!.stage).toBe("combat-ready");
      // GH04 also damaged the pursuit owner, so C# JN30201 includes that
      // owner in its distinct original victims. Both paths cost 2 + 1 HP.
      expect(s.players[owner]!.hp).toBe(input.players[owner]!.hp - 3);
      identities(s);
    }
  });

  it("uses existing fire immunity and does not expose another hand's response capability", () => {
    let base = monsterFixture("xyy.monster.gh04");
    const owner = base.turnOrder[0]!;
    base = {
      ...base,
      players: {
        ...base.players,
        [owner]: { ...base.players[owner]!, heroId: "xyy.hero.xj405" },
      },
    };
    const immune = finish(start(base));
    expect(immune.players[owner]!.hp).toBe(base.players[owner]!.hp);
    identities(immune);
    const plain = monsterFixture("xyy.monster.gh04");
    const a = start(hand(plain, owner, ["xyy.card.tp03@39"]));
    const b = start(hand(plain, owner, ["xyy.card.tp01@33"]));
    expect(a.reactionWindow).toEqual(b.reactionWindow);
    for (const id of plain.turnOrder.filter((id) => id !== owner))
      expect(createPlayerView(a, id)).toEqual(createPlayerView(b, id));
  });

  it("already-auto players default-pass at opening time and reject repeated timeouts", () => {
    let input = monsterFixture("xyy.monster.gh04", { at: 60001 });
    input = {
      ...input,
      connections: Object.fromEntries(
        input.turnOrder.map((id) => [
          id,
          { status: "auto" as const, disconnectedAt: 0, autoAt: 60000 },
        ]),
      ),
    };
    let s = start(input);
    const at = s.encounterState.battle!.openedAt;
    for (let n = 0; s.reactionWindow; n++) {
      if (n > 6) throw new Error("Auto loop");
      const d = collectSystemDeadlines(s).find(
        (d) => d.origin === "system-timeout",
      )!;
      expect(d.deadlineAt).toBe(at);
      const command: EngineCommand = {
        origin: "system-timeout",
        commandId: d.id,
        matchId: s.matchId,
        expectedVersion: s.version,
        targetId: d.targetId,
        deadlineAt: d.deadlineAt,
      };
      s = step(s, command);
      expect(applyCommand(s, command).accepted).toBe(false);
    }
    expect(s.encounterState.battle!.stage).toBe("combat-ready");
    expect(s.rng).toEqual(input.rng);
  });
});
