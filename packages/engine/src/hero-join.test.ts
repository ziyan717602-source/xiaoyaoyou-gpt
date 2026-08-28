import { describe, expect, it } from "vitest";
import { beginNpcAction, legalNpcActions } from "./npc-effects.js";
import { heroAvailability, isHeroJoinable, reloadHero } from "./hero-roster.js";
import { heroDefinition, SETUP_HEROES, type MatchState } from "./index.js";
import { encounterDefinition } from "./encounter-definitions.js";
import {
  npcFixture,
  acceptNpcCommand,
  grantPets,
} from "./testing/npc-fixture.js";

function fixture() {
  const base = npcFixture("xyy.npc-action.nj01", "join", {
    npcId: "xyy.npc.nc106",
  });
  const actor = base.activePlayerId!;
  return {
    ...base,
    drawPile: base.drawPile.slice(5),
    players: {
      ...base.players,
      [actor]: { ...base.players[actor]!, hand: base.drawPile.slice(0, 5) },
    },
  };
}

describe("NJ01 C# role joining and passive reload", () => {
  it("can reuse a dead role without cloning its historical reference, and assigns HP without cure modifiers", () => {
    let input = fixture();
    const actor = input.activePlayerId!;
    const dead = input.turnOrder.find((id) => id !== actor)!;
    const paid = input.players[actor]!.hand;
    input = {
      ...input,
      drawPile: [...paid.slice(1), ...input.drawPile],
      players: {
        ...input.players,
        [actor]: { ...input.players[actor]!, hand: [paid[0]!] },
        [dead]: {
          ...input.players[dead]!,
          heroId: "xyy.hero.xj106",
          alive: false,
          hp: 0,
        },
      },
    };
    let state = beginNpcAction(input, "dead-role", 1001).state;
    state = acceptNpcCommand(state, actor, [actor]).state;
    state = acceptNpcCommand(state, actor, [actor]).state;
    expect(state.players[actor]).toMatchObject({
      heroId: "xyy.hero.xj106",
      alive: true,
      hp: 2,
    });
    expect(state.players[dead]).toMatchObject({
      heroId: "xyy.hero.xj106",
      alive: false,
      hp: 0,
    });
    const heroes = Object.values(heroAvailability(state)).flat();
    expect(heroes).toHaveLength(34);
    expect(new Set(heroes).size).toBe(34);
  });
  it.each([false, true])(
    "pays all cards and replaces/revives a teammate (dead=%s)",
    (dead) => {
      let input = fixture();
      const actor = input.activePlayerId!;
      const recipient = input.turnOrder.find(
        (id) =>
          id !== actor &&
          input.players[id]!.team === input.players[actor]!.team,
      )!;
      input = {
        ...input,
        players: {
          ...input.players,
          [recipient]: {
            ...input.players[recipient]!,
            alive: !dead,
            hp: dead ? 0 : 1,
          },
        },
      };
      const oldHero = input.players[recipient]!.heroId!;
      let state = beginNpcAction(input, "join", 1001).state;
      expect(state.pendingChoice!.optionIds).toEqual([actor]);
      state = acceptNpcCommand(state, actor, [actor]).state;
      expect(state.players[actor]!.hand).toEqual(input.players[actor]!.hand);
      expect(state.pendingChoice!.optionIds).toEqual(
        Object.values(input.players)
          .filter((p) => p.team === input.players[actor]!.team)
          .sort((a, b) => a.seat - b.seat)
          .map((p) => p.id),
      );
      state = acceptNpcCommand(state, actor, [recipient]).state;
      expect(state.players[actor]!.hand).toEqual([]);
      expect(state.discardPile).toEqual(input.players[actor]!.hand);
      expect(state.players[recipient]).toMatchObject({
        heroId: "xyy.hero.xj106",
        alive: true,
        hp: heroDefinition("xyy.hero.xj106").maxHp,
      });
      expect(state.encounterState.heroDiscards).toContain(oldHero);
      expect(state.encounterState.heroDiscards).not.toContain("xyy.hero.xj106");
      expect(state.encounterDiscard).toContain("xyy.npc.nc106");
      expect(state.encounterState.npc).toBeNull();
      expect(state.rng).toEqual(input.rng);
      const zones = Object.values(heroAvailability(state)).flat();
      expect(zones).toHaveLength(34);
      expect(new Set(zones).size).toBe(34);
    },
  );

  it("allows payer=self=recipient and reloads retained weapon, pets and hand limit only once", () => {
    let input = fixture();
    const actor = input.activePlayerId!;
    const weapon = "xyy.card.wq02@48" as const;
    const armor = "xyy.card.fj02@53" as const;
    input = {
      ...input,
      drawPile: input.drawPile.filter((id) => id !== weapon && id !== armor),
      players: {
        ...input.players,
        [actor]: {
          ...input.players[actor]!,
          equipment: { weapon, armor },
          strength: 99,
          dexterity: 99,
          handLimit: 99,
        },
      },
      turn: {
        ...input.turn!,
        usedSkillIds: ["xyy.skill.jn50201"],
        usedSkillCounts: { "xyy.skill.jn50202": 2 },
        usedSkillTargetIds: { "xyy.skill.jn50401": [actor] },
      },
    };
    input = grantPets(input, actor, ["xyy.monster.gs04"]);
    const opponent = input.turnOrder.find(
      (id) => input.players[id]!.team !== input.players[actor]!.team,
    )!;
    input = grantPets(input, opponent, ["xyy.monster.gl04"]);
    let state = beginNpcAction(input, "join", 1001).state;
    state = acceptNpcCommand(state, actor, [actor]).state;
    state = acceptNpcCommand(state, actor, [actor]).state;
    const hero = heroDefinition("xyy.hero.xj106");
    expect(state.players[actor]).toMatchObject({
      strength: hero.strength + 1,
      dexterity: hero.dexterity + 2,
      handLimit: 3,
      equipment: { weapon, armor },
      hand: [],
    });
    expect(state.encounterState.pets).toEqual(input.encounterState.pets);
    expect(state.encounterState.weaponDisabledReasons).toEqual(
      input.encounterState.weaponDisabledReasons,
    );
    expect(state.turn).toMatchObject({
      usedSkillIds: [],
      usedSkillCounts: {},
      usedSkillTargetIds: {},
    });
  });

  it("keeps other players' turn-use counters when a non-active role changes", () => {
    const input = fixture(),
      actor = input.activePlayerId!;
    const recipient = input.turnOrder.find((id) => id !== actor)!;
    const state = {
      ...input,
      turn: { ...input.turn!, usedSkillIds: ["xyy.skill.jn50201"] },
    };
    const next = reloadHero(state, recipient, "xyy.hero.xj404", 2);
    expect(next.turn).toEqual(state.turn);
    expect(next.players[recipient]!.handLimit).toBe(5);
    expect(next.players[recipient]!.hp).toBe(2);
  });

  it.each([
    ["xyy.hero.xj206", "xyy.hero.xj207", false, true],
    ["xyy.hero.xj206", "xyy.hero.xj207", true, false],
    ["xyy.hero.xj102", "xyy.hero.xj103", false, false],
    ["xyy.hero.xj303", "xyy.hero.xj304", false, false],
    ["xyy.hero.xj506", "xyy.hero.xj507", false, true],
    ["xyy.hero.xj106", "xyy.hero.xj106", false, true],
    ["xyy.hero.xj106", "xyy.hero.xj106", true, false],
  ] as const)(
    "join %s with existing %s alive=%s -> %s",
    (hero, existing, alive, expected) => {
      const input = fixture();
      const owner = input.turnOrder[0]!;
      const state = {
        ...input,
        players: Object.fromEntries(
          Object.values(input.players).map((p) => [
            p.id,
            {
              ...p,
              heroId: p.id === owner ? existing : null,
              alive: p.id === owner ? alive : p.alive,
            },
          ]),
        ),
      };
      expect(isHeroJoinable(state, hero)).toBe(expected);
      expect(
        isHeroJoinable(
          {
            ...state,
            encounterState: {
              ...state.encounterState,
              bannedHeroes: [existing],
            },
          },
          hero,
        ),
      ).toBe(false);
    },
  );

  it("excludes exactly the four scoped transformed roles even on an empty field", () => {
    const input = fixture();
    const state = {
      ...input,
      players: Object.fromEntries(
        Object.values(input.players).map((p) => [p.id, { ...p, heroId: null }]),
      ),
    };
    expect(
      SETUP_HEROES.filter((h) => !isHeroJoinable(state, h.id))
        .map((h) => h.id)
        .sort(),
    ).toEqual([
      "xyy.hero.xj103",
      "xyy.hero.xj207",
      "xyy.hero.xj304",
      "xyy.hero.xj507",
    ]);
  });

  it("rejects unavailable NJ01 before accepting payment; legality depends on public counts, not hand identities", () => {
    const input = fixture(),
      actor = input.activePlayerId!;
    const npc = input.encounterState.resolution!.heldCardId!;
    expect(encounterDefinition(npc).kind).toBe("npc");
    expect(legalNpcActions(input, actor, npc)).toContain("xyy.npc-action.nj01");
    const noPay = {
      ...input,
      players: {
        ...input.players,
        [actor]: { ...input.players[actor]!, hand: [] },
      },
    };
    expect(legalNpcActions(noPay, actor, npc)).toEqual(["xyy.npc-action.nj04"]);
    expect(() => beginNpcAction(noPay, "no-pay", 1001)).toThrow();
    const banned = {
      ...input,
      encounterState: {
        ...input.encounterState,
        bannedHeroes: ["xyy.hero.xj106" as const],
      },
    };
    expect(legalNpcActions(banned, actor, npc)).toEqual([
      "xyy.npc-action.nj04",
    ]);
    expect(() => beginNpcAction(banned, "banned", 1001)).toThrow();
  });
});
