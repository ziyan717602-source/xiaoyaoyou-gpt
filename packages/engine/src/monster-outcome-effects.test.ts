import { describe, expect, it } from "vitest";
import { monsterFixture, fundMonsterHands } from "./testing/monster-fixture.js";
import { beginMonsterDebut } from "./monster-debut.js";
import { planCureBatch } from "./healing.js";
import { withWeaponSkillEquipment } from "./hero-stats.js";
import { planDraw } from "./card-zones.js";
import type { MatchState } from "./index.js";
import type { CardInstanceId } from "./setup-content.js";
import {
  startMonsterOutcomeEffects,
  advanceMonsterOutcomeEffects,
  chooseMonsterOutcomeEffect,
  projectMonsterOutcomeEffects,
} from "./monster-outcome-effects.js";

function fixture(monster: Parameters<typeof monsterFixture>[0]) {
  return monsterFixture(monster, { supporter: null, hinder: null });
}
function equip(s: MatchState, id: string, cards: readonly CardInstanceId[]) {
  const [weapon = null, armor = null] = cards;
  return {
    ...s,
    drawPile: s.drawPile.filter((c) => !cards.includes(c)),
    players: {
      ...s.players,
      [id]: withWeaponSkillEquipment(s.players[id]!, { weapon, armor }),
    },
  };
}
const restore = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("CS03 monster outcome effect execution", () => {
  it("GF03 discards every ally hand before any redraw or damage, including a deck reshuffle", () => {
    const base = fundMonsterHands(
      fixture("xyy.monster.gf03"),
      [2, 2, 2, 2, 2, 2],
    );
    const s = { ...base, drawPile: [], discardPile: base.drawPile };
    const allies = Object.values(s.players)
      .filter((p) => p.team === s.players[s.activePlayerId!]!.team)
      .sort((a, b) => a.seat - b.seat);
    let expected = {
      ...s,
      discardPile: [...s.discardPile, ...allies.flatMap((p) => p.hand)],
    };
    const draws: Record<string, readonly CardInstanceId[]> = {};
    for (const p of allies) {
      const plan = planDraw(expected, p.hand.length);
      draws[p.id] = plan.cards;
      expected = {
        ...expected,
        drawPile: [...plan.drawPile],
        discardPile: [...plan.discardPile],
        rng: plan.rng,
      };
    }
    const r = startMonsterOutcomeEffects(s, "lose", 1010);
    expect(r.cursor.stage).toBe("damage");
    expect(r.state.rng).toEqual(expected.rng);
    for (const p of allies)
      expect(r.state.players[p.id]!.hand).toEqual(draws[p.id]);
    expect(r.damageIntents!.map((x) => x.targetPlayerId)).toEqual(
      allies.map((p) => p.id),
    );
    expect(r.state.players[s.activePlayerId!]!.hp).toBe(
      s.players[s.activePlayerId!]!.hp,
    );
  });
  it("GL02 discards only equipment still present after damage, draws that count and removes weapon skill bonuses", () => {
    let s = fixture("xyy.monster.gl02");
    const actor = s.activePlayerId!;
    s = {
      ...s,
      players: {
        ...s.players,
        [actor]: {
          ...s.players[actor]!,
          heroId: "xyy.hero.xj104",
          strength: 4,
        },
      },
    };
    s = equip(s, actor, ["xyy.card.wq01@47", "xyy.card.fj01@52"]);
    const r = startMonsterOutcomeEffects(s, "lose", 1010);
    expect(r.cursor.stage).toBe("damage");
    const next = advanceMonsterOutcomeEffects(s, restore(r.cursor), 1020);
    expect(next.state.players[actor]!.equipment).toEqual({
      weapon: null,
      armor: null,
    });
    expect(next.state.players[actor]!.hand).toEqual(s.drawPile.slice(0, 2));
    expect(next.state.players[actor]!.strength).toBe(4);
    expect(next.state.discardPile).toEqual([
      "xyy.card.wq01@47",
      "xyy.card.fj01@52",
    ]);
  });
  it("GL03 can pay multiple hand/equipment cards and cure two per card with WQ02 applied only if retained", () => {
    let s = fundMonsterHands(fixture("xyy.monster.gl03"), [2]);
    const actor = s.activePlayerId!;
    s = {
      ...s,
      players: {
        ...s.players,
        [actor]: { ...s.players[actor]!, hp: 1, maxHp: 20 },
      },
    };
    s = equip(s, actor, ["xyy.card.wq02@48"]);
    const r = startMonsterOutcomeEffects(s, "win", 1010);
    const hand = s.players[actor]!.hand;
    const kept = chooseMonsterOutcomeEffect(s, r.cursor, actor, hand, 1011);
    expect(kept.state.players[actor]!.hp).toBe(6);
    const paid = chooseMonsterOutcomeEffect(
      s,
      r.cursor,
      actor,
      [...hand, "xyy.card.wq02@48"],
      1011,
    );
    expect(paid.state.players[actor]!.hp).toBe(7);
    expect(paid.state.players[actor]!.equipment.weapon).toBeNull();
  });
  it("GS04 hides hand identities and transfers exactly one seeded card after damage", () => {
    let s = fundMonsterHands(fixture("xyy.monster.gs04"), [0, 2]);
    const actor = s.activePlayerId!,
      donor = s.turnOrder[1]!;
    s = {
      ...s,
      encounterState: {
        ...s.encounterState,
        resolution: {
          ...s.encounterState.resolution!,
          hinder: { kind: "player", playerId: donor },
        },
      },
    };
    const damage = startMonsterOutcomeEffects(s, "win", 1010);
    const r = advanceMonsterOutcomeEffects(s, damage.cursor, 1020);
    expect(r.cursor.choices[0]!.optionIds).toEqual(["hand"]);
    expect(
      JSON.stringify(projectMonsterOutcomeEffects(r.cursor, actor)),
    ).not.toContain(s.players[donor]!.hand[0]);
    const next = chooseMonsterOutcomeEffect(s, r.cursor, actor, ["hand"], 1021);
    expect(next.state.players[actor]!.hand).toHaveLength(1);
    expect(next.state.players[donor]!.hand).toHaveLength(1);
    expect(
      [
        ...next.state.players[actor]!.hand,
        ...next.state.players[donor]!.hand,
      ].sort(),
    ).toEqual([...s.players[donor]!.hand].sort());
    expect(next.state.rng.cursor).toBe(s.rng.cursor + 1);
  });
  it("GT01 victory damages the actor, not the enemy, with actual monster source", () => {
    const s = fixture("xyy.monster.gt01");
    const r = startMonsterOutcomeEffects(s, "win", 1010);
    expect(r.cursor.stage).toBe("damage");
    expect(r.damageIntents).toEqual([
      {
        itemId: `${r.cursor.effectId}:0:${s.activePlayerId}`,
        sourcePlayerId: null,
        sourceMonsterId: "xyy.monster.gt01",
        targetPlayerId: s.activePlayerId,
        amount: 3,
        element: "earth",
        hpEvoMask: ["from-nmb"],
      },
    ]);
    expect(r.state).toEqual(s);
  });
  it("GS02 re-evaluates living targets after the initial damage, not at program start", () => {
    const s = fixture("xyy.monster.gs02");
    const r = startMonsterOutcomeEffects(s, "win", 1010);
    const victims = r.damageIntents!.map((x) => x.targetPlayerId);
    const dead = victims[0]!;
    const after = {
      ...s,
      players: {
        ...s.players,
        [dead]: { ...s.players[dead]!, alive: false, hp: 0 },
      },
    };
    const next = advanceMonsterOutcomeEffects(after, restore(r.cursor), 1020);
    expect(next.cursor.choices[0]!.optionIds).toEqual(victims.slice(1));
    const final = chooseMonsterOutcomeEffect(
      next.state,
      restore(next.cursor),
      s.activePlayerId!,
      [victims[1]!],
      1021,
    );
    expect(final.damageIntents).toMatchObject([
      { targetPlayerId: victims[1], amount: 2 },
    ]);
  });
  it("GL03 loss recalculates tied maximum after the first discard and collects choices concurrently", () => {
    let s = fixture("xyy.monster.gl03");
    const [actor, second, third] = [
      s.activePlayerId!,
      ...s.turnOrder.filter((id) => id !== s.activePlayerId),
    ];
    s = equip(s, actor, ["xyy.card.wq01@47", "xyy.card.fj01@52"]);
    s = equip(s, second!, ["xyy.card.wq02@48"]);
    s = equip(s, third!, ["xyy.card.wq03@49"]);
    let r = startMonsterOutcomeEffects(s, "lose", 1010);
    r = chooseMonsterOutcomeEffect(
      r.state,
      r.cursor,
      actor,
      ["xyy.card.fj01@52"],
      1011,
    );
    expect(r.cursor.choices.map((x) => x.playerId).sort()).toEqual(
      [actor, second, third].sort(),
    );
    expect(new Set(r.cursor.choices.map((x) => x.deadlineAt))).toEqual(
      new Set([16011]),
    );
    const options = r.cursor.choices;
    r = chooseMonsterOutcomeEffect(
      r.state,
      restore(r.cursor),
      second!,
      ["xyy.card.wq02@48"],
      1020,
    );
    // MultiAsyncInput collects everyone's private response before applying any discard.
    expect(r.state.players[second!]!.equipment.weapon).toBe("xyy.card.wq02@48");
    expect(r.cursor.choices.find((x) => x.playerId === third)!.deadlineAt).toBe(
      16011,
    );
    for (const choice of options.filter((x) => x.playerId !== second))
      r = chooseMonsterOutcomeEffect(
        r.state,
        restore(r.cursor),
        choice.playerId,
        [choice.optionIds[0]!],
        1021,
      );
    expect(r.cursor.stage).toBe("effects-complete");
    expect(r.state.discardPile).toHaveLength(4);
    expect(
      [actor, second!, third!].map(
        (id) => r.state.players[id]!.equipment.weapon,
      ),
    ).toEqual([null, null, null]);
  });
  it("GL03 optional timeout passes without spending RNG; mandatory timeout is deterministic", () => {
    const s = fundMonsterHands(fixture("xyy.monster.gl03"), [2]);
    const r = startMonsterOutcomeEffects(s, "win", 1010);
    const done = chooseMonsterOutcomeEffect(
      r.state,
      r.cursor,
      s.activePlayerId!,
      null,
      16010,
    );
    expect(done.state.rng).toEqual(s.rng);
    expect(done.cures).toEqual([]);
    expect(done.state.players).toEqual(s.players);
    expect(done.cursor.stage).toBe("effects-complete");
    const m = startMonsterOutcomeEffects(
      fixture("xyy.monster.gl01"),
      "win",
      1010,
    );
    expect(
      chooseMonsterOutcomeEffect(
        m.state,
        m.cursor,
        m.cursor.choices[0]!.playerId,
        null,
        16010,
      ),
    ).toEqual(
      chooseMonsterOutcomeEffect(
        restore(m.state),
        restore(m.cursor),
        m.cursor.choices[0]!.playerId,
        null,
        16010,
      ),
    );
    expect(
      chooseMonsterOutcomeEffect(
        m.state,
        m.cursor,
        m.cursor.choices[0]!.playerId,
        null,
        16010,
      ).state.rng.cursor,
    ).toBe(m.state.rng.cursor + 1);
  });
  it("GL03 private choices are visible only to their owner", () => {
    const s = fundMonsterHands(fixture("xyy.monster.gl03"), [2]);
    const r = startMonsterOutcomeEffects(s, "win", 1010);
    for (const id of s.turnOrder.filter((id) => id !== s.activePlayerId)) {
      const view = projectMonsterOutcomeEffects(r.cursor, id);
      expect(JSON.stringify(view)).not.toContain(
        s.players[s.activePlayerId!]!.hand[0],
      );
      expect(view.availableActions).toEqual([]);
    }
    expect(
      projectMonsterOutcomeEffects(r.cursor, s.activePlayerId!)
        .availableActions[0]!.optionIds,
    ).toHaveLength(2);
  });
  it("monster cure provenance survives modifier planning and rejects a simultaneous player source", () => {
    const s = fixture("xyy.monster.gf02");
    const intent = {
      itemId: "monster-cure",
      sourcePlayerId: null,
      sourceMonsterId: "xyy.monster.gf02" as const,
      targetPlayerId: s.activePlayerId!,
      amount: 2,
      element: "wind",
      hpEvoMask: ["from-nmb"] as const,
    };
    expect(planCureBatch(s, [intent])[0]).toMatchObject({
      sourceMonsterId: intent.sourceMonsterId,
      hpEvoMask: ["from-nmb"],
    });
    expect(() =>
      planCureBatch(s, [{ ...intent, sourcePlayerId: s.activePlayerId! }]),
    ).toThrow();
  });
  it("explicit empty GT02 effects complete without pretending to discard or capture the monster", () => {
    const s = beginMonsterDebut(
      fixture("xyy.monster.gt02"),
      "debut",
      1003,
    ).state;
    for (const result of ["win", "lose", "escape"] as const) {
      const r = startMonsterOutcomeEffects(s, result, 1010);
      expect(r.cursor.stage).toBe("effects-complete");
      expect(r.state.encounterState.resolution!.heldCardId).toBe(
        "xyy.monster.gt02",
      );
    }
  });
});
