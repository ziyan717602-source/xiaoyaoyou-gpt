import type { PlayerId } from "@xiaoyaoyou/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEncounterHinderChoice,
  applyEncounterSupportChoice,
  applyEncounterTimeout,
  createEncounterDecision,
  createInitialMatch,
  opposingDecisionPlayerId,
  projectEncounterDecision,
  revealEncounterCard,
  type EncounterParticipant,
  type MatchState,
} from "./index.js";

const ids = Array.from(
  { length: 6 },
  (_, index) => `encounter-flow-player-${index + 1}` as PlayerId,
);

function playing(): MatchState {
  const initial = createInitialMatch({
    matchId: "encounter-flow-match",
    rulesetVersion: "standard-fengmingyushi@1",
    seed: "encounter-flow-seed",
    openedAt: 1_000,
    players: ids.map((id, index) => ({ id, nickname: `玩家 ${index + 1}` })),
  });
  return {
    ...initial,
    phase: "playing",
    activePlayerId: ids[0]!,
    turnOrder: ids,
    turn: {
      number: 1,
      phase: "encounter",
      openedAt: 1_000,
      deadlineAt: 16_000,
    },
    players: Object.fromEntries(
      ids.map((id, turnIndex) => [
        id,
        {
          ...initial.players[id]!,
          turnIndex,
          team: turnIndex % 2 === 0 ? 1 : 2,
          heroId: "xyy.hero.xj101",
          alive: true,
          hp: 4,
          maxHp: 4,
        },
      ]),
    ),
  };
}

function player(id: PlayerId): EncounterParticipant {
  return { kind: "player", playerId: id };
}

describe("CS03-02 serialized encounter decisions", () => {
  it("gives only the active player the support-or-give-up decision", () => {
    const state = playing();
    const decision = createEncounterDecision(state, 2_000);

    expect(decision).toMatchObject({
      stage: "awaiting-support",
      activePlayerId: ids[0],
      decisionOwnerPlayerId: ids[0],
      openedAt: 2_000,
      deadlineAt: 17_000,
    });
    expect(decision.supportOptions).toEqual([
      player(ids[0]!),
      player(ids[2]!),
      player(ids[4]!),
    ]);
    expect(projectEncounterDecision(decision, ids[0]!)).toMatchObject({
      availableActions: [
        {
          type: "choose-encounter-support",
          options: decision.supportOptions,
          canGiveUp: true,
        },
      ],
    });
    expect(
      projectEncounterDecision(decision, ids[2]!).availableActions,
    ).toEqual([]);
  });

  it("uses the corresponding live opponent as sole hinder decider and falls forward", () => {
    let state = playing();
    expect(opposingDecisionPlayerId(state, ids[0]!)).toBe(ids[1]);
    expect(opposingDecisionPlayerId(state, ids[2]!)).toBe(ids[3]);

    state = {
      ...state,
      players: {
        ...state.players,
        [ids[3]!]: { ...state.players[ids[3]!]!, alive: false, hp: 0 },
      },
    };
    expect(opposingDecisionPlayerId(state, ids[2]!)).toBe(ids[5]);
    expect(opposingDecisionPlayerId(state, ids[4]!)).toBe(ids[5]);

    const support = applyEncounterSupportChoice(
      createEncounterDecision(state, 2_000),
      { kind: "choose", participant: player(ids[2]!) },
      state,
      3_000,
    );
    expect(support).toMatchObject({
      stage: "awaiting-hinder",
      supporter: player(ids[2]!),
      decisionOwnerPlayerId: ids[1],
      openedAt: 3_000,
      deadlineAt: 18_000,
    });
    expect(support.hinderOptions).toEqual([player(ids[1]!), player(ids[5]!)]);
  });

  it("serializes pet/special options without granting them decision authority", () => {
    const state = playing();
    const extra: readonly EncounterParticipant[] = [
      {
        kind: "pet",
        ownerPlayerId: ids[2]!,
        cardId: "xyy.monster.gl01",
      },
      {
        kind: "special",
        ownerPlayerId: ids[4]!,
        contentId: "xyy.special.test-battle-ref",
      },
    ];
    const decision = createEncounterDecision(state, 2_000, {
      extraSupportOptions: extra,
    });
    const chosen = applyEncounterSupportChoice(
      decision,
      { kind: "choose", participant: extra[0]! },
      state,
      3_000,
    );
    expect(chosen.supporter).toEqual(extra[0]);
    expect(chosen.decisionOwnerPlayerId).toBe(ids[1]);
    expect(JSON.parse(JSON.stringify(chosen))).toEqual(chosen);
  });

  it("defaults support to give-up and hinder to pass after 15 seconds", () => {
    const state = playing();
    const support = createEncounterDecision(state, 2_000);
    const gaveUp = applyEncounterTimeout(support, state, support.deadlineAt);
    expect(gaveUp).toMatchObject({
      stage: "ready-reveal",
      outcome: "give-up",
      decisionOwnerPlayerId: null,
    });

    const fighting = applyEncounterSupportChoice(
      support,
      { kind: "choose", participant: player(ids[0]!) },
      state,
      3_000,
    );
    const noHinder = applyEncounterTimeout(
      fighting,
      state,
      fighting.deadlineAt,
    );
    expect(noHinder).toMatchObject({
      stage: "ready-reveal",
      outcome: "fight",
      hinder: null,
      decisionOwnerPlayerId: null,
    });
  });

  it("reveals and discards on give-up but holds a fighting card in the flow", () => {
    const state = playing();
    const firstCard = state.encounterDeck[0]!;
    const support = createEncounterDecision(state, 2_000);
    const gaveUp = applyEncounterSupportChoice(
      support,
      { kind: "give-up" },
      state,
      3_000,
    );
    const discarded = revealEncounterCard(gaveUp, {
      encounterDeck: state.encounterDeck,
      encounterDiscard: state.encounterDiscard,
    });
    expect(discarded.decision).toMatchObject({
      stage: "completed",
      outcome: "give-up",
      revealedCardId: firstCard,
    });
    expect(discarded.encounterDeck).toEqual(state.encounterDeck.slice(1));
    expect(discarded.encounterDiscard).toEqual([firstCard]);

    const fighting = applyEncounterHinderChoice(
      applyEncounterSupportChoice(
        support,
        { kind: "choose", participant: player(ids[0]!) },
        state,
        3_000,
      ),
      { kind: "pass" },
      4_000,
    );
    const revealed = revealEncounterCard(fighting, {
      encounterDeck: state.encounterDeck,
      encounterDiscard: state.encounterDiscard,
    });
    expect(revealed.decision).toMatchObject({
      stage: "revealed",
      outcome: "fight",
      revealedCardId: firstCard,
    });
    expect(revealed.encounterDiscard).toEqual([]);
    expect(
      revealed.encounterDeck.length +
        revealed.encounterDiscard.length +
        (revealed.decision.revealedCardId === null ? 0 : 1),
    ).toBe(state.encounterDeck.length);
  });

  it("rejects stale, dead, foreign-team, and repeated decisions", () => {
    const state = playing();
    const decision = createEncounterDecision(state, 2_000);
    expect(() =>
      applyEncounterSupportChoice(
        decision,
        { kind: "choose", participant: player(ids[1]!) },
        state,
        3_000,
      ),
    ).toThrow("not a legal support option");
    expect(() =>
      applyEncounterTimeout(decision, state, decision.deadlineAt - 1),
    ).toThrow("before its deadline");

    const hinder = applyEncounterSupportChoice(
      decision,
      { kind: "choose", participant: player(ids[0]!) },
      state,
      3_000,
    );
    const resolved = applyEncounterHinderChoice(
      hinder,
      { kind: "pass" },
      4_000,
    );
    expect(() =>
      applyEncounterHinderChoice(resolved, { kind: "pass" }, 5_000),
    ).toThrow("not awaiting hinder");
  });
});
