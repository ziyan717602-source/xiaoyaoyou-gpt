import { describe, expect, it } from "vitest";
import {
  applyCommand,
  createPlayerView,
  migrateMatchState,
  reduceEvent,
  type MatchState,
} from "./index.js";
import { beginMonsterDebut } from "./monster-debut.js";
import { beginBattleCards, battleScore } from "./battle-cards.js";
import type { ClientCommand } from "@xiaoyaoyou/protocol";
import type { CardInstanceId } from "./setup-content.js";
import { monsterFixture } from "./testing/monster-fixture.js";
import { npcCommand } from "./testing/npc-fixture.js";

const restore = (s: MatchState) =>
  migrateMatchState(JSON.parse(JSON.stringify(s)));

function fixture() {
  let s = monsterFixture("xyy.monster.gt03", { supporter: null, hinder: null });
  const actor = s.activePlayerId!;
  s = {
    ...s,
    players: { ...s.players, [actor]: { ...s.players[actor]!, strength: 2 } },
  };
  return beginMonsterDebut(s, "debut", 1003).state;
}

function give(s: MatchState, id: string, cards: readonly CardInstanceId[]) {
  return {
    ...s,
    drawPile: s.drawPile.filter((c) => !cards.includes(c)),
    players: { ...s.players, [id]: { ...s.players[id]!, hand: cards } },
  };
}
function act(s: MatchState, id: string, command: ClientCommand, at = 1100) {
  const input = npcCommand(s, id, command, at);
  const result = applyCommand(s, input);
  expect(applyCommand(restore(s), input)).toEqual(result);
  if (!result.accepted) throw new Error(result.reason);
  expect(result.events.reduce(reduceEvent, s)).toEqual(result.state);
  return restore(result.state);
}
function play(s: MatchState, id: string, card: CardInstanceId) {
  const a = createPlayerView(s, id).availableActions.find(
    (a) => a.type === "play-battle-card" && a.cardInstanceId === card,
  );
  if (!a || a.type !== "play-battle-card")
    throw new Error("Missing battle card");
  return act(s, id, a);
}
function passResponses(input: MatchState) {
  let s = input;
  for (let i = 0; s.reactionWindow !== null; i++) {
    if (i > 50) throw new Error("Response did not terminate");
    const w = s.reactionWindow;
    s = act(
      s,
      w.priorityOrder[w.priorityIndex]!,
      { type: "pass-reaction", windowId: w.windowId },
      1200 + i,
    );
  }
  return s;
}

describe("CS03 ordinary battle-card rounds", () => {
  it.each(["xyy.card.zp02@18", "xyy.card.zp03@20"] as const)(
    "%s pays once and changes battle-local strength only",
    (card) => {
      let s = fixture();
      const actor = s.activePlayerId!;
      s = give(s, actor, [card, "xyy.card.zp03@21"]);
      s = beginBattleCards(s, "cards", 1004).state;
      const before = s.players[actor]!;
      s = play(s, actor, card);
      expect(s.encounterState.battle!.remainingCardQuota[actor]).toBe(0);
      expect(s.pendingChoice).toBeNull();
      s = passResponses(s);
      expect(s.players[actor]!.strength).toBe(before.strength);
      expect(battleScore(s).attackingStrength).toBe(
        card.includes("zp02") ? 4 : 5,
      );
      expect(
        createPlayerView(s, actor).availableActions.some(
          (a) => a.type === "play-battle-card",
        ),
      ).toBe(false);
      expect(s.discardPile.filter((c) => c === card)).toHaveLength(1);
    },
  );
  it("ZP01 escapes without applying victory or defeat", () => {
    let s = fixture();
    const actor = s.activePlayerId!;
    s = beginBattleCards(
      give(s, actor, ["xyy.card.zp01@16"]),
      "cards",
      1004,
    ).state;
    s = passResponses(play(s, actor, "xyy.card.zp01@16"));
    expect(s.encounterState.battle!.stage).toBe("escaped");
    expect(s.encounterState.resolution!.result).toBeNull();
    expect(s.encounterState.resolution!.heldCardId).toBe("xyy.monster.gt03");
  });
  it("ZP04 allows a nonparticipant but chooses the team only after responses", () => {
    let s = fixture();
    const actor = s.activePlayerId!;
    const id = s.turnOrder.find(
      (id) => id !== actor && s.players[id]!.team === s.players[actor]!.team,
    )!;
    s = beginBattleCards(
      give(s, id, ["xyy.card.zp04@25"]),
      "cards",
      1004,
    ).state;
    s = play(s, id, "xyy.card.zp04@25");
    expect(s.pendingChoice).toBeNull();
    s = passResponses(s);
    expect(s.pendingChoice).toMatchObject({
      playerIds: [id],
      optional: false,
      optionIds: ["team:1", "team:2"],
    });
    expect(s.pendingChoice!.deadlineAt - s.pendingChoice!.openedAt).toBe(15000);
    s = act(
      s,
      id,
      {
        type: "submit-choice",
        choiceId: s.pendingChoice!.choiceId,
        selections: [`team:${s.players[actor]!.team}`],
      },
      1300,
    );
    expect(battleScore(s).attackingStrength).toBe(4);
    expect(s.pendingChoice).toBeNull();
  });
  it.each([false, true])(
    "real TP01 cancellation/counter preserves original payment: counter=%s",
    (counter) => {
      let s = fixture();
      const actor = s.activePlayerId!;
      const others = s.turnOrder.filter((id) => id !== actor);
      s = give(s, actor, ["xyy.card.zp03@20"]);
      s = give(s, others[0]!, ["xyy.card.tp01@33"]);
      s = give(s, others[1]!, ["xyy.card.tp01@34"]);
      s = beginBattleCards(s, "cards", 1004).state;
      s = play(s, actor, "xyy.card.zp03@20");
      for (const [i, id] of others.slice(0, counter ? 2 : 1).entries()) {
        while (
          s.reactionWindow!.priorityOrder[s.reactionWindow!.priorityIndex] !==
          id
        ) {
          const w = s.reactionWindow!;
          s = act(
            s,
            w.priorityOrder[w.priorityIndex]!,
            { type: "pass-reaction", windowId: w.windowId },
            1110 + i,
          );
        }
        s = act(
          s,
          id,
          {
            type: "play-reaction-card",
            cardInstanceId: i === 0 ? "xyy.card.tp01@33" : "xyy.card.tp01@34",
            targetEffectId: s.reactionWindow!.effectId,
          },
          1120 + i,
        );
      }
      s = passResponses(s);
      expect(battleScore(s).attackingStrength).toBe(counter ? 5 : 2);
      expect(s.encounterState.battle!.remainingCardQuota[actor]).toBe(0);
      expect(
        s.discardPile.filter((c) => c === "xyy.card.zp03@20"),
      ).toHaveLength(1);
    },
  );
  it("opens the losing team together, including players with empty hands, without revealing private options", () => {
    const input = fixture();
    const opened = beginBattleCards(input, "open-battle-cards", 1004);
    expect(opened.events.reduce(reduceEvent, input)).toEqual(opened.state);
    const s = restore(opened.state);
    const actorTeam = s.players[s.activePlayerId!]!.team;
    expect(s.encounterState.battle!.cardWindow).toMatchObject({
      sideTeam: actorTeam,
      openedAt: 1004,
      deadlineAt: 16004,
    });
    for (const id of s.turnOrder) {
      const actions = createPlayerView(s, id).availableActions;
      expect(actions.some((a) => a.type === "pass-battle")).toBe(
        s.players[id]!.team === actorTeam,
      );
      expect(actions.some((a) => a.type === "play-battle-card")).toBe(false);
    }
    expect(s.encounterState.battle!.remainingCardQuota).toEqual(
      Object.fromEntries(s.turnOrder.map((id) => [id, 1])),
    );
  });

  it("two whole-team passes finish card rounds without applying monster victory/defeat or consuming the held monster", () => {
    const input = fixture();
    let s = beginBattleCards(input, "open-battle-cards", 1004).state;
    const firstTeam = s.players[s.activePlayerId!]!.team;
    let passes = 0;
    for (let side = 0; side < 2; side++) {
      const team = side === 0 ? firstTeam : firstTeam === 1 ? 2 : 1;
      for (const id of s.turnOrder.filter(
        (id) => s.players[id]!.team === team,
      )) {
        const action = createPlayerView(s, id).availableActions.find(
          (a) => a.type === "pass-battle",
        );
        expect(action).toBeDefined();
        if (!action || action.type !== "pass-battle")
          throw new Error("Missing side pass");
        const command = npcCommand(s, id, action, 1005 + passes++);
        const result = applyCommand(s, command);
        expect(applyCommand(restore(s), command)).toEqual(result);
        if (!result.accepted) throw new Error(result.reason);
        expect(result.events.reduce(reduceEvent, s)).toEqual(result.state);
        s = restore(result.state);
      }
    }
    expect(passes).toBe(6);
    expect(s.encounterState.battle).toMatchObject({
      stage: "outcome-ready",
      cardWindow: null,
    });
    expect(s.encounterState.resolution!.heldCardId).toBe("xyy.monster.gt03");
    expect(s.encounterState.resolution!.result).toBeNull();
    expect(s.players).toEqual(input.players);
    expect(s.encounterDiscard).toEqual(input.encounterDiscard);
    expect(s.rng).toEqual(input.rng);
  });
});
