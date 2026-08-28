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
  type CardInstanceId,
} from "./index.js";
import { beginBattleCards, battleScore } from "./battle-cards.js";
import { beginMonsterDebut } from "./monster-debut.js";
import { monsterFixture } from "./testing/monster-fixture.js";
import type { MonsterId } from "./encounter-content.js";
import { grantPets, npcCommand } from "./testing/npc-fixture.js";
import { heroAvailability } from "./hero-roster.js";

const restore = (s: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(s)));
function fixture() {
  const s = monsterFixture("xyy.monster.gt03", {
    supporter: null,
    hinder: null,
  });
  const actor = s.activePlayerId!;
  return beginMonsterDebut(
    {
      ...s,
      players: { ...s.players, [actor]: { ...s.players[actor]!, strength: 2 } },
    },
    "debut",
    1003,
  ).state;
}
function give(
  s: MatchState,
  id: string,
  cards: readonly CardInstanceId[],
): MatchState {
  return {
    ...s,
    drawPile: s.drawPile.filter((c) => !cards.includes(c)),
    players: { ...s.players, [id]: { ...s.players[id]!, hand: cards } },
  };
}
function step(s: MatchState, cmd: EngineCommand) {
  const result = applyCommand(s, cmd);
  expect(applyCommand(restore(s), cmd)).toEqual(result);
  if (!result.accepted) throw new Error(result.reason);
  expect(result.events.reduce(reduceEvent, s)).toEqual(result.state);
  expect(result.state.version).toBe(s.version + 1);
  const next = restore(result.state);
  identities(next);
  return next;
}
function act(s: MatchState, id: string, cmd: ClientCommand, at: number) {
  return step(s, npcCommand(s, id, cmd, at));
}
function timeout(s: MatchState, owner?: string) {
  const d = collectSystemDeadlines(s).find(
    (d) => d.origin === "system-timeout" && (!owner || d.playerId === owner),
  )!;
  if (!d) throw new Error("No actionable timeout");
  const cmd: EngineCommand = {
    origin: "system-timeout",
    commandId: d.id,
    matchId: s.matchId,
    expectedVersion: s.version,
    targetId: d.targetId,
    deadlineAt: d.deadlineAt,
  };
  return { next: step(s, cmd), cmd };
}
function play(s: MatchState, id: string, card: CardInstanceId) {
  const w = s.encounterState.battle!.cardWindow!;
  return act(
    s,
    id,
    { type: "play-battle-card", cardInstanceId: card, windowId: w.windowId },
    w.openedAt + 1,
  );
}
function passResponses(s: MatchState): MatchState {
  for (let i = 0; s.reactionWindow; i++) {
    if (i > 50) throw new Error("Response stalled");
    s = timeout(s).next;
  }
  return s;
}
function identities(s: MatchState) {
  const cards = [
    ...s.drawPile,
    ...s.discardPile,
    ...Object.values(s.players).flatMap((p) => [
      ...p.hand,
      ...Object.values(p.equipment).filter((x) => x !== null),
    ]),
  ];
  const encounters = [
    ...s.encounterDeck,
    ...s.encounterDiscard,
    ...s.reserveNpcDeck,
    ...s.reserveNpcDiscard,
    ...Object.values(s.encounterState.pets).flat(),
    ...Object.values(s.encounterState.companions).flat(),
    s.encounterState.resolution!.heldCardId!,
  ];
  for (const [items, count] of [
    [cards, 56],
    [encounters, 46],
    [Object.values(heroAvailability(s)).flat(), 34],
  ] as const) {
    expect(items).toHaveLength(count);
    expect(new Set(items).size).toBe(count);
  }
  for (const id of s.turnOrder)
    for (const other of s.turnOrder.filter((x) => x !== id))
      for (const card of s.players[other]!.hand)
        expect(JSON.stringify(createPlayerView(s, id))).not.toContain(card);
}

describe("battle card persistence and adversarial commands", () => {
  it("recomputes the losing side after a real score-changing action, clearing all prior passes", () => {
    let s = fixture();
    const actor = s.activePlayerId!,
      team = s.players[actor]!.team;
    s = {
      ...s,
      players: { ...s.players, [actor]: { ...s.players[actor]!, strength: 5 } },
    };
    s = beginBattleCards(
      give(s, actor, ["xyy.card.zp03@20"]),
      "cards",
      1004,
    ).state;
    const other = s.encounterState.battle!.cardWindow!.playerIds.find(
      (id) => id !== actor,
    )!;
    const old = s.encounterState.battle!.cardWindow!;
    s = act(s, other, { type: "pass-battle", windowId: old.windowId }, 1005);
    s = passResponses(play(s, actor, "xyy.card.zp03@20"));
    expect(battleScore(s).activeSideWins).toBe(true);
    expect(s.encounterState.battle!.cardWindow!.sideTeam).not.toBe(team);
    expect(s.encounterState.battle!.cardWindow!.passedPlayerIds).toEqual([]);
    expect(s.encounterState.battle!.cardWindow!.windowId).not.toBe(
      old.windowId,
    );
  });
  it("team pass deadlines are shared, never extended by a teammate's action or disconnect; duplicates and competing old versions reject", () => {
    let s = beginBattleCards(fixture(), "cards", 1004).state;
    const w = s.encounterState.battle!.cardWindow!,
      first = w.playerIds[0]!,
      second = w.playerIds[1]!;
    const competing = npcCommand(
      s,
      second,
      { type: "pass-battle", windowId: w.windowId },
      1006,
    );
    s = act(s, first, { type: "pass-battle", windowId: w.windowId }, 1005);
    expect(applyCommand(s, competing)).toMatchObject({
      accepted: false,
      reason: "stale-version",
    });
    expect(s.encounterState.battle!.cardWindow!.deadlineAt).toBe(16004);
    s = step(s, {
      origin: "system-presence",
      commandId: "offline",
      matchId: s.matchId,
      expectedVersion: s.version,
      playerId: second,
      status: "disconnected",
      occurredAt: 1010,
    });
    expect(
      collectSystemDeadlines(s).find((d) => d.origin === "system-auto")!
        .deadlineAt,
    ).toBe(61010);
    expect(
      collectSystemDeadlines(s)
        .filter((d) => d.origin === "system-timeout")
        .map((d) => d.deadlineAt),
    ).toEqual([16004, 16004]);
    const timed = timeout(s, second);
    s = timed.next;
    expect(
      applyCommand(s, { ...timed.cmd, expectedVersion: s.version }),
    ).toMatchObject({ accepted: false });
    expect(s.encounterState.battle!.cardWindow!.deadlineAt).toBe(16004);
    expect(
      applyCommand(
        s,
        npcCommand(
          s,
          first,
          { type: "pass-battle", windowId: w.windowId },
          16005,
        ),
      ),
    ).toMatchObject({ accepted: false });
  });
  it("already-auto players pass instantly but other teammates keep their original deadline", () => {
    let s = fixture();
    const actor = s.activePlayerId!;
    s = {
      ...s,
      connections: {
        ...s.connections,
        [actor]: { status: "auto", disconnectedAt: 0, autoAt: 60000 },
      },
    };
    s = beginBattleCards(s, "cards", 60001).state;
    expect(
      collectSystemDeadlines(s).find((d) => d.playerId === actor)!.deadlineAt,
    ).toBe(60001);
    s = timeout(s, actor).next;
    expect(s.encounterState.battle!.cardWindow!.deadlineAt).toBe(75001);
  });
  it("ZP04 mandatory timeout is seeded and recorded exactly once, with no team selection before the counter window closes", () => {
    let s = fixture();
    const actor = s.activePlayerId!;
    s = beginBattleCards(
      give(s, actor, ["xyy.card.zp04@25"]),
      "cards",
      1004,
    ).state;
    s = play(s, actor, "xyy.card.zp04@25");
    expect(s.pendingChoice).toBeNull();
    s = passResponses(s);
    const old = s;
    const timed = timeout(s);
    s = timed.next;
    expect(s.rng.cursor).toBe(old.rng.cursor + 1);
    expect(s.encounterState.battle!.cards!.plays[0]!.chosenTeam).not.toBeNull();
    expect(
      applyCommand(s, { ...timed.cmd, expectedVersion: s.version }),
    ).toMatchObject({ accepted: false });
    expect(s.pendingChoice).toBeNull();
  });
  it("cancelled ZP04 never opens a mandatory choice or consumes RNG", () => {
    let s = fixture();
    const actor = s.activePlayerId!;
    s = give(s, actor, ["xyy.card.zp04@25"]);
    const other = s.turnOrder.find((id) => id !== actor)!;
    s = give(s, other, ["xyy.card.tp01@33"]);
    s = beginBattleCards(s, "cards", 1004).state;
    const rng = s.rng;
    s = play(s, actor, "xyy.card.zp04@25");
    while (
      s.reactionWindow!.priorityOrder[s.reactionWindow!.priorityIndex] !== other
    )
      s = timeout(s).next;
    s = act(
      s,
      other,
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: s.reactionWindow!.effectId,
      },
      s.reactionWindow!.openedAt + 1,
    );
    s = passResponses(s);
    expect(s.pendingChoice).toBeNull();
    expect(s.rng).toEqual(rng);
    expect(s.encounterState.battle!.cards!.plays[0]!.result).toBe("cancelled");
  });
  it("real support must hit for buffs, missed support can escape, and nonparticipants only have ZP04", () => {
    let s = fixture();
    const actor = s.activePlayerId!;
    const helper = s.turnOrder.find(
      (id) => id !== actor && s.players[id]!.team === s.players[actor]!.team,
    )!;
    s = {
      ...s,
      players: {
        ...s.players,
        [helper]: { ...s.players[helper]!, dexterity: 0 },
      },
      encounterState: {
        ...s.encounterState,
        resolution: {
          ...s.encounterState.resolution!,
          supporter: { kind: "player", playerId: helper },
        },
      },
    };
    s = give(s, helper, [
      "xyy.card.zp01@16",
      "xyy.card.zp02@18",
      "xyy.card.zp03@20",
      "xyy.card.zp04@25",
    ]);
    s = beginBattleCards(s, "cards", 1004).state;
    expect(
      createPlayerView(s, helper)
        .availableActions.filter((a) => a.type === "play-battle-card")
        .map((a) => a.cardInstanceId),
    ).toEqual(["xyy.card.zp01@16", "xyy.card.zp04@25"]);
    const attack = npcCommand(
      s,
      helper,
      {
        type: "play-battle-card",
        cardInstanceId: "xyy.card.zp03@20",
        windowId: s.encounterState.battle!.cardWindow!.windowId,
      },
      1005,
    );
    expect(applyCommand(s, attack)).toMatchObject({ accepted: false });
  });
  it("GL02 post-debut STRa is the ZP02 baseline, without changing permanent strength", () => {
    let s = monsterFixture("xyy.monster.gl02", { hinder: null });
    const actor = s.activePlayerId!;
    const helper = s.turnOrder.find(
      (id) => id !== actor && s.players[id]!.team === s.players[actor]!.team,
    )!;
    s = {
      ...s,
      players: {
        ...s.players,
        [helper]: { ...s.players[helper]!, strength: 1, dexterity: 99 },
        [actor]: { ...s.players[actor]!, strength: 0 },
      },
      encounterState: {
        ...s.encounterState,
        resolution: {
          ...s.encounterState.resolution!,
          supporter: { kind: "player", playerId: helper },
        },
      },
    };
    s = beginMonsterDebut(
      give(s, helper, ["xyy.card.zp02@18"]),
      "debut",
      1003,
    ).state;
    s = beginBattleCards(s, "cards", 1004).state;
    while (
      s.encounterState.battle!.cardWindow!.sideTeam !== s.players[helper]!.team
    )
      s = timeout(s).next;
    expect(s.encounterState.battle!.cards!.baselineStrength[helper]).toBe(3);
    s = passResponses(play(s, helper, "xyy.card.zp02@18"));
    expect(battleScore(s).attackingStrength).toBe(6);
    expect(s.players[helper]!.strength).toBe(1);
  });
  it.each([
    ["xyy.monster.gt01", false, 2],
    ["xyy.monster.gs04", true, 9],
  ] as const)(
    "pet %s uses exact hit/stat contribution rather than the owner's strength",
    (pet: MonsterId, hit, expected) => {
      let s = fixture();
      const actor = s.activePlayerId!;
      const helper = s.turnOrder.find(
        (id) => id !== actor && s.players[id]!.team === s.players[actor]!.team,
      )!;
      s = grantPets(s, helper, [pet]);
      s = {
        ...s,
        players: {
          ...s.players,
          [helper]: { ...s.players[helper]!, strength: 99, dexterity: 99 },
        },
        encounterState: {
          ...s.encounterState,
          resolution: {
            ...s.encounterState.resolution!,
            supporter: { kind: "pet", ownerPlayerId: helper, cardId: pet },
          },
        },
      };
      s = beginBattleCards(
        give(s, helper, ["xyy.card.zp01@16"]),
        "cards",
        1004,
      ).state;
      expect(battleScore(s).attackingStrength).toBe(expected);
      expect(battleScore(s).supportHit).toBe(hit);
      expect(
        createPlayerView(s, helper).availableActions.some(
          (a) => a.type === "play-battle-card",
        ),
      ).toBe(false);
    },
  );
  it("same-sized different private hands produce identical five other views and all public deadlines", () => {
    const base = fixture(),
      actor = base.activePlayerId!;
    const left = beginBattleCards(
      give(base, actor, ["xyy.card.zp04@25"]),
      "cards",
      1004,
    ).state;
    const right = beginBattleCards(
      give(base, actor, ["xyy.card.jp04@7"]),
      "cards",
      1004,
    ).state;
    for (const id of base.turnOrder.filter((id) => id !== actor))
      expect(createPlayerView(left, id)).toEqual(createPlayerView(right, id));
    expect(collectSystemDeadlines(left)).toEqual(collectSystemDeadlines(right));
  });
  it("v12 debut snapshots and their historical debut events migrate without losing effects or changing time", () => {
    const input = monsterFixture("xyy.monster.gt03", {
      supporter: null,
      hinder: null,
    });
    const result = beginMonsterDebut(input, "debut", 1003);
    const old = JSON.parse(JSON.stringify(result.state));
    old.schemaVersion = 12;
    delete old.encounterState.battle.cards;
    delete old.encounterState.battle.cardWindow;
    delete old.encounterState.battle.remainingCardQuota;
    expect(migrateMatchState(old)).toEqual(result.state);
    const event = JSON.parse(JSON.stringify(result.events[0]));
    delete event.payload.report.battle.cards;
    delete event.payload.report.battle.cardWindow;
    delete event.payload.report.battle.remainingCardQuota;
    expect(reduceEvent(restore(input), event)).toEqual(result.state);
  });
  it.each([
    "deadline",
    "quota",
    "missing-wait",
    "foreign-root",
    "duplicate-priority",
    "foreign-choice",
  ])("rejects corrupt %s on JSON restore", (kind) => {
    let s = fixture();
    const actor = s.activePlayerId!;
    s = beginBattleCards(
      give(s, actor, ["xyy.card.zp04@25"]),
      "cards",
      1004,
    ).state;
    if (["foreign-root", "duplicate-priority", "foreign-choice"].includes(kind))
      s = play(s, actor, "xyy.card.zp04@25");
    if (kind === "foreign-choice") s = passResponses(s);
    const bad = JSON.parse(JSON.stringify(s));
    if (kind === "deadline") bad.encounterState.battle.cardWindow.deadlineAt++;
    if (kind === "quota")
      bad.encounterState.battle.remainingCardQuota[actor] = 0;
    if (kind === "missing-wait") bad.encounterState.battle.cardWindow = null;
    if (kind === "foreign-root") bad.effectStack[0].sourcePlayerId = "intruder";
    if (kind === "duplicate-priority")
      bad.reactionWindow.priorityOrder[1] = bad.reactionWindow.priorityOrder[0];
    if (kind === "foreign-choice")
      bad.pendingChoice.playerIds = [s.turnOrder.find((id) => id !== actor)!];
    expect(() => migrateMatchState(bad)).toThrow();
  });
  it("rejects forged reports and duplicate start events", () => {
    const input = fixture();
    const result = beginBattleCards(input, "cards", 1004);
    const forged = JSON.parse(JSON.stringify(result.events[0]));
    forged.payload.report.battle.remainingCardQuota[input.activePlayerId!] = 9;
    expect(() => reduceEvent(input, forged)).toThrow();
    expect(() => reduceEvent(result.state, result.events[0]!)).toThrow();
  });
  it("migrates a v12 live monster-damage response without replacing the wait or losing its continuation", () => {
    const input = monsterFixture("xyy.monster.gh04");
    const s = beginMonsterDebut(input, "debut", 1003).state;
    expect(s.reactionWindow).not.toBeNull();
    const old = JSON.parse(JSON.stringify(s));
    old.schemaVersion = 12;
    delete old.encounterState.battle.cards;
    delete old.encounterState.battle.cardWindow;
    delete old.encounterState.battle.remainingCardQuota;
    const migrated = migrateMatchState(old);
    expect(migrated).toEqual(s);
    expect(timeout(migrated).next).toEqual(timeout(s).next);
  });
  it.each([
    "missing-parent",
    "wrong-parent",
    "wrong-target",
    "duplicate-frame",
    "wrong-status",
  ])(
    "rejects a counter cursor with %s before it can stall restoration",
    (corruption) => {
      let s = fixture();
      const actor = s.activePlayerId!,
        other = s.turnOrder.find((id) => id !== actor)!;
      s = give(give(s, actor, ["xyy.card.zp04@25"]), other, [
        "xyy.card.tp01@33",
      ]);
      s = play(
        beginBattleCards(s, "cards", 1004).state,
        actor,
        "xyy.card.zp04@25",
      );
      while (
        s.reactionWindow!.priorityOrder[s.reactionWindow!.priorityIndex] !==
        other
      )
        s = timeout(s).next;
      s = act(
        s,
        other,
        {
          type: "play-reaction-card",
          cardInstanceId: "xyy.card.tp01@33",
          targetEffectId: s.reactionWindow!.effectId,
        },
        s.reactionWindow!.openedAt + 1,
      );
      const bad = JSON.parse(JSON.stringify(s));
      if (corruption === "missing-parent")
        delete bad.reactionWindow.continuation.locals.parentWindow;
      if (corruption === "wrong-parent")
        bad.reactionWindow.continuation.locals.parentWindow.effectId =
          "foreign";
      if (corruption === "wrong-target")
        bad.effectStack[1].targetIds = ["foreign"];
      if (corruption === "duplicate-frame")
        bad.effectStack.push(bad.effectStack[1]);
      if (corruption === "wrong-status") bad.effectStack[0].status = "resolved";
      expect(() => migrateMatchState(bad)).toThrow();
    },
  );
  it("shrinks deterministic six-player battle-card/counter/timeout sequences and checks every replay boundary", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat(30), { minLength: 1, maxLength: 80 }),
        (choices) => {
          let s = fixture();
          const hands: CardInstanceId[][] = [
            ["xyy.card.zp02@18", "xyy.card.tp01@33"],
            ["xyy.card.zp04@25", "xyy.card.tp01@34"],
            ["xyy.card.zp03@20", "xyy.card.tp01@35"],
            ["xyy.card.zp04@26"],
            ["xyy.card.zp01@16"],
            ["xyy.card.zp04@27"],
          ];
          for (const [i, id] of s.turnOrder.entries())
            s = give(s, id, hands[i]!);
          s = beginBattleCards(s, "cards", 1004).state;
          for (
            let i = 0;
            !["outcome-ready", "escaped"].includes(
              s.encounterState.battle!.stage,
            );
            i++
          ) {
            if (i > 220) throw new Error("Battle failed to terminate");
            const roll = choices[i % choices.length]!;
            if (roll % 3 === 0) {
              s = timeout(s).next;
              continue;
            }
            const options = s.turnOrder.flatMap((id) =>
              createPlayerView(s, id).availableActions.map((action) => ({
                id,
                action,
              })),
            );
            expect(options.length).toBeGreaterThan(0);
            const { id, action } = options[roll % options.length]!;
            const at =
              (s.pendingChoice?.openedAt ??
                s.reactionWindow?.openedAt ??
                s.encounterState.battle!.cardWindow!.openedAt) + 1;
            let command: ClientCommand;
            if (action.type === "submit-choice")
              command = {
                type: "submit-choice",
                choiceId: action.choiceId,
                selections: [action.optionIds[roll % action.optionIds.length]!],
              };
            else if (
              [
                "pass-battle",
                "play-battle-card",
                "pass-reaction",
                "play-reaction-card",
              ].includes(action.type)
            )
              command = action as ClientCommand;
            else throw new Error(`Unexpected fixture action ${action.type}`);
            s = act(s, id, command, at);
          }
          identities(s);
        },
      ),
      { seed: 30302, numRuns: 70 },
    );
  });
});
