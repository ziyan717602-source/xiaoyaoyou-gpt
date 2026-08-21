import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CommandEnvelope } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  createPlayerView,
  createSetupMatch,
  HERO_SKILL_IDS,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  SETUP_MONSTER_IDS,
  SETUP_NPC_IDS,
  skillIdsForHero,
  type MatchState,
} from "./index.js";

const players = Array.from({ length: 6 }, (_, index) => ({
  id: `p${index + 1}`,
  nickname: `玩家 ${index + 1}`,
}));

function setup(seed = "m02-fixed-seed"): MatchState {
  return createSetupMatch({
    matchId: "m02-match",
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    players,
  });
}

function envelope(
  state: MatchState,
  playerId: string,
  commandId: string,
  command: CommandEnvelope["command"],
): CommandEnvelope {
  return {
    protocolVersion: 1,
    commandId,
    matchId: state.matchId,
    playerId,
    clientSequence: state.version,
    expectedVersion: state.version,
    clientIssuedAt: 1,
    command,
  };
}

function accepted(
  state: MatchState,
  playerId: string,
  commandId: string,
  command: CommandEnvelope["command"],
): MatchState {
  const result = applyCommand(state, {
    origin: "player",
    serverReceivedAt: 0,
    envelope: envelope(state, playerId, commandId, command),
  });
  expect(result.accepted).toBe(true);
  if (!result.accepted) throw new Error(result.reason);
  let replayed = state;
  for (const event of result.events) replayed = reduceEvent(replayed, event);
  expect(replayed).toEqual(result.state);
  return result.state;
}

describe("M02 deterministic setup", () => {
  it("allocates stable seats into seeded 3v3 turn order and private offers", () => {
    const first = setup();
    const repeated = setup();
    expect(repeated).toEqual(first);
    expect(first.phase).toBe("setup");
    expect(first.turnOrder).toHaveLength(6);
    expect(new Set(first.turnOrder).size).toBe(6);
    expect(
      Object.values(first.players).filter((player) => player.team === 1),
    ).toHaveLength(3);
    expect(
      Object.values(first.players).filter((player) => player.team === 2),
    ).toHaveLength(3);
    expect(
      Object.values(first.players)
        .map((player) => player.seat)
        .sort(),
    ).toEqual([0, 1, 2, 3, 4, 5]);

    const allocated = Object.values(first.setup!.offers).flatMap((offer) => [
      ...offer.candidateHeroIds,
      offer.replacementHeroId,
    ]);
    expect(allocated).toHaveLength(24);
    expect(new Set(allocated).size).toBe(24);
    for (const viewer of players) {
      const view = createPlayerView(first, viewer.id);
      expect(view.setup?.ownOffer?.candidateHeroIds).toHaveLength(3);
      expect(view.availableActions).toEqual([
        {
          type: "choose-hero",
          heroIds: first.setup!.offers[viewer.id]!.candidateHeroIds,
        },
        { type: "reroll-hero" },
      ]);
      expect(JSON.stringify(view)).not.toContain(
        first.setup!.offers[
          players.find((player) => player.id !== viewer.id)!.id
        ]!.replacementHeroId,
      );
    }
    expect(setup("another-seed")).not.toEqual(first);
  });

  it("rerolls once, selects six heroes, deals three cards each, and starts", () => {
    let state = setup();
    const firstPlayerId = state.turnOrder[0]!;
    const original = state.setup!.offers[firstPlayerId]!;
    state = accepted(state, firstPlayerId, "reroll-1", {
      type: "reroll-hero",
    });
    const rerolled = state.setup!.offers[firstPlayerId]!;
    expect(rerolled.rerolled).toBe(true);
    expect(rerolled.candidateHeroIds[original.replacementIndex]).toBe(
      original.replacementHeroId,
    );
    const repeatedReroll = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: envelope(state, firstPlayerId, "reroll-2", {
        type: "reroll-hero",
      }),
    });
    expect(repeatedReroll).toMatchObject({
      accepted: false,
      reason: "not-available",
    });

    for (const playerId of state.turnOrder) {
      const heroId = state.setup!.offers[playerId]!.candidateHeroIds[0]!;
      state = accepted(state, playerId, `choose-${playerId}`, {
        type: "choose-hero",
        heroId,
      });
    }
    expect(state.phase).toBe("playing");
    expect(state.activePlayerId).toBe(firstPlayerId);
    expect(state.setup?.status).toBe("completed");
    expect(state.drawPile).toHaveLength(38);
    const hands = Object.values(state.players).flatMap((player) => player.hand);
    expect(
      Object.values(state.players).every((player) => player.hand.length === 3),
    ).toBe(true);
    expect(
      Object.values(state.players).every(
        (player) => player.hp === player.maxHp,
      ),
    ).toBe(true);
    expect(new Set([...hands, ...state.drawPile]).size).toBe(56);
    expect(new Set([...hands, ...state.drawPile])).toEqual(
      new Set(SETUP_CARD_INSTANCES),
    );

    const viewer = createPlayerView(state, firstPlayerId);
    expect(
      viewer.players.find((player) => player.id === firstPlayerId)?.hand,
    ).toHaveLength(3);
    expect(
      viewer.players
        .filter((player) => player.id !== firstPlayerId)
        .every((player) => player.hand === null),
    ).toBe(true);
    expect(viewer.players.every((player) => player.heroId !== null)).toBe(true);
  });

  it("loads the complete hero-skill graph and applies 剑匣 hand limit", () => {
    expect(Object.keys(HERO_SKILL_IDS)).toHaveLength(34);
    expect(
      Object.values(HERO_SKILL_IDS).reduce(
        (count, skillIds) => count + skillIds.length,
        0,
      ),
    ).toBe(77);
    expect(skillIdsForHero("xyy.hero.xj404")).toEqual([
      "xyy.skill.jn50401",
      "xyy.skill.jn50402",
    ]);

    let state = setup("jn50402-7");
    const ownerId = state.turnOrder[0]!;
    expect(state.setup!.offers[ownerId]!.candidateHeroIds).toContain(
      "xyy.hero.xj404",
    );
    for (const playerId of state.turnOrder) {
      const heroId =
        playerId === ownerId
          ? "xyy.hero.xj404"
          : state.setup!.offers[playerId]!.candidateHeroIds[0]!;
      state = accepted(state, playerId, `jn50402-choose-${playerId}`, {
        type: "choose-hero",
        heroId,
      });
    }

    expect(state.players[ownerId]).toMatchObject({
      heroId: "xyy.hero.xj404",
      handLimit: 5,
    });
    expect(
      Object.values(state.players)
        .filter((player) => player.id !== ownerId)
        .every((player) => player.handLimit === 3),
    ).toBe(true);
    for (const viewer of players) {
      expect(
        createPlayerView(state, viewer.id).players.find(
          (player) => player.id === ownerId,
        )?.handLimit,
      ).toBe(5);
    }
  });

  it("rejects stale, foreign, and out-of-offer setup commands", () => {
    const state = setup();
    const playerId = state.turnOrder[0]!;
    const stale = envelope(state, playerId, "stale", {
      type: "choose-hero",
      heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
    });
    const staleResult = applyCommand(state, {
      origin: "player",
      serverReceivedAt: 0,
      envelope: { ...stale, expectedVersion: 99 },
    });
    expect(staleResult).toMatchObject({
      accepted: false,
      reason: "stale-version",
    });
    expect(
      applyCommand(state, {
        origin: "player",
        serverReceivedAt: 0,
        envelope: envelope(state, playerId, "foreign", {
          type: "choose-hero",
          heroId: "xyy.hero.not-offered",
        }),
      }),
    ).toMatchObject({ accepted: false, reason: "forbidden" });
    expect(
      applyCommand(state, {
        origin: "player",
        serverReceivedAt: 0,
        envelope: {
          ...envelope(state, playerId, "wrong-player", {
            type: "reroll-hero",
          }),
          playerId: "intruder",
        },
      }),
    ).toMatchObject({ accepted: false, reason: "forbidden" });
  });

  it("conserves setup entities across generated seeds and JSON round trips", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 80 }), (seed) => {
        const state = setup(seed);
        expect(JSON.parse(JSON.stringify(state))).toEqual(state);
        const offers = Object.values(state.setup!.offers).flatMap((offer) => [
          ...offer.candidateHeroIds,
          offer.replacementHeroId,
        ]);
        expect(new Set(offers).size).toBe(24);
        expect(new Set(state.drawPile)).toEqual(new Set(SETUP_CARD_INSTANCES));
        expect(state.encounterDeck).toHaveLength(30);
        expect(state.reserveNpcDeck).toHaveLength(16);
        expect(
          new Set([...state.encounterDeck, ...state.reserveNpcDeck]),
        ).toEqual(new Set([...SETUP_MONSTER_IDS, ...SETUP_NPC_IDS]));
        expect(state.rng.cursor).toBeGreaterThan(0);
      }),
      { numRuns: 200, seed: 20_260_819 },
    );
  });
});
