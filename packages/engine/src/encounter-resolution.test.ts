import { describe, expect, it } from "vitest";
import {
  beginEncounterResolution,
  openNpcDecision,
  chooseNpcAction,
  defaultNpcAction,
  finishNpcAction,
  finishMonsterBattle,
  projectEncounterResolution,
  evaluateBattle,
  evaluatePetScore,
  chooseCapturedPet,
  defaultCapturedPet,
  assertEncounterOwnership,
} from "./encounter-resolution.js";
import {
  encounterDefinition,
  ENCOUNTER_DEFINITIONS,
} from "./encounter-definitions.js";
import {
  SETUP_MONSTER_IDS,
  SETUP_NPC_IDS,
  type EncounterCardId,
} from "./encounter-content.js";
import type { EncounterDecisionState } from "./encounter.js";
import type { RngState } from "./index.js";
import { nextInt } from "./random.js";

const rng: RngState = {
  algorithm: "sha256-counter-v1",
  seed: "resolution-red",
  cursor: 0,
};
const decision: EncounterDecisionState = {
  kind: "encounter-decision",
  activePlayerId: "p1",
  stage: "ready-reveal",
  outcome: "fight",
  decisionOwnerPlayerId: null,
  supporter: { kind: "player", playerId: "p1" },
  hinder: null,
  supportOptions: [],
  hinderOptions: [],
  configuredExtraHinderOptions: [],
  revealedCardId: null,
  openedAt: 1_000,
  deadlineAt: 1_000,
};
const zones = (deck: readonly EncounterCardId[]) => ({
  encounterDeck: deck,
  encounterDiscard: [],
  pets: {},
  companions: {},
});

describe("CS03-03 reveal routes and terminal ownership", () => {
  it("has exactly the scoped 20 monsters and 26 NPCs with canonical battle/action metadata", () => {
    expect(ENCOUNTER_DEFINITIONS.map((d) => d.id).sort()).toEqual(
      [...SETUP_MONSTER_IDS, ...SETUP_NPC_IDS].sort(),
    );
    expect(encounterDefinition("xyy.monster.gs03")).toMatchObject({
      kind: "monster",
      strength: 9,
      agility: 2,
      level: 2,
      element: "water",
    });
    expect(encounterDefinition("xyy.npc.nc103")).toMatchObject({
      kind: "npc",
      strength: 4,
      actionIds: ["xyy.npc-action.nj07", "xyy.npc-action.nj09"],
      heroId: "xyy.hero.xj103",
    });
    expect(() => encounterDefinition("xyy.monster.not-real")).toThrow();
  });

  it("holds revealed monsters for real battle effects and never auto-resolves them as no-op cards", () => {
    const input = zones(["xyy.monster.gf01", "xyy.npc.nc207"]);
    const next = beginEncounterResolution("flow", decision, input);
    expect(next.flow).toMatchObject({
      stage: "monster-effects",
      heldCardId: "xyy.monster.gf01",
      result: null,
    });
    expect(next.zones.encounterDeck).toEqual(["xyy.npc.nc207"]);
    expect(next.zones.encounterDiscard).toEqual([]);
    expect(() =>
      finishNpcAction(next.flow, next.zones, "wrong-effect"),
    ).toThrow();
    const won = finishMonsterBattle(next.flow, next.zones, {
      outcome: "win",
      capture: true,
      ownerPlayerId: "p1",
    });
    expect(won.flow).toMatchObject({
      stage: "completed",
      heldCardId: null,
      result: "monster-battle",
      rewardDrawCount: 2,
    });
    expect(won.zones.pets.p1).toEqual(["xyy.monster.gf01"]);
    expect(() =>
      finishMonsterBattle(won.flow, won.zones, {
        outcome: "win",
        capture: true,
        ownerPlayerId: "p1",
      }),
    ).toThrow();
    const lost = finishMonsterBattle(next.flow, next.zones, {
      outcome: "lose",
      capture: false,
      ownerPlayerId: "p1",
    });
    expect(lost.zones.encounterDiscard).toEqual(["xyy.monster.gf01"]);
    expect(Object.values(lost.zones.pets).flat()).toEqual([]);
  });

  it("giving up discards just one card, earns one reward draw and waits until turn end to score an empty deck", () => {
    const next = beginEncounterResolution(
      "give-up",
      { ...decision, outcome: "give-up" },
      zones(["xyy.npc.nc207"]),
    );
    expect(next.flow).toMatchObject({
      stage: "completed",
      heldCardId: null,
      result: "give-up",
      rewardDrawCount: 1,
      scoreTiming: "turn-end",
    });
    expect(next.zones.encounterDiscard).toEqual(["xyy.npc.nc207"]);
    expect(
      beginEncounterResolution("empty", decision, zones([])).flow,
    ).toMatchObject({ stage: "deck-exhausted", heldCardId: null });
  });

  it("NPC pass discards and reveals the next card without repeating support/hinder or exposing the deck", () => {
    const start = beginEncounterResolution(
      "npc-pass",
      decision,
      zones(["xyy.npc.nc207", "xyy.monster.gs03"]),
    );
    const opened = openNpcDecision(
      start.flow,
      start.zones,
      ["xyy.npc-action.nj04", "xyy.npc-action.nj05"],
      2_000,
    );
    expect(opened.flow.npcDecision).toMatchObject({
      ownerPlayerId: "p1",
      canPass: true,
      deadlineAt: 17_000,
    });
    for (const player of ["p1", "p2", "p3", "p4", "p5", "p6"]) {
      const view = projectEncounterResolution(opened.flow, player);
      expect(view.availableActions.length).toBe(player === "p1" ? 1 : 0);
      expect(JSON.stringify(view)).not.toContain("xyy.monster.gs03");
    }
    expect(() =>
      chooseNpcAction(
        opened.flow,
        opened.zones,
        "p2",
        opened.flow.npcDecision!.choiceId,
        null,
        2_100,
      ),
    ).toThrow();
    expect(() =>
      chooseNpcAction(opened.flow, opened.zones, "p1", "old", null, 2_100),
    ).toThrow();
    const passed = defaultNpcAction(opened.flow, opened.zones, rng, 17_000);
    expect(passed.rng).toEqual(rng);
    expect(passed.flow).toMatchObject({
      stage: "monster-effects",
      heldCardId: "xyy.monster.gs03",
      supporter: decision.supporter,
      hinder: null,
    });
    expect(passed.zones.encounterDiscard).toEqual(["xyy.npc.nc207"]);
    expect(passed.zones.encounterDeck).toEqual([]);
  });

  it("the final NPC with legal actions forbids passing and seeded timeout selects a legal action", () => {
    const start = beginEncounterResolution(
      "last-npc",
      decision,
      zones(["xyy.npc.nc207"]),
    );
    const opened = openNpcDecision(
      start.flow,
      start.zones,
      ["xyy.npc-action.nj05", "xyy.npc-action.nj04"],
      2_000,
    );
    const choice = opened.flow.npcDecision!;
    expect(choice).toMatchObject({
      canPass: false,
      actionIds: ["xyy.npc-action.nj04", "xyy.npc-action.nj05"],
    });
    expect(() =>
      chooseNpcAction(
        opened.flow,
        opened.zones,
        "p1",
        choice.choiceId,
        null,
        2_010,
      ),
    ).toThrow();
    expect(() =>
      chooseNpcAction(
        opened.flow,
        opened.zones,
        "p1",
        choice.choiceId,
        "xyy.npc-action.nj09",
        2_010,
      ),
    ).toThrow();
    expect(() =>
      chooseNpcAction(
        opened.flow,
        opened.zones,
        "p1",
        choice.choiceId,
        "xyy.npc-action.nj04",
        17_001,
      ),
    ).toThrow();
    const selected = defaultNpcAction(opened.flow, opened.zones, rng, 17_000);
    expect(selected.flow.stage).toBe("npc-effect");
    expect(selected.rng.cursor).toBeGreaterThan(rng.cursor);
    expect(
      defaultNpcAction(
        JSON.parse(JSON.stringify(opened.flow)),
        JSON.parse(JSON.stringify(opened.zones)),
        rng,
        17_000,
      ),
    ).toEqual(selected);
    // Selection alone must not claim the effect executed or consume the NPC.
    expect(selected.flow.heldCardId).toBe("xyy.npc.nc207");
    expect(selected.zones.encounterDiscard).toEqual([]);
    const finished = finishNpcAction(
      selected.flow,
      selected.zones,
      selected.flow.pendingEffect!.effectId,
    );
    expect(finished.flow).toMatchObject({
      stage: "completed",
      result: "npc-action",
      heldCardId: null,
      scoreTiming: "turn-end",
      rewardDrawCount: 2,
    });
    expect(finished.zones.encounterDiscard).toEqual(["xyy.npc.nc207"]);
  });

  it("NPCs with no legal actions discard and re-reveal, but exhaust immediately on the final unusable NPC", () => {
    let current = beginEncounterResolution(
      "no-options",
      decision,
      zones(["xyy.npc.nc103", "xyy.npc.nc104"]),
    );
    current = openNpcDecision(current.flow, current.zones, [], 2_000);
    expect(current.flow).toMatchObject({
      stage: "npc-options",
      heldCardId: "xyy.npc.nc104",
    });
    current = openNpcDecision(current.flow, current.zones, [], 2_000);
    expect(current.flow).toMatchObject({
      stage: "deck-exhausted",
      scoreTiming: "immediate",
      heldCardId: null,
      rewardDrawCount: 0,
    });
    expect(current.zones.encounterDiscard).toEqual([
      "xyy.npc.nc103",
      "xyy.npc.nc104",
    ]);
  });

  it("NJ09 transfers the held NPC into the companion zone exactly once; duplicate entities or foreign action options fail", () => {
    const start = beginEncounterResolution(
      "companion",
      decision,
      zones(["xyy.npc.nc101"]),
    );
    expect(() =>
      openNpcDecision(start.flow, start.zones, ["xyy.npc-action.nj04"], 2_000),
    ).toThrow();
    const opened = openNpcDecision(
      start.flow,
      start.zones,
      ["xyy.npc-action.nj09"],
      2_000,
    );
    const selected = chooseNpcAction(
      opened.flow,
      opened.zones,
      "p1",
      opened.flow.npcDecision!.choiceId,
      "xyy.npc-action.nj09",
      2_001,
    );
    const finished = finishNpcAction(
      selected.flow,
      selected.zones,
      selected.flow.pendingEffect!.effectId,
    );
    expect(finished.zones.companions.p1).toEqual(["xyy.npc.nc101"]);
    expect(finished.zones.encounterDiscard).toEqual([]);
    expect(() =>
      finishNpcAction(
        finished.flow,
        finished.zones,
        selected.flow.pendingEffect!.effectId,
      ),
    ).toThrow();
    expect(() =>
      beginEncounterResolution(
        "duplicate",
        decision,
        zones(["xyy.npc.nc101", "xyy.npc.nc101"]),
      ),
    ).toThrow();
  });
});

describe("CS03-03 mandatory pet retention and rejected commands", () => {
  it("uses canonical legal ID order for mandatory pet timeout regardless of old/new presentation order (SEM-002)", () => {
    const started = beginEncounterResolution("sorted-pet", decision, {
      ...zones(["xyy.monster.gf01"]),
      pets: { p3: ["xyy.monster.gf04"] },
    });
    const waiting = finishMonsterBattle(
      started.flow,
      started.zones,
      { outcome: "win", capture: true, ownerPlayerId: "p3" },
      2_000,
    );
    const expected = nextInt(rng, 2);
    const actual = defaultCapturedPet(waiting.flow, waiting.zones, rng, 17_000);
    expect(actual.zones.pets.p3).toEqual([
      ["xyy.monster.gf01", "xyy.monster.gf04"][expected.value],
    ]);
    expect(actual.rng).toEqual(expected.rng);
  });
  function waiting() {
    const initial = {
      ...zones(["xyy.monster.gf02"]),
      pets: { p3: ["xyy.monster.gf01" as const] },
    };
    const started = beginEncounterResolution("pet-conflict", decision, initial);
    return finishMonsterBattle(
      started.flow,
      started.zones,
      { outcome: "win", capture: true, ownerPlayerId: "p3" },
      2_000,
    );
  }
  it("holds the new pet until its recipient chooses one same-element pet, then discards only the other", () => {
    const input = waiting();
    expect(input.flow).toMatchObject({
      stage: "pet-choice",
      heldCardId: "xyy.monster.gf02",
      rewardDrawCount: 0,
      petDecision: {
        ownerPlayerId: "p3",
        openedAt: 2_000,
        deadlineAt: 17_000,
        cardIds: ["xyy.monster.gf01", "xyy.monster.gf02"],
      },
    });
    expect(input.zones.pets.p3).toEqual(["xyy.monster.gf01"]);
    for (const kept of ["xyy.monster.gf01", "xyy.monster.gf02"] as const) {
      const finished = chooseCapturedPet(
        input.flow,
        input.zones,
        "p3",
        input.flow.petDecision!.choiceId,
        kept,
        2_001,
      );
      expect(finished.flow).toMatchObject({
        stage: "completed",
        heldCardId: null,
        petDecision: null,
        rewardDrawCount: 2,
        scoreTiming: "turn-end",
      });
      expect(finished.zones.pets.p3).toEqual([kept]);
      expect(finished.zones.encounterDiscard).toEqual([
        kept === "xyy.monster.gf01" ? "xyy.monster.gf02" : "xyy.monster.gf01",
      ]);
      expect(() =>
        chooseCapturedPet(
          finished.flow,
          finished.zones,
          "p3",
          input.flow.petDecision!.choiceId,
          kept,
          2_002,
        ),
      ).toThrow();
      assertEncounterOwnership(finished.flow, finished.zones);
    }
    expect(input.zones.pets.p3).toEqual(["xyy.monster.gf01"]);
    for (const viewer of ["p1", "p2", "p3", "p4", "p5", "p6"]) {
      expect(
        projectEncounterResolution(input.flow, viewer).availableActions.length,
      ).toBe(viewer === "p3" ? 1 : 0);
    }
  });
  it("rejects wrong owner, expired/stale/foreign pet choices and premature timeouts without mutation", () => {
    const current = waiting();
    const before = JSON.stringify(current);
    const choiceId = current.flow.petDecision!.choiceId;
    for (const [actor, choice, pet, at] of [
      ["p1", choiceId, "xyy.monster.gf01", 2_001],
      ["p3", "stale", "xyy.monster.gf01", 2_001],
      ["p3", choiceId, "xyy.monster.gs01", 2_001],
      ["p3", choiceId, "xyy.monster.gf01", 1_999],
      ["p3", choiceId, "xyy.monster.gf01", 17_001],
    ] as const)
      expect(() =>
        chooseCapturedPet(current.flow, current.zones, actor, choice, pet, at),
      ).toThrow();
    expect(() =>
      defaultCapturedPet(current.flow, current.zones, rng, 16_999),
    ).toThrow();
    const exact = defaultCapturedPet(current.flow, current.zones, rng, 17_000);
    const late = defaultCapturedPet(
      JSON.parse(before).flow,
      JSON.parse(before).zones,
      rng,
      99_999,
    );
    expect(exact).toEqual(late);
    expect(exact.rng.cursor).toBeGreaterThan(rng.cursor);
    expect(exact.flow.updatedAt).toBe(17_000);
    expect(JSON.stringify(current)).toBe(before);
  });
  it("rejects invalid identities, clock values, duplicate zones, and captures on a loss", () => {
    const input = zones(["xyy.monster.gf01"]);
    expect(() => beginEncounterResolution("", decision, input)).toThrow();
    expect(() =>
      beginEncounterResolution("x", { ...decision, outcome: null }, input),
    ).toThrow();
    expect(() =>
      beginEncounterResolution(
        "x",
        { ...decision, openedAt: Number.NaN },
        input,
      ),
    ).toThrow();
    expect(() =>
      beginEncounterResolution("x", decision, {
        ...input,
        pets: { p1: ["xyy.monster.gf01"] },
      }),
    ).toThrow();
    expect(() =>
      beginEncounterResolution("x", decision, {
        ...zones([]),
        pets: { p1: ["xyy.monster.gf01", "xyy.monster.gf02"] },
      }),
    ).toThrow();
    const started = beginEncounterResolution("x", decision, input);
    expect(() =>
      finishMonsterBattle(started.flow, started.zones, {
        outcome: "lose",
        capture: true,
        ownerPlayerId: "p1",
      }),
    ).toThrow();
    const npc = beginEncounterResolution(
      "npc",
      decision,
      zones(["xyy.npc.nc207"]),
    );
    expect(() => openNpcDecision(npc.flow, npc.zones, [], 999)).toThrow();
    expect(() =>
      openNpcDecision(npc.flow, npc.zones, [], Number.MAX_SAFE_INTEGER),
    ).toThrow();
    expect(() =>
      openNpcDecision(
        npc.flow,
        npc.zones,
        ["xyy.npc-action.nj04", "xyy.npc-action.nj04"],
        2_000,
      ),
    ).toThrow();
    const opened = openNpcDecision(
      npc.flow,
      npc.zones,
      ["xyy.npc-action.nj04"],
      2_000,
    );
    expect(() =>
      defaultNpcAction(opened.flow, opened.zones, rng, 16_999),
    ).toThrow();
    expect(() =>
      chooseNpcAction(
        opened.flow,
        opened.zones,
        "p1",
        opened.flow.npcDecision!.choiceId,
        "xyy.npc-action.nj04",
        1_999,
      ),
    ).toThrow();
    const selected = defaultNpcAction(opened.flow, opened.zones, rng, 17_000);
    expect(() =>
      finishNpcAction(selected.flow, selected.zones, "stale-effect"),
    ).toThrow();
  });
});

describe("CS03-03 combat arithmetic and exhaustion score", () => {
  const combatant = (
    playerId: string,
    team: 1 | 2,
    strength: number,
    dexterity: number,
    seat: number,
  ) => ({
    playerId,
    team,
    strength,
    dexterity,
    seat,
    alive: true,
    hitOverride: 0 as -1 | 0 | 1,
    winOverride: 0 as -1 | 0 | 1,
  });
  it("counts active strength unconditionally, support/hinder only on hit, self-support once, and ties favor the active side", () => {
    const players = [
      combatant("p1", 1, 4, 0, 0),
      combatant("p2", 2, 3, 2, 1),
      combatant("p3", 1, 2, 3, 2),
    ];
    const input = {
      activePlayerId: "p1",
      supporterPlayerId: "p3",
      hinderPlayerId: "p2",
      monsterStrength: 6,
      monsterAgility: 3,
      players,
      attackingBonus: 0,
      defendingBonus: 0,
    };
    expect(evaluateBattle(input)).toMatchObject({
      attackingStrength: 6,
      defendingStrength: 6,
      supportHit: true,
      hinderHit: false,
      activeSideWins: true,
    });
    expect(evaluateBattle({ ...input, supporterPlayerId: "p1" })).toMatchObject(
      { attackingStrength: 4, activeSideWins: false },
    );
    expect(
      evaluateBattle({ ...input, attackingBonus: -99, defendingBonus: -99 }),
    ).toMatchObject({
      attackingStrength: 0,
      defendingStrength: 0,
      activeSideWins: true,
    });
    expect(
      evaluateBattle({
        ...input,
        players: players.map((p) =>
          p.playerId === "p2" ? { ...p, hitOverride: 1 as const } : p,
        ),
      }),
    ).toMatchObject({
      defendingStrength: 9,
      hinderHit: true,
      activeSideWins: false,
    });
    expect(
      evaluateBattle({
        ...input,
        players: players.map((p) =>
          p.playerId === "p3" ? { ...p, hitOverride: -1 as const } : p,
        ),
      }),
    ).toMatchObject({ attackingStrength: 4, supportHit: false });
  });

  it("resolves forced battle wins in stable seat order, ignores dead overrides, and rejects invalid inputs", () => {
    const players = [
      { ...combatant("p1", 1, 0, 0, 0), winOverride: 1 as const },
      { ...combatant("p2", 2, 0, 0, 1), winOverride: 1 as const },
    ];
    const input = {
      activePlayerId: "p1",
      supporterPlayerId: null,
      hinderPlayerId: null,
      monsterStrength: 99,
      monsterAgility: 99,
      players,
      attackingBonus: 0,
      defendingBonus: 0,
    };
    expect(evaluateBattle(input).activeSideWins).toBe(true);
    expect(
      evaluateBattle({ ...input, players: [...players].reverse() }),
    ).toEqual(evaluateBattle(input));
    expect(
      evaluateBattle({
        ...input,
        players: [players[0]!, { ...players[1]!, alive: false }],
        monsterStrength: 0,
      }).activeSideWins,
    ).toBe(true);
    expect(() =>
      evaluateBattle({ ...input, monsterStrength: Number.NaN }),
    ).toThrow();
  });

  it("counts successful drummers once, honors forced loss and ignores all dead forced results", () => {
    const players = [
      combatant("p1", 1, 4, 0, 0),
      combatant("p2", 2, 3, 4, 1),
      combatant("p3", 1, 2, 4, 2),
    ];
    const input = {
      activePlayerId: "p1",
      supporterPlayerId: null,
      hinderPlayerId: null,
      monsterStrength: 3,
      monsterAgility: 3,
      players,
      attackingBonus: 0,
      defendingBonus: 0,
      attackingDrummerPlayerIds: ["p3"],
      defendingDrummerPlayerIds: ["p2"],
    };
    expect(evaluateBattle(input)).toMatchObject({
      attackingStrength: 6,
      defendingStrength: 6,
      activeSideWins: true,
    });
    expect(() =>
      evaluateBattle({ ...input, supporterPlayerId: "p3" }),
    ).toThrow();
    expect(() =>
      evaluateBattle({ ...input, defendingDrummerPlayerIds: ["p3"] }),
    ).toThrow();
    expect(
      evaluateBattle({
        ...input,
        players: players.map((p) =>
          p.playerId === "p1" ? { ...p, winOverride: -1 as const } : p,
        ),
      }).activeSideWins,
    ).toBe(false);
    expect(
      evaluateBattle({
        ...input,
        players: players.map((p) =>
          p.playerId === "p2"
            ? { ...p, winOverride: 1 as const, alive: false }
            : p,
        ),
      }),
    ).toMatchObject({ defendingStrength: 3, activeSideWins: true });
  });
  it("scores living owners' current positive pet strength, not levels or hand size, with blue winning ties", () => {
    const owners = [
      {
        playerId: "p1",
        team: 1 as const,
        alive: true,
        pets: [{ cardId: "xyy.monster.gs03" as const, strength: 9 }],
      },
      {
        playerId: "p2",
        team: 2 as const,
        alive: true,
        pets: [
          { cardId: "xyy.monster.gf01" as const, strength: 9 },
          { cardId: "xyy.monster.gh01" as const, strength: -5 },
        ],
      },
      {
        playerId: "p3",
        team: 1 as const,
        alive: false,
        pets: [{ cardId: "xyy.monster.gs04" as const, strength: 100 }],
      },
    ];
    expect(evaluatePetScore(owners)).toEqual({ team1: 9, team2: 9, winner: 2 });
    expect(evaluatePetScore(owners.slice(0, 1))).toEqual({
      team1: 9,
      team2: 0,
      winner: 1,
    });
    expect(evaluatePetScore([])).toEqual({ team1: 0, team2: 0, winner: 2 });
    expect(() => evaluatePetScore([owners[0]!, owners[0]!])).toThrow();
    expect(() =>
      evaluatePetScore([
        {
          ...owners[0]!,
          pets: [{ cardId: "xyy.monster.gs03", strength: Number.NaN }],
        },
      ]),
    ).toThrow();
  });
});
