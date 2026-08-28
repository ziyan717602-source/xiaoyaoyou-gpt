import type { PlayerId } from "@xiaoyaoyou/protocol";
import type { MatchState } from "./index.js";
import type { MonsterId } from "./encounter-content.js";
import { encounterDefinition } from "./encounter-definitions.js";
import { assertEncounterOwnership } from "./encounter-resolution.js";
import type { EncounterParticipant } from "./encounter.js";

export type PetOwnership = MatchState["encounterState"]["pets"];
export type WeaponDisableReasons = Readonly<
  Partial<Record<PlayerId, readonly "GL04"[]>>
>;

// Only gain/loss passives, from FG04.cs. Debut, win/loss and consumption are
// separate continuations and must not be treated as implemented by this table.
const STAT_PASSIVES: Readonly<Record<string, readonly [number, number]>> = {
  gs01: [1, 0],
  gs04: [1, 1],
  gh01: [1, 0],
  gh03: [2, 0],
  gh04: [2, 0],
  gl03: [0, 2],
  gf02: [1, 0],
  gt02: [0, 1],
  gt04: [2, 1],
};
function stats(cards: readonly MonsterId[]): readonly [number, number] {
  return cards.reduce<readonly [number, number]>(
    (sum, id) => {
      const delta = STAT_PASSIVES[id.slice("xyy.monster.".length)] ?? [0, 0];
      return [sum[0] + delta[0]!, sum[1] + delta[1]!];
    },
    [0, 0],
  );
}
function slot(id: MonsterId): number {
  const definition = encounterDefinition(id);
  if (definition.kind !== "monster") throw new Error("Pet must be a monster.");
  return ["water", "fire", "thunder", "wind", "earth"].indexOf(
    definition.element,
  );
}
export function petWeaponDisableReasons(
  state: MatchState,
  pets: PetOwnership,
): WeaponDisableReasons {
  const owner = Object.keys(pets).find((id) =>
    pets[id]?.includes("xyy.monster.gl04"),
  );
  if (owner === undefined) return {};
  const team = state.players[owner]!.team;
  return Object.fromEntries(
    Object.values(state.players)
      .filter((p) => p.team !== team)
      .map((p) => [p.id, ["GL04"]]),
  );
}
export function weaponEffectsEnabled(
  state: Readonly<MatchState>,
  playerId: PlayerId,
): boolean {
  return (
    (state.encounterState.weaponDisabledReasons[playerId]?.length ?? 0) === 0
  );
}

/** Internal atomic zone transition. The caller accounts for deck/discard/held
 * cards; this function validates the resulting ownership and applies deltas,
 * preserving unrelated hero/equipment modifiers. Never a client command. */
export function withPetOwnership(
  state: MatchState,
  pets: PetOwnership,
): MatchState {
  const before = state.encounterState.pets;
  const canonical: Record<PlayerId, readonly MonsterId[]> = {};
  for (const owner of Object.keys(pets).sort()) {
    const cards = pets[owner]!;
    if (state.players[owner] === undefined || !Array.isArray(cards))
      throw new Error("Invalid pet owner.");
    if (cards.length > 0)
      canonical[owner] = [...cards].sort((a, b) => slot(a) - slot(b));
  }
  assertEncounterOwnership(state.encounterState.resolution, {
    ...state,
    pets: canonical,
    companions: state.encounterState.companions,
  });
  const players = { ...state.players };
  for (const player of Object.values(players)) {
    const old = stats(before[player.id] ?? []),
      next = stats(canonical[player.id] ?? []);
    players[player.id] = {
      ...player,
      strength: player.strength + next[0] - old[0],
      dexterity: player.dexterity + next[1] - old[1],
    };
  }
  let resolution = state.encounterState.resolution;
  if (resolution !== null) {
    const lost = (p: EncounterParticipant | null) =>
      p?.kind === "pet" &&
      p.cardId === "xyy.monster.gt03" &&
      before[p.ownerPlayerId]?.includes(p.cardId) === true &&
      canonical[p.ownerPlayerId]?.includes(p.cardId) !== true;
    resolution = {
      ...resolution,
      supporter: lost(resolution.supporter) ? null : resolution.supporter,
      hinder: lost(resolution.hinder) ? null : resolution.hinder,
    };
  }
  return {
    ...state,
    players,
    encounterState: {
      ...state.encounterState,
      resolution,
      pets: canonical,
      weaponDisabledReasons: petWeaponDisableReasons(state, canonical),
    },
  };
}

/** NC303 NJ07 -> HarvestPet.KOKAN: same-team transfer, mandatory same-element
 * exchange; no discard and no extra retention window. */
export function exchangePet(
  state: MatchState,
  donor: PlayerId,
  recipient: PlayerId,
  pet: MonsterId,
): MatchState {
  const from = state.players[donor],
    to = state.players[recipient];
  const pets = state.encounterState.pets;
  const incoming = encounterDefinition(pet);
  if (
    !from?.alive ||
    !to?.alive ||
    donor === recipient ||
    from.team !== to.team ||
    incoming.kind !== "monster" ||
    !pets[donor]?.includes(pet)
  )
    throw new Error("Illegal pet exchange.");
  const returned = pets[recipient]?.find((id) => {
    const definition = encounterDefinition(id);
    return (
      definition.kind === "monster" && definition.element === incoming.element
    );
  });
  return withPetOwnership(state, {
    ...pets,
    [donor]: [
      ...pets[donor]!.filter((id) => id !== pet),
      ...(returned === undefined ? [] : [returned]),
    ],
    [recipient]: [
      ...(pets[recipient] ?? []).filter((id) => id !== returned),
      pet,
    ],
  });
}
export function discardOwnedPets(
  state: MatchState,
  owners: readonly PlayerId[],
): MatchState {
  const pets = { ...state.encounterState.pets };
  const discarded: MonsterId[] = [];
  for (const owner of owners) {
    discarded.push(
      ...[...(pets[owner] ?? [])].sort((a, b) => slot(a) - slot(b)),
    );
    delete pets[owner];
  }
  return withPetOwnership(
    { ...state, encounterDiscard: [...state.encounterDiscard, ...discarded] },
    pets,
  );
}
