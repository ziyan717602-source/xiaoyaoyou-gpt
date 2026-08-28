import { describe, expect, it } from "vitest";
import {
  createEncounterDecks,
  createPlayerView,
  createSetupMatch,
  migrateMatchState,
  SETUP_MONSTER_IDS,
  SETUP_NPC_IDS,
  type MatchState,
} from "./index.js";

const players = Array.from({ length: 6 }, (_, index) => ({
  id: `encounter-player-${index + 1}`,
  nickname: `Encounter ${index + 1}`,
}));

function setup(seed = "cs03-encounter-deck-seed"): MatchState {
  return createSetupMatch({
    matchId: `cs03-encounter-${seed}`,
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    players,
  });
}

describe("CS03-01 deterministic encounter deck substrate", () => {
  it("partitions all 20 monsters and 26 NPCs into a 30-card main deck and 16-card reserve", () => {
    const zones = createEncounterDecks("encounter-partition-seed");
    expect(SETUP_MONSTER_IDS).toHaveLength(20);
    expect(SETUP_NPC_IDS).toHaveLength(26);
    expect(zones.encounterDeck).toHaveLength(30);
    expect(zones.reserveNpcDeck).toHaveLength(16);
    expect(zones.encounterDiscard).toEqual([]);
    expect(zones.reserveNpcDiscard).toEqual([]);

    const mainMonsters = zones.encounterDeck.filter((id) =>
      id.startsWith("xyy.monster."),
    );
    const mainNpcs = zones.encounterDeck.filter((id) =>
      id.startsWith("xyy.npc."),
    );
    expect(mainMonsters).toHaveLength(20);
    expect(mainNpcs).toHaveLength(10);
    expect(new Set(mainMonsters)).toEqual(new Set(SETUP_MONSTER_IDS));
    expect(new Set([...mainNpcs, ...zones.reserveNpcDeck])).toEqual(
      new Set(SETUP_NPC_IDS),
    );
    expect(
      new Set([...zones.encounterDeck, ...zones.reserveNpcDeck]),
    ).toHaveLength(46);
  });

  it("is seed-stable, diverges across seeds, and never exposes unrevealed identities to any seat", () => {
    const first = setup();
    const repeated = setup();
    const different = setup("cs03-another-encounter-seed");
    expect(repeated.encounterDeck).toEqual(first.encounterDeck);
    expect(repeated.reserveNpcDeck).toEqual(first.reserveNpcDeck);
    expect(different.encounterDeck).not.toEqual(first.encounterDeck);
    expect(different.reserveNpcDeck).not.toEqual(first.reserveNpcDeck);

    for (const player of players) {
      const view = createPlayerView(first, player.id);
      expect(view.encounter).toEqual({
        deckCount: 30,
        discardPile: [],
        lastInspection: null,
      });
      for (const hiddenId of [
        ...first.encounterDeck,
        ...first.reserveNpcDeck,
      ]) {
        expect(JSON.stringify(view)).not.toContain(hiddenId);
      }
    }
  });

  it("migrates a v6 snapshot without changing the established gameplay RNG cursor", () => {
    const current = setup("cs03-v6-migration-seed");
    const legacy = structuredClone(current) as unknown as Record<
      string,
      unknown
    >;
    legacy.schemaVersion = 6;
    delete legacy.encounterDeck;
    delete legacy.encounterDiscard;
    delete legacy.reserveNpcDeck;
    delete legacy.reserveNpcDiscard;

    const migrated = migrateMatchState(legacy);
    const expected = createEncounterDecks(current.rng.seed);
    expect(migrated).toMatchObject({ schemaVersion: 10, ...expected });
    expect(migrated.rng).toEqual(current.rng);
    expect(JSON.parse(JSON.stringify(migrated))).toEqual(migrated);
  });
});
