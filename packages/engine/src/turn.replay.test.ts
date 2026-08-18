import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  createPlayerView,
  createSetupMatch,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  type DomainEvent,
  type MatchState,
} from "./index.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `replay-${index + 1}`,
  nickname: `Replay ${index + 1}`,
}));

function apply(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  command: CommandEnvelope["command"],
): { readonly state: MatchState; readonly events: readonly DomainEvent[] } {
  const result = applyCommand(state, {
    origin: "player",
    serverReceivedAt: 0,
    envelope: {
      protocolVersion: 1,
      commandId,
      matchId: state.matchId,
      playerId,
      clientSequence: state.version,
      expectedVersion: state.version,
      clientIssuedAt: 0,
      command,
    },
  });
  if (!result.accepted) throw new Error(`${commandId}: ${result.reason}`);
  return result;
}

function started(seed = "m03-replay-restart-seed"): MatchState {
  let state = createSetupMatch({
    matchId: "m03-replay-match",
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    players: seats,
  });
  for (const playerId of state.turnOrder) {
    state = apply(state, playerId, `choose-${playerId}`, {
      type: "choose-hero",
      heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
    }).state;
  }
  return state;
}

describe("M03 turn event replay", () => {
  it("replays 剑匣 discard bypass identically across a JSON restart", () => {
    const setupState = started("jn50402-7");
    const ownerId = setupState.activePlayerId!;
    expect(setupState.players[ownerId]).toMatchObject({
      heroId: "xyy.hero.xj404",
      handLimit: 5,
    });
    const extraCard = setupState.drawPile[0]!;
    const initial: MatchState = {
      ...setupState,
      players: {
        ...setupState.players,
        [ownerId]: {
          ...setupState.players[ownerId]!,
          hand: [...setupState.players[ownerId]!.hand, extraCard],
        },
      },
      drawPile: setupState.drawPile.slice(1),
    };
    const command = { type: "end-action" as const };
    const uninterrupted = apply(initial, ownerId, "jn50402-replay", command);
    const restarted = apply(
      JSON.parse(JSON.stringify(initial)) as MatchState,
      ownerId,
      "jn50402-replay",
      command,
    );
    expect(restarted).toEqual(uninterrupted);
    expect(uninterrupted.state.players[ownerId]!.hand).toHaveLength(5);
    expect(uninterrupted.state.turn).toMatchObject({
      number: 2,
      phase: "action",
    });

    let replayed = initial;
    for (const domainEvent of uninterrupted.events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(domainEvent)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
  });

  it("replays WQ04 pawn from an equipped weapon across a JSON restart", () => {
    const startedState = started();
    const actor = startedState.activePlayerId!;
    const initial: MatchState = {
      ...startedState,
      players: {
        ...startedState.players,
        [actor]: {
          ...startedState.players[actor]!,
          hand: [],
          equipment: { weapon: "xyy.card.wq04@50", armor: null },
        },
      },
      drawPile: SETUP_CARD_INSTANCES.filter(
        (card) => card !== "xyy.card.wq04@50",
      ),
      discardPile: [],
    };
    const restarted = JSON.parse(JSON.stringify(initial)) as MatchState;
    const command = {
      type: "play-card" as const,
      cardInstanceId: "xyy.card.wq04@50",
      targetPlayerIds: [],
      mode: "pawn" as const,
    };
    const uninterrupted = apply(initial, actor, "wq04-replay-pawn", command);
    const resumed = apply(restarted, actor, "wq04-replay-pawn", command);
    expect(resumed).toEqual(uninterrupted);
    let replayed = initial;
    for (const event of uninterrupted.events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted.state);
    expect(uninterrupted.state.players[actor]).toMatchObject({
      hand: expect.any(Array),
      equipment: { weapon: null, armor: null },
    });
    expect(uninterrupted.state.players[actor]!.hand).toHaveLength(2);
    expect(uninterrupted.state.discardPile).toContain("xyy.card.wq04@50");
  });

  it("matches uninterrupted execution through JSON restart checkpoints", () => {
    const initial = started();
    let uninterrupted = initial;
    const events: DomainEvent[] = [];
    for (let turn = 0; turn < 200; turn += 1) {
      const actor = uninterrupted.activePlayerId!;
      let result = apply(uninterrupted, actor, `end-${turn}`, {
        type: "end-action",
      });
      uninterrupted = result.state;
      events.push(...result.events);
      if (uninterrupted.turn?.phase === "discard") {
        const action = createPlayerView(uninterrupted, actor)
          .availableActions[0];
        if (action?.type !== "discard-cards")
          throw new Error("missing discard");
        result = apply(uninterrupted, actor, `discard-${turn}`, {
          type: "discard-cards",
          cardInstanceIds: action.cardInstanceIds.slice(0, action.count),
        });
        uninterrupted = result.state;
        events.push(...result.events);
      }
      if (turn % 17 === 0) {
        uninterrupted = JSON.parse(JSON.stringify(uninterrupted)) as MatchState;
      }
    }

    let replayed = initial;
    for (const event of events) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(uninterrupted);
    expect(replayed.turn).toEqual({
      number: 201,
      phase: "action",
      openedAt: 0,
      deadlineAt: 15_000,
    });
  });
});
