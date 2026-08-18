import { describe, expect, it } from "vitest";
import {
  createInitialMatch,
  createPlayerView,
  migrateMatchState,
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
    expect(state.protocolVersion).toBe(1);
    expect(state.persistenceVersion).toBe(1);
    expect(state.rng).toEqual({
      algorithm: "sha256-counter-v1",
      seed: "deterministic-seed",
      cursor: 0,
    });
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

  it("explicitly migrates M02 schema v2 snapshots and rejects unknown versions", () => {
    const current = createSixPlayerMatch();
    const legacy = JSON.parse(JSON.stringify(current)) as Record<
      string,
      unknown
    >;
    legacy.schemaVersion = 2;
    delete legacy.turn;
    delete legacy.winner;
    for (const player of Object.values(
      legacy.players as Record<string, Record<string, unknown>>,
    )) {
      delete player.handLimit;
      delete player.equipment;
    }

    const migrated = migrateMatchState(legacy);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.turn).toBeNull();
    expect(migrated.winner).toBeNull();
    expect(
      Object.values(migrated.players).every(
        (player) =>
          player.handLimit === 3 &&
          player.equipment.weapon === null &&
          player.equipment.armor === null,
      ),
    ).toBe(true);
    expect(() => migrateMatchState({ ...legacy, schemaVersion: 99 })).toThrow(
      "Unsupported match schema version 99",
    );
  });
});
