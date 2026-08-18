import { describe, expect, it } from "vitest";
import {
  createInitialMatch,
  createPlayerView,
  type MatchState,
} from "./index.js";

function createSixPlayerMatch(): MatchState {
  return createInitialMatch({
    matchId: "match-001",
    rulesetVersion: "baseline-0",
    seed: "deterministic-seed",
    players: Array.from({ length: 6 }, (_, index) => ({
      id: `player-${index + 1}`,
      nickname: `玩家${index + 1}`,
    })),
  });
}

describe("match state baseline", () => {
  it("creates a deterministic, JSON-serializable six-player state", () => {
    const state = createSixPlayerMatch();
    const restored = JSON.parse(JSON.stringify(state)) as MatchState;

    expect(restored).toEqual(state);
    expect(Object.keys(state.players)).toHaveLength(6);
    expect(state.effectStack).toEqual([]);
    expect(state.reactionWindow).toBeNull();
  });

  it("does not expose another player's private hand", () => {
    const state = createSixPlayerMatch();
    const stateWithHands: MatchState = {
      ...state,
      players: {
        ...state.players,
        "player-1": { ...state.players["player-1"]!, hand: ["TP01"] },
        "player-2": { ...state.players["player-2"]!, hand: ["TP02", "JP01"] },
      },
    };

    const view = createPlayerView(stateWithHands, "player-1");

    expect(
      view.players.find((player) => player.id === "player-1")?.hand,
    ).toEqual(["TP01"]);
    expect(
      view.players.find((player) => player.id === "player-2")?.hand,
    ).toBeNull();
    expect(
      view.players.find((player) => player.id === "player-2")?.handCount,
    ).toBe(2);
  });
});
