import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  createPlayerView,
  createSetupMatch,
  reduceEvent,
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

function started(): MatchState {
  let state = createSetupMatch({
    matchId: "m03-replay-match",
    rulesetVersion: "standard-fengmingyushi@1",
    seed: "m03-replay-restart-seed",
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
    expect(replayed.turn).toEqual({ number: 201, phase: "action" });
  });
});
