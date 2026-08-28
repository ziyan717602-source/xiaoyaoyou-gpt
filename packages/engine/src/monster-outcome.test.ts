import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type MatchState,
} from "./index.js";
import { monsterFixture } from "./testing/monster-fixture.js";
import { npcCommand } from "./testing/npc-fixture.js";
import { beginMonsterDebut } from "./monster-debut.js";
import { beginBattleCards } from "./battle-cards.js";
import { beginMonsterOutcome } from "./monster-outcome.js";
import { ENCOUNTER_DEFINITIONS } from "./encounter-definitions.js";
import { grantPets } from "./testing/npc-fixture.js";
import { collectSystemDeadlines } from "./time-recovery.js";

function ready(
  monster: Parameters<typeof monsterFixture>[0],
  strength: number,
  participants = false,
) {
  let s = monsterFixture(monster, { supporter: null, hinder: null });
  const actor = s.activePlayerId!;
  s = {
    ...s,
    players: Object.fromEntries(
      Object.values(s.players).map((p) => [
        p.id,
        { ...p, hp: 500, maxHp: 600, strength: p.id === actor ? strength : 0 },
      ]),
    ),
  };
  if (participants)
    s = {
      ...s,
      encounterState: {
        ...s.encounterState,
        resolution: {
          ...s.encounterState.resolution!,
          supporter: {
            kind: "player",
            playerId: s.turnOrder.find(
              (id) =>
                id !== actor && s.players[id]!.team === s.players[actor]!.team,
            )!,
          },
          hinder: {
            kind: "player",
            playerId: s.turnOrder.find(
              (id) => s.players[id]!.team !== s.players[actor]!.team,
            )!,
          },
        },
      },
    };
  s = beginMonsterDebut(s, "debut", 1003).state;
  for (let i = 0; s.reactionWindow; i++) {
    const w = s.reactionWindow;
    const r = applyCommand(
      s,
      npcCommand(
        s,
        w.priorityOrder[w.priorityIndex]!,
        { type: "pass-reaction", windowId: w.windowId },
        1004 + i,
      ),
    );
    if (!r.accepted) throw new Error(r.reason);
    s = r.state;
  }
  s = beginBattleCards(s, "cards", 1020).state;
  for (let i = 0; s.encounterState.battle!.stage === "card-window"; i++) {
    const w = s.encounterState.battle!.cardWindow!;
    const id = w.playerIds.find((p) => !w.passedPlayerIds.includes(p))!;
    const r = applyCommand(
      s,
      npcCommand(
        s,
        id,
        { type: "pass-battle", windowId: w.windowId },
        1021 + i,
      ),
    );
    if (!r.accepted) throw new Error(r.reason);
    s = r.state;
  }
  return s;
}
function checked(
  before: MatchState,
  result: ReturnType<typeof beginMonsterOutcome>,
) {
  expect(result.events.reduce(reduceEvent, before)).toEqual(result.state);
  return migrateMatchState(JSON.parse(JSON.stringify(result.state)));
}
function settle(s: MatchState) {
  let next = s;
  for (let n = 0; next.encounterState.battle!.stage !== "complete"; n++) {
    if (n > 200) throw new Error("Outcome stalled");
    const actions = next.turnOrder.flatMap((id) =>
      createPlayerView(next, id).availableActions.map((a) => ({ id, a })),
    );
    const entry =
      actions.find(
        ({ a }) => a.type === "pass-reaction" || a.type === "pass-rescue",
      ) ?? actions.find(({ a }) => a.type === "submit-choice");
    if (!entry)
      throw new Error(
        `No outcome action at ${next.encounterState.battle!.stage}`,
      );
    const { id, a } = entry;
    const cmd =
      a.type === "submit-choice"
        ? {
            type: "submit-choice" as const,
            choiceId: a.choiceId,
            selections: a.optionIds.slice(0, a.minSelections),
          }
        : a.type === "pass-reaction" || a.type === "pass-rescue"
          ? a
          : null;
    if (!cmd) throw new Error("Invalid test action");
    const r = applyCommand(next, npcCommand(next, id, cmd, 1200 + n));
    if (!r.accepted) throw new Error(r.reason);
    next = checked(next, r);
  }
  return next;
}
describe("CS03 actual monster outcome runtime", () => {
  it.each(["owner", "element", "identity"])(
    "rejects capture choice %s corruption rather than redirecting a held monster",
    (mutation) => {
      let s = ready("xyy.monster.gf02", 30);
      const actor = s.activePlayerId!,
        enemy = s.turnOrder.find(
          (id) => s.players[id]!.team !== s.players[actor]!.team,
        )!;
      s = grantPets(s, actor, ["xyy.monster.gf01"]);
      s = grantPets(s, enemy, ["xyy.monster.gf04"]);
      const r = beginMonsterOutcome(s, "outcome", 1100).state;
      const raw = JSON.parse(JSON.stringify(r));
      const c = raw.encounterState.resolution.petDecision;
      if (mutation === "owner") {
        c.ownerPlayerId = enemy;
        c.cardIds[0] = "xyy.monster.gf04";
      }
      if (mutation === "element") {
        raw.encounterDiscard = raw.encounterDiscard.filter(
          (id: string) => id !== "xyy.monster.gs02",
        );
        raw.encounterState.pets[actor].push("xyy.monster.gs02");
        c.cardIds[0] = "xyy.monster.gs02";
      }
      if (mutation === "identity") c.choiceId = "unrelated-choice";
      expect(() => migrateMatchState(raw)).toThrow();
    },
  );
  it.each([false, true])(
    "GT01 TP03 prevention and Bingxin cancellation=%s preserve outcome continuation",
    (counter) => {
      const base = ready("xyy.monster.gt01", 30);
      const actor = base.activePlayerId!,
        other = base.turnOrder.find((id) => id !== actor)!;
      const input = {
        ...base,
        drawPile: base.drawPile.filter(
          (c) => c !== "xyy.card.tp03@39" && c !== "xyy.card.tp01@33",
        ),
        players: {
          ...base.players,
          [actor]: {
            ...base.players[actor]!,
            hand: ["xyy.card.tp03@39" as const],
          },
          [other]: {
            ...base.players[other]!,
            hand: ["xyy.card.tp01@33" as const],
          },
        },
      };
      let s = checked(input, beginMonsterOutcome(input, "outcome", 1100));
      const play = (owner: string) => {
        for (
          let i = 0;
          s.reactionWindow!.priorityOrder[s.reactionWindow!.priorityIndex] !==
          owner;
          i++
        ) {
          if (i > 6) throw new Error("Missing response priority");
          const w = s.reactionWindow!;
          const r = applyCommand(
            s,
            npcCommand(
              s,
              w.priorityOrder[w.priorityIndex]!,
              { type: "pass-reaction", windowId: w.windowId },
              1110 + i,
            ),
          );
          if (!r.accepted) throw new Error(r.reason);
          s = checked(s, r);
        }
        const action = createPlayerView(s, owner).availableActions.find(
          (a) => a.type === "play-reaction-card",
        );
        if (!action || action.type !== "play-reaction-card")
          throw new Error("Missing real reaction card");
        const r = applyCommand(s, npcCommand(s, owner, action, 1120));
        if (!r.accepted) throw new Error(r.reason);
        s = checked(s, r);
      };
      play(actor);
      if (counter) play(other);
      s = settle(s);
      expect(s.players[actor]!.hp).toBe(
        input.players[actor]!.hp - (counter ? 3 : 0),
      );
      expect(s.encounterState.pets[actor]).toEqual(["xyy.monster.gt01"]);
      expect(s.encounterState.battle!.outcome!.result).toBe("win");
    },
  );
  it("GT03 simultaneous dying can rescue one player and kill another before the frozen loss completes", () => {
    const base = ready("xyy.monster.gt03", 0);
    const actor = base.activePlayerId!;
    const allies = base.turnOrder.filter(
      (id) => base.players[id]!.team === base.players[actor]!.team,
    );
    const second = allies.find((id) => id !== actor)!;
    const rescuer = base.turnOrder.find((id) => !allies.includes(id))!;
    const input = {
      ...base,
      drawPile: base.drawPile.filter((c) => c !== "xyy.card.tp02@36"),
      players: {
        ...base.players,
        [actor]: { ...base.players[actor]!, hp: 1 },
        [second]: { ...base.players[second]!, hp: 1 },
        [rescuer]: {
          ...base.players[rescuer]!,
          hand: ["xyy.card.tp02@36" as const],
        },
      },
    };
    let s = checked(input, beginMonsterOutcome(input, "outcome", 1100));
    let rescued: string | null = null;
    for (let i = 0; s.encounterState.battle!.stage !== "complete"; i++) {
      if (i > 50) throw new Error("Dying continuation stalled");
      const actions = s.turnOrder.flatMap((id) =>
        createPlayerView(s, id).availableActions.map((a) => ({ id, a })),
      );
      const entry =
        (rescued === null
          ? actions.find(({ a }) => a.type === "play-rescue-card")
          : null) ??
        actions.find(
          ({ a }) => a.type === "pass-reaction" || a.type === "pass-rescue",
        );
      if (
        !entry ||
        !["play-rescue-card", "pass-rescue", "pass-reaction"].includes(
          entry.a.type,
        )
      )
        throw new Error("Missing dying action");
      const a = entry.a;
      if (
        a.type !== "play-rescue-card" &&
        a.type !== "pass-rescue" &&
        a.type !== "pass-reaction"
      )
        throw new Error("Invalid action");
      if (a.type === "play-rescue-card") rescued = a.targetPlayerId;
      const r = applyCommand(s, npcCommand(s, entry.id, a, 1200 + i));
      if (!r.accepted) throw new Error(r.reason);
      s = checked(s, r);
    }
    expect(rescued).not.toBeNull();
    expect(s.players[rescued!]!).toMatchObject({ alive: true, hp: 2 });
    expect([actor, second].filter((id) => !s.players[id]!.alive)).toHaveLength(
      1,
    );
    expect(s.encounterState.battle!.outcome!.result).toBe("lose");
    expect(
      s.encounterDiscard.filter((id) => id === "xyy.monster.gt03"),
    ).toHaveLength(1);
  });
  it.each([
    "options",
    "minimum",
    "maximum",
    "optional",
    "program-counter",
    "owner",
  ])("rejects a forged outcome choice %s on restore", (mutation) => {
    const s = ready("xyy.monster.gl01", 30);
    const r = beginMonsterOutcome(s, "outcome", 1100).state;
    const raw = JSON.parse(JSON.stringify(r));
    const c = raw.encounterState.battle.outcome;
    if (mutation === "options") c.choices[0].optionIds = ["foreign-player"];
    if (mutation === "minimum") c.choices[0].minSelections = 0;
    if (mutation === "maximum") c.choices[0].maxSelections = 999;
    if (mutation === "optional") c.choices[0].optional = true;
    if (mutation === "program-counter") {
      c.stepIndex = 99;
      c.choices[0].choiceId = `${c.effectId}:99:choice:${c.choices[0].playerId}`;
    }
    if (mutation === "owner") {
      c.choices[0].playerId = s.turnOrder.find((id) => id !== s.activePlayerId);
      c.choices[0].choiceId = `${c.effectId}:0:choice:${c.choices[0].playerId}`;
    }
    expect(() => migrateMatchState(raw)).toThrow();
  });
  it.each(
    ENCOUNTER_DEFINITIONS.filter((d) => d.kind === "monster").flatMap((d) => [
      { monster: d.id, win: true },
      { monster: d.id, win: false },
    ]),
  )(
    "$monster win=$win terminates actual effects and preserves all encounter entities",
    ({ monster, win }) => {
      const s = ready(
        monster as Parameters<typeof monsterFixture>[0],
        win ? 100 : 0,
        true,
      );
      const next = settle(checked(s, beginMonsterOutcome(s, "outcome", 1100)));
      expect(next.encounterState.battle!.outcome!.result).toBe(
        win ? "win" : "lose",
      );
      expect(next.encounterState.resolution).toMatchObject({
        stage: "completed",
        heldCardId: null,
        rewardDrawCount: 2,
      });
      const entities = [
        ...next.encounterDeck,
        ...next.encounterDiscard,
        ...next.reserveNpcDeck,
        ...next.reserveNpcDiscard,
        ...Object.values(next.encounterState.pets).flat(),
        ...Object.values(next.encounterState.companions).flat(),
      ];
      expect(entities).toHaveLength(46);
      expect(new Set(entities).size).toBe(46);
      expect(
        next.encounterState.pets[s.activePlayerId!]?.includes(
          monster as Parameters<typeof monsterFixture>[0],
        ) ?? false,
      ).toBe(win);
      const cards = [
        ...next.drawPile,
        ...next.discardPile,
        ...Object.values(next.players).flatMap((p) => [
          ...p.hand,
          ...Object.values(p.equipment).filter((c) => c !== null),
        ]),
      ];
      expect(cards).toHaveLength(56);
      expect(new Set(cards).size).toBe(56);
      const actor = s.activePlayerId!,
        f = s.encounterState.resolution!;
      const supporter =
        f.supporter!.kind === "player" ? f.supporter!.playerId : "invalid";
      const hinder =
        f.hinder!.kind === "player" ? f.hinder!.playerId : "invalid";
      const allies = s.turnOrder
        .filter((id) => s.players[id]!.team === s.players[actor]!.team)
        .sort();
      const enemies = s.turnOrder
        .filter((id) => s.players[id]!.team !== s.players[actor]!.team)
        .sort();
      const expected = Object.fromEntries(
        s.turnOrder.map((id) => [id, s.players[id]!.hp]),
      );
      const change = (ids: readonly string[], n: number) => {
        for (const id of ids) expected[id]! += n;
      };
      const code = monster.slice("xyy.monster.".length);
      if (win) {
        if (code === "gs02") {
          change(enemies, -1);
          change([enemies[0]!], -2);
        }
        if (code === "gs03") change([hinder], -4);
        if (code === "gs04" || code === "gt03") change(enemies, -1);
        if (code === "gh01") change([hinder], -2);
        if (code === "gh02" || code === "gh03") change([hinder], -3);
        if (code === "gh04") change(enemies, -2);
        if (code === "gl01") change([[...s.turnOrder].sort()[0]!], 2);
        if (code === "gf02") change([actor], 2);
        if (code === "gf03") change([actor, supporter], 2);
        if (code === "gf04") change([enemies[0]!], 2);
        if (code === "gt01") change([actor, supporter], -3);
      } else {
        if (["gs02", "gs04", "gl02", "gf01"].includes(code))
          change([actor], -2);
        if (code === "gs03") change([actor], -4);
        if (["gh01", "gh02", "gl01"].includes(code)) change([actor], -3);
        if (code === "gh03") change(allies.slice(0, 2), -3);
        if (code === "gh04") change([actor, supporter], -2);
        if (["gl04", "gf03", "gt03"].includes(code)) change(allies, -2);
        if (code === "gf02") change(enemies, 2);
        if (code === "gt01") change([hinder], -3);
      }
      expect(
        Object.fromEntries(
          next.turnOrder.map((id) => [id, next.players[id]!.hp]),
        ),
      ).toEqual(expected);
    },
  );
  it("GF01 win executes the actual draw then captures once with exact replay", () => {
    const s = ready("xyy.monster.gf01", 30);
    const actor = s.activePlayerId!;
    const next = checked(s, beginMonsterOutcome(s, "outcome", 1100));
    expect(next.players[actor]!.hand).toEqual([s.drawPile[0]]);
    expect(next.encounterState.pets[actor]).toEqual(["xyy.monster.gf01"]);
    expect(next.encounterState.resolution).toMatchObject({
      stage: "completed",
      heldCardId: null,
      rewardDrawCount: 2,
    });
    expect(() => beginMonsterOutcome(next, "again", 1101)).toThrow();
  });
  it("GL01 mandatory choice is projected privately and handled by actual commands", () => {
    const s = ready("xyy.monster.gl01", 30);
    const actor = s.activePlayerId!;
    let next = checked(s, beginMonsterOutcome(s, "outcome", 1100));
    const a = createPlayerView(next, actor).availableActions.find(
      (a) => a.type === "submit-choice",
    );
    expect(a).toBeDefined();
    if (!a || a.type !== "submit-choice") throw new Error("No cure choice");
    const r = applyCommand(
      next,
      npcCommand(
        next,
        actor,
        { type: "submit-choice", choiceId: a.choiceId, selections: [actor] },
        1101,
      ),
    );
    if (!r.accepted) throw new Error(r.reason);
    next = checked(next, r);
    expect(next.encounterState.pets[actor]).toEqual(["xyy.monster.gl01"]);
    expect(next.encounterState.battle!.stage).toBe("complete");
  });
  it("GT01 damage waits, resumes through the real reaction engine, then captures", () => {
    const s = ready("xyy.monster.gt01", 30);
    const actor = s.activePlayerId!;
    let next = checked(s, beginMonsterOutcome(s, "outcome", 1100));
    expect(next.encounterState.battle!.stage).toBe("outcome-damage");
    for (let i = 0; next.reactionWindow; i++) {
      const w = next.reactionWindow;
      const r = applyCommand(
        next,
        npcCommand(
          next,
          w.priorityOrder[w.priorityIndex]!,
          { type: "pass-reaction", windowId: w.windowId },
          1101 + i,
        ),
      );
      if (!r.accepted) throw new Error(r.reason);
      next = checked(next, r);
    }
    expect(next.players[actor]!.hp).toBe(s.players[actor]!.hp - 3);
    expect(next.encounterState.pets[actor]).toEqual(["xyy.monster.gt01"]);
    expect(next.encounterState.battle!.cards!.outcome!.activeSideWins).toBe(
      true,
    );
  });
  it("normal same-element capture uses a mandatory original deadline and applies pet deltas once", () => {
    const before = ready("xyy.monster.gf02", 30);
    const actor = before.activePlayerId!;
    const s = grantPets(before, actor, ["xyy.monster.gf01"]);
    const r = checked(s, beginMonsterOutcome(s, "outcome", 1100));
    expect(r.encounterState.battle!.stage).toBe("capture-choice");
    const deadline = collectSystemDeadlines(r).find((x) =>
      x.targetId.startsWith("monster-outcome:"),
    )!;
    expect(deadline.deadlineAt).toBe(16100);
    const a = createPlayerView(r, actor).availableActions[0]!;
    if (a.type !== "submit-choice") throw new Error("Missing retain-one");
    const selected = applyCommand(
      r,
      npcCommand(
        r,
        actor,
        {
          type: "submit-choice",
          choiceId: a.choiceId,
          selections: ["xyy.monster.gf02"],
        },
        1200,
      ),
    );
    if (!selected.accepted) throw new Error(selected.reason);
    const done = checked(r, selected);
    expect(done.encounterState.pets[actor]).toEqual(["xyy.monster.gf02"]);
    expect(
      done.encounterDiscard.filter((id) => id === "xyy.monster.gf01"),
    ).toHaveLength(1);
    expect(done.players[actor]!.strength).toBe(s.players[actor]!.strength + 1);
  });
  it("GT04 loss directly replaces an enemy earth pet without a second retention window", () => {
    const before = ready("xyy.monster.gt04", 0);
    const enemy = before.turnOrder.find(
      (id) =>
        before.players[id]!.team !==
        before.players[before.activePlayerId!]!.team,
    )!;
    const s = grantPets(before, enemy, ["xyy.monster.gt02"]);
    const r = checked(s, beginMonsterOutcome(s, "outcome", 1100));
    const entry = r.turnOrder
      .flatMap((id) =>
        createPlayerView(r, id).availableActions.map((a) => ({ id, a })),
      )
      .find(({ a }) => a.type === "submit-choice")!;
    if (entry.a.type !== "submit-choice")
      throw new Error("Missing replace-earth");
    const selected = applyCommand(
      r,
      npcCommand(
        r,
        entry.id,
        {
          type: "submit-choice",
          choiceId: entry.a.choiceId,
          selections: ["xyy.monster.gt02"],
        },
        1200,
      ),
    );
    if (!selected.accepted) throw new Error(selected.reason);
    const done = checked(r, selected);
    expect(done.encounterState.battle!.stage).toBe("complete");
    expect(done.encounterState.battle!.outcome!.result).toBe("lose");
    expect(done.encounterState.pets[enemy]).toEqual(["xyy.monster.gt04"]);
    expect(done.players[enemy]!.strength).toBe(s.players[enemy]!.strength + 2);
    expect(done.players[enemy]!.dexterity).toBe(s.players[enemy]!.dexterity);
  });
});
