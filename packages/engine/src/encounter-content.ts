import { shuffle } from "./random.js";
import type { RngState } from "./index.js";

export type MonsterId = `xyy.monster.${string}`;
export type NpcId = `xyy.npc.${string}`;
export type EncounterCardId = MonsterId | NpcId;

export interface EncounterDecks {
  readonly encounterDeck: readonly EncounterCardId[];
  readonly encounterDiscard: readonly EncounterCardId[];
  readonly reserveNpcDeck: readonly NpcId[];
  readonly reserveNpcDiscard: readonly NpcId[];
}

export const ENCOUNTER_DECK_ALGORITHM =
  "legacy-20-monster-10-npc-reserve-v1" as const;

export const SETUP_MONSTER_IDS: readonly MonsterId[] = [
  "xyy.monster.gf01",
  "xyy.monster.gf02",
  "xyy.monster.gf03",
  "xyy.monster.gf04",
  "xyy.monster.gh01",
  "xyy.monster.gh02",
  "xyy.monster.gh03",
  "xyy.monster.gh04",
  "xyy.monster.gl01",
  "xyy.monster.gl02",
  "xyy.monster.gl03",
  "xyy.monster.gl04",
  "xyy.monster.gs01",
  "xyy.monster.gs02",
  "xyy.monster.gs03",
  "xyy.monster.gs04",
  "xyy.monster.gt01",
  "xyy.monster.gt02",
  "xyy.monster.gt03",
  "xyy.monster.gt04",
];

export const SETUP_NPC_IDS: readonly NpcId[] = [
  "xyy.npc.n3w01",
  "xyy.npc.n3w02",
  "xyy.npc.n3w03",
  "xyy.npc.n3w04",
  "xyy.npc.nc101",
  "xyy.npc.nc102",
  "xyy.npc.nc103",
  "xyy.npc.nc104",
  "xyy.npc.nc105",
  "xyy.npc.nc106",
  "xyy.npc.nc107",
  "xyy.npc.nc201",
  "xyy.npc.nc202",
  "xyy.npc.nc203",
  "xyy.npc.nc206",
  "xyy.npc.nc207",
  "xyy.npc.nc302",
  "xyy.npc.nc305",
  "xyy.npc.nc306",
  "xyy.npc.nc401",
  "xyy.npc.nc402",
  "xyy.npc.nc403",
  "xyy.npc.nc404",
  "xyy.npc.nc405",
  "xyy.npc.nc503",
  "xyy.npc.nc504",
];

export function createEncounterDecks(seed: string): EncounterDecks {
  let rng: RngState = {
    algorithm: "sha256-counter-v1",
    seed: `${ENCOUNTER_DECK_ALGORITHM}:${seed}`,
    cursor: 0,
  };
  const monsters = shuffle(SETUP_MONSTER_IDS, rng);
  rng = monsters.rng;
  const npcs = shuffle(SETUP_NPC_IDS, rng);
  rng = npcs.rng;

  const main: EncounterCardId[] = [];
  for (let index = 0; index < 10; index += 1) {
    main.push(
      monsters.values[index * 2]!,
      monsters.values[index * 2 + 1]!,
      npcs.values[index]!,
    );
  }
  const encounter = shuffle(main, rng);
  rng = encounter.rng;
  const reserve = shuffle(npcs.values.slice(10), rng);

  return {
    encounterDeck: encounter.values,
    encounterDiscard: [],
    reserveNpcDeck: reserve.values,
    reserveNpcDiscard: [],
  };
}
