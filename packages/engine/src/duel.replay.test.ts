import { describe, expect, it } from "vitest";
import type { CommandEnvelope, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  createSetupMatch,
  reduceEvent,
  SETUP_CARD_INSTANCES,
  type CardInstanceId,
  type DomainEvent,
  type MatchState,
} from "./index.js";

const seats = Array.from({ length: 6 }, (_, index) => ({
  id: `duel-replay-${index + 1}`,
  nickname: `Duel Replay ${index + 1}`,
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

function started(): MatchState {
  let state = createSetupMatch({
    matchId: "duel-replay-match",
    rulesetVersion: "standard-fengmingyushi@1",
    seed: "duel-replay-setup",
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

describe("CS02 duel JSON replay", () => {
  it("replays every JN20102 wait and sequential JN30601 target from canonical events", () => {
    const base = started();
    const owner = base.activePlayerId!;
    const [firstTarget, secondTarget] = base.turnOrder.filter(
      (playerId) => playerId !== owner,
    );
    const claimed = new Set<CardInstanceId>([
      "xyy.card.jp01@1",
      "xyy.card.tp03@39",
      "xyy.card.jp02@3",
    ]);
    const initial: MatchState = {
      ...base,
      players: Object.fromEntries(
        Object.values(base.players).map((player) => [
          player.id,
          {
            ...player,
            heroId:
              player.id === owner
                ? "xyy.hero.xj306"
                : player.id === firstTarget || player.id === secondTarget
                  ? "xyy.hero.xj201"
                  : player.heroId,
            hp:
              player.id === owner
                ? 5
                : player.id === firstTarget || player.id === secondTarget
                  ? 2
                  : player.hp,
            maxHp: player.id === owner ? 5 : player.maxHp,
            hand:
              player.id === owner
                ? ["xyy.card.jp01@1"]
                : player.id === firstTarget
                  ? ["xyy.card.tp03@39"]
                  : player.id === secondTarget
                    ? ["xyy.card.jp02@3"]
                    : [],
            equipment: { weapon: null, armor: null },
          },
        ]),
      ),
      drawPile: SETUP_CARD_INSTANCES.filter((card) => !claimed.has(card)),
      discardPile: [],
      rng: {
        algorithm: "sha256-counter-v1",
        seed: "duel-sequential-rng",
        cursor: 0,
      },
    };
    const activationCommand = {
      type: "activate-hero-skill" as const,
      cardInstanceIds: ["xyy.card.jp01@1"],
      skillId: "xyy.skill.jn30601",
      targetPlayerIds: [firstTarget!, secondTarget!],
    };
    const activation = apply(
      initial,
      owner,
      "duel-replay-start",
      activationCommand,
    );
    expect(
      apply(
        JSON.parse(JSON.stringify(initial)) as MatchState,
        owner,
        "duel-replay-start",
        activationCommand,
      ),
    ).toEqual(activation);
    expect(activation.state.pendingChoice?.playerIds).toEqual([firstTarget!]);

    const rerollCommand = {
      type: "submit-choice" as const,
      choiceId: activation.state.pendingChoice!.choiceId,
      selections: ["xyy.card.tp03@39"],
    };
    const rerolled = apply(
      JSON.parse(JSON.stringify(activation.state)) as MatchState,
      firstTarget!,
      "duel-replay-reroll",
      rerollCommand,
    );
    expect(
      apply(
        activation.state,
        firstTarget!,
        "duel-replay-reroll",
        rerollCommand,
      ),
    ).toEqual(rerolled);
    expect(rerolled.state.pendingChoice?.playerIds).toEqual([secondTarget!]);
    expect(rerolled.state.players[firstTarget!]!.hp).toBe(1);

    const passCommand = {
      type: "submit-choice" as const,
      choiceId: rerolled.state.pendingChoice!.choiceId,
      selections: [],
    };
    const completed = apply(
      JSON.parse(JSON.stringify(rerolled.state)) as MatchState,
      secondTarget!,
      "duel-replay-pass",
      passCommand,
    );
    expect(
      apply(rerolled.state, secondTarget!, "duel-replay-pass", passCommand),
    ).toEqual(completed);
    expect(completed.state.turn?.duelContinuation).toBeUndefined();
    expect(completed.state.players[firstTarget!]!.hp).toBe(1);
    expect(completed.state.players[secondTarget!]!.hp).toBe(1);
    expect(completed.state.players[owner]!.hp).toBe(3);
    expect(completed.state.rng.cursor).toBe(5);

    let replayed = JSON.parse(JSON.stringify(initial)) as MatchState;
    for (const event of [
      ...activation.events,
      ...rerolled.events,
      ...completed.events,
    ]) {
      replayed = reduceEvent(
        replayed,
        JSON.parse(JSON.stringify(event)) as DomainEvent,
      );
    }
    expect(replayed).toEqual(completed.state);
  });
});
