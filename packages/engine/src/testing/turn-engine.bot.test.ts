import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  createPlayerView,
  createSetupMatch,
  SETUP_CARD_INSTANCES,
  type AvailableAction,
  type CardInstanceId,
  type MatchState,
} from "../index.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `bot-${index + 1}`,
  nickname: `Bot ${index + 1}`,
}));

function command(
  state: MatchState,
  playerId: PlayerId,
  commandId: string,
  value: CommandEnvelope["command"],
): MatchState {
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
      command: value,
    },
  });
  if (!result.accepted) {
    throw new Error(
      `${commandId}: ${result.reason}; actor=${playerId}; active=${state.activePlayerId}; phase=${state.turn?.phase}; command=${JSON.stringify(value)}`,
    );
  }
  return result.state;
}

function started(seed: string): MatchState {
  let state = createSetupMatch({
    matchId: "m03-bot-match",
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    players: seats,
  });
  for (const playerId of state.turnOrder) {
    state = command(state, playerId, `select-${playerId}`, {
      type: "choose-hero",
      heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
    });
  }
  return state;
}

function cardSet(state: MatchState): Set<CardInstanceId> {
  return new Set([
    ...state.drawPile,
    ...state.discardPile,
    ...Object.values(state.players).flatMap((player) => [
      ...player.hand,
      ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
      ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
    ]),
  ]);
}

function chooseCardAction(
  action: Extract<AvailableAction, { type: "play-card" }>,
) {
  if (action.mode !== undefined) {
    return {
      type: "play-card" as const,
      cardInstanceId: action.cardInstanceId,
      targetPlayerIds: action.targetPlayerIds,
      mode: action.mode,
    };
  }
  return {
    type: "play-card" as const,
    cardInstanceId: action.cardInstanceId,
    targetPlayerIds: [action.targetPlayerIds[0]!],
  };
}

describe("M03 six-player engine bots", () => {
  it("runs 1,000 real turns using only projected availableActions", () => {
    let state = started("m03-1000-turn-bots");
    let commandSequence = 0;
    let reactionCardsPlayed = 0;
    for (let completedTurns = 0; completedTurns < 1_000; completedTurns += 1) {
      const actor = state.activePlayerId!;
      let actionGuard = 0;
      while (state.turn?.phase === "action") {
        actionGuard += 1;
        if (actionGuard > 128)
          throw new Error("Bot action phase did not converge.");
        if (state.reactionWindow !== null) {
          const priority =
            state.reactionWindow.priorityOrder[
              state.reactionWindow.priorityIndex
            ]!;
          const pass = createPlayerView(state, priority).availableActions.find(
            (action) => action.type === "pass-reaction",
          );
          const reaction = createPlayerView(
            state,
            priority,
          ).availableActions.find(
            (action) => action.type === "play-reaction-card",
          );
          if (pass?.type !== "pass-reaction") {
            throw new Error("Priority Bot did not receive pass-reaction.");
          }
          if (reaction?.type === "play-reaction-card") {
            reactionCardsPlayed += 1;
          }
          state = command(
            state,
            priority,
            `bot-command-${commandSequence++}`,
            reaction?.type === "play-reaction-card" ? reaction : pass,
          );
          continue;
        }
        const view = createPlayerView(state, actor);
        const playable = view.availableActions.find(
          (action): action is Extract<AvailableAction, { type: "play-card" }> =>
            action.type === "play-card" &&
            !action.cardInstanceId.startsWith("xyy.card.jp05@"),
        );
        state = command(
          state,
          actor,
          `bot-command-${commandSequence++}`,
          playable === undefined
            ? { type: "end-action" }
            : chooseCardAction(playable),
        );
        if (playable === undefined) break;
      }
      if (state.turn?.phase === "discard") {
        const view = createPlayerView(state, actor);
        const discard = view.availableActions[0];
        if (discard?.type !== "discard-cards") {
          throw new Error("Bot did not receive its required discard action.");
        }
        state = command(state, actor, `bot-command-${commandSequence++}`, {
          type: "discard-cards",
          cardInstanceIds: discard.cardInstanceIds.slice(0, discard.count),
        });
      }
      expect(state.turn?.number).toBe(completedTurns + 2);
      expect(state.turn?.phase).toBe("action");
      expect(cardSet(state)).toEqual(new Set(SETUP_CARD_INSTANCES));
    }
    expect(state.phase).toBe("playing");
    expect(state.version).toBeGreaterThan(2_000);
    expect(reactionCardsPlayed).toBeGreaterThan(0);
  });
});
