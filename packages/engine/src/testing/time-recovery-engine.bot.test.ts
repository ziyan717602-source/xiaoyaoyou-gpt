import { describe, expect, it } from "vitest";
import {
  applyCommand,
  collectSystemDeadlines,
  createSetupMatch,
  SETUP_CARD_INSTANCES,
  type EngineCommand,
  type MatchState,
  type SystemDeadline,
} from "../index.js";

const players = Array.from({ length: 6 }, (_, index) => ({
  id: `auto-player-${index + 1}`,
  nickname: `自动玩家${index + 1}`,
}));

function commandFor(
  state: Readonly<MatchState>,
  deadline: Readonly<SystemDeadline>,
): Exclude<EngineCommand, { origin: "player" | "system-presence" }> {
  return deadline.origin === "system-auto"
    ? {
        origin: "system-auto",
        commandId: deadline.id,
        matchId: state.matchId,
        expectedVersion: state.version,
        playerId: deadline.playerId,
        disconnectedAt: deadline.disconnectedAt!,
        deadlineAt: deadline.deadlineAt,
      }
    : {
        origin: "system-timeout",
        commandId: deadline.id,
        matchId: state.matchId,
        expectedVersion: state.version,
        targetId: deadline.targetId,
        deadlineAt: deadline.deadlineAt,
      };
}

function applyDeadline(
  state: MatchState,
  deadline: Readonly<SystemDeadline>,
): MatchState {
  const result = applyCommand(state, commandFor(state, deadline));
  if (!result.accepted) throw new Error(result.reason);
  return result.state;
}

function conserved(state: Readonly<MatchState>): boolean {
  const cards = [
    ...state.drawPile,
    ...state.discardPile,
    ...Object.values(state.players).flatMap((player) => [
      ...player.hand,
      ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
      ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
    ]),
  ];
  return (
    cards.length === SETUP_CARD_INSTANCES.length &&
    new Set(cards).size === SETUP_CARD_INSTANCES.length
  );
}

function run(seed: string, turns: number): MatchState {
  let state = createSetupMatch({
    matchId: `auto-${seed}`,
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    openedAt: 1_000,
    players,
  });
  for (const [index, player] of players.entries()) {
    const disconnected = applyCommand(state, {
      origin: "system-presence",
      commandId: `auto-disconnect-${index}`,
      matchId: state.matchId,
      expectedVersion: state.version,
      playerId: player.id,
      status: "disconnected",
      occurredAt: 2_000 + index,
    });
    if (!disconnected.accepted) throw new Error(disconnected.reason);
    state = disconnected.state;
    const auto = collectSystemDeadlines(state).find(
      (candidate) =>
        candidate.origin === "system-auto" && candidate.playerId === player.id,
    )!;
    state = applyDeadline(state, auto);
  }
  while (state.phase === "setup") {
    const setup = collectSystemDeadlines(state).find(
      (candidate) => candidate.origin === "system-timeout",
    )!;
    state = applyDeadline(state, setup);
  }

  const targetTurn = state.turn!.number + turns;
  while (state.phase === "playing" && state.turn!.number < targetTurn) {
    const timeout = collectSystemDeadlines(state).find(
      (candidate) => candidate.origin === "system-timeout",
    );
    if (timeout === undefined)
      throw new Error("Auto match has no decision deadline.");
    state = applyDeadline(state, timeout);
    if (!conserved(state))
      throw new Error("Auto timeout violated card conservation.");
  }
  return state;
}

describe("M06 six-player auto-mode bot", () => {
  it("replays 1000 timeout-driven turns deterministically with card conservation", () => {
    const first = run("m06-auto-bot", 1_000);
    const replay = run("m06-auto-bot", 1_000);
    expect(replay).toEqual(first);
    expect(first.turn?.number).toBe(1_001);
    expect(conserved(first)).toBe(true);
  });
});
