import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  createPlayerView,
  createSetupMatch,
  SETUP_CARD_INSTANCES,
  cardDefinition,
  type AvailableAction,
  type CardInstanceId,
  type MatchState,
} from "../index.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `combat-bot-${index + 1}`,
  nickname: `Combat Bot ${index + 1}`,
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
      `${commandId}: ${result.reason}; actor=${playerId}; phase=${state.phase}/${state.turn?.phase}; command=${JSON.stringify(value)}`,
    );
  }
  return result.state;
}

function started(game: number): MatchState {
  let state = createSetupMatch({
    matchId: `m05-combat-bot-${game}`,
    rulesetVersion: "standard-fengmingyushi@1",
    seed: `m05-combat-bot-seed-${game}`,
    players: seats,
  });
  for (const playerId of state.turnOrder) {
    state = command(state, playerId, `choose-${game}-${playerId}`, {
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

function choosePlay(
  state: MatchState,
  actor: PlayerId,
  action: Extract<AvailableAction, { type: "play-card" }>,
): CommandEnvelope["command"] {
  if (action.mode !== undefined) {
    return {
      type: "play-card",
      cardInstanceId: action.cardInstanceId,
      targetPlayerIds: action.targetPlayerIds,
      mode: action.mode,
    };
  }
  if (action.cardInstanceId.startsWith("xyy.card.jp05@")) {
    const actorTeam = state.players[actor]!.team;
    const opponents = action.targetPlayerIds
      .map((playerId) => state.players[playerId]!)
      .filter((player) => player.id !== actor && player.team !== actorTeam)
      .sort((left, right) => left.hp - right.hp || left.seat - right.seat);
    const target =
      opponents.find(
        (player) =>
          player.equipment.armor === null ||
          cardDefinition(player.equipment.armor).id !== "xyy.card.fj04",
      ) ?? opponents[0];
    return {
      type: "play-card",
      cardInstanceId: action.cardInstanceId,
      targetPlayerIds: [target?.id ?? action.targetPlayerIds[0]!],
    };
  }
  if (action.cardInstanceId.startsWith("xyy.card.jp06@")) {
    const actorTeam = state.players[actor]!.team;
    const protectedOpponent = action.targetPlayerIds
      .map((playerId) => state.players[playerId]!)
      .find(
        (player) =>
          player.team !== actorTeam &&
          player.equipment.armor !== null &&
          cardDefinition(player.equipment.armor).id === "xyy.card.fj04",
      );
    if (protectedOpponent !== undefined) {
      return {
        type: "play-card",
        cardInstanceId: action.cardInstanceId,
        targetPlayerIds: [protectedOpponent.id],
      };
    }
  }
  return {
    type: "play-card",
    cardInstanceId: action.cardInstanceId,
    targetPlayerIds: [
      action.targetPlayerIds.includes(actor)
        ? actor
        : action.targetPlayerIds[0]!,
    ],
  };
}

describe("M05 six-player combat bots", () => {
  it("runs 1,000 damage-capable turns across completed matches", () => {
    let game = 0;
    let state = started(game);
    let sequence = 0;
    let completedTurns = 0;
    let completedMatches = 0;
    let damageCardsPlayed = 0;
    let rescueCardsPlayed = 0;
    let observedDeaths = 0;

    while (completedTurns < 1_000 || completedMatches === 0) {
      if (completedTurns >= 5_000) {
        throw new Error(
          "Combat Bot did not complete a match within 5,000 turns.",
        );
      }
      if (state.phase === "finished") {
        completedMatches += 1;
        game += 1;
        state = started(game);
        continue;
      }
      const turnNumber = state.turn!.number;
      const actor = state.activePlayerId!;
      let guard = 0;
      while (
        state.phase === "playing" &&
        state.turn?.number === turnNumber &&
        (state.turn.phase === "action" ||
          state.dyingBatch !== null ||
          state.pendingChoice !== null ||
          state.reactionWindow !== null)
      ) {
        guard += 1;
        if (guard > 256) throw new Error("Combat Bot action did not converge.");
        let playerId: PlayerId;
        let nextCommand: CommandEnvelope["command"];
        if (state.dyingBatch !== null) {
          if (state.dyingBatch.status === "distributing-loot") {
            playerId = state.pendingChoice!.playerIds[0]!;
            const finish = createPlayerView(
              state,
              playerId,
            ).availableActions.find(
              (action) => action.type === "finish-death-loot",
            );
            if (finish?.type !== "finish-death-loot") {
              throw new Error("Loot Bot has no legal finish action.");
            }
            nextCommand = finish;
          } else {
            playerId =
              state.dyingBatch.priorityOrder[state.dyingBatch.priorityIndex]!;
            const actions = createPlayerView(state, playerId).availableActions;
            const rescue = actions.find(
              (action) => action.type === "play-rescue-card",
            );
            const pass = actions.find(
              (action) => action.type === "pass-rescue",
            );
            if (rescue?.type === "play-rescue-card") {
              rescueCardsPlayed += 1;
              nextCommand = rescue;
            } else if (pass?.type === "pass-rescue") {
              nextCommand = pass;
            } else {
              throw new Error("Rescue priority Bot has no legal action.");
            }
          }
        } else if (state.pendingChoice !== null) {
          playerId = state.pendingChoice.playerIds[0]!;
          const choice = createPlayerView(
            state,
            playerId,
          ).availableActions.find((action) => action.type === "submit-choice");
          if (choice?.type !== "submit-choice") {
            throw new Error("Choice Bot has no legal submit action.");
          }
          nextCommand = {
            type: "submit-choice",
            choiceId: choice.choiceId,
            selections: [
              choice.optionIds.includes("equipment:armor")
                ? "equipment:armor"
                : choice.optionIds[0]!,
            ],
          };
        } else if (state.reactionWindow !== null) {
          playerId =
            state.reactionWindow.priorityOrder[
              state.reactionWindow.priorityIndex
            ]!;
          const actions = createPlayerView(state, playerId).availableActions;
          const reaction = actions.find(
            (action) => action.type === "play-reaction-card",
          );
          const pass = actions.find(
            (action) => action.type === "pass-reaction",
          );
          nextCommand =
            reaction?.type === "play-reaction-card"
              ? reaction
              : pass?.type === "pass-reaction"
                ? pass
                : (() => {
                    throw new Error(
                      "Reaction priority Bot has no legal action.",
                    );
                  })();
        } else {
          playerId = actor;
          const actions = createPlayerView(state, actor).availableActions;
          const plays = actions.filter(
            (
              action,
            ): action is Extract<AvailableAction, { type: "play-card" }> =>
              action.type === "play-card",
          );
          // This combat policy preserves cards for damage/rescue coverage;
          // pawn-heavy play is exercised by the turn/equipment bots instead.
          const nonPawnPlays = plays.filter((action) => action.mode !== "pawn");
          const actorTeam = state.players[actor]!.team;
          const protectedOpponentIds = new Set(
            Object.values(state.players)
              .filter(
                (player) =>
                  player.alive &&
                  player.team !== actorTeam &&
                  player.equipment.armor !== null &&
                  cardDefinition(player.equipment.armor).id === "xyy.card.fj04",
              )
              .map((player) => player.id),
          );
          const armorRemoval = nonPawnPlays.find(
            (action) =>
              action.cardInstanceId.startsWith("xyy.card.jp06@") &&
              action.targetPlayerIds.some((playerId) =>
                protectedOpponentIds.has(playerId),
              ),
          );
          const play =
            armorRemoval ??
            plays.find((action) =>
              action.cardInstanceId.startsWith("xyy.card.jp05@"),
            ) ??
            nonPawnPlays[0];
          if (play === undefined) {
            nextCommand = { type: "end-action" };
          } else {
            if (play.cardInstanceId.startsWith("xyy.card.jp05@")) {
              damageCardsPlayed += 1;
            }
            nextCommand = choosePlay(state, actor, play);
          }
        }
        const livingBefore = Object.values(state.players).filter(
          (player) => player.alive,
        ).length;
        state = command(
          state,
          playerId,
          `combat-command-${sequence++}`,
          nextCommand,
        );
        const livingAfter = Object.values(state.players).filter(
          (player) => player.alive,
        ).length;
        observedDeaths += livingBefore - livingAfter;
        expect(cardSet(state)).toEqual(new Set(SETUP_CARD_INSTANCES));
      }
      if (state.phase === "playing" && state.turn?.phase === "discard") {
        const discard = createPlayerView(state, actor).availableActions[0];
        if (discard?.type !== "discard-cards") {
          throw new Error("Combat Bot is missing discard action.");
        }
        state = command(state, actor, `combat-command-${sequence++}`, {
          type: "discard-cards",
          cardInstanceIds: discard.cardInstanceIds.slice(0, discard.count),
        });
      }
      if (state.phase === "playing") {
        expect(state.turn?.number).toBe(turnNumber + 1);
      }
      expect(cardSet(state)).toEqual(new Set(SETUP_CARD_INSTANCES));
      completedTurns += 1;
    }

    expect(completedMatches).toBeGreaterThan(0);
    expect(damageCardsPlayed).toBeGreaterThan(0);
    expect(rescueCardsPlayed).toBeGreaterThan(0);
    expect(observedDeaths).toBeGreaterThan(0);
  });
});
