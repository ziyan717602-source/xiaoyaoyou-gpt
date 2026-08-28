import type { PlayerId } from "@xiaoyaoyou/protocol";
import type { MatchState } from "./index.js";
import {
  SETUP_HEROES,
  heroDefinition,
  handLimitForHero,
  type HeroId,
} from "./setup-content.js";
import { withWeaponSkillEquipment } from "./hero-stats.js";
import { petStatBonuses } from "./pet-effects.js";

// Hero.ISO: bare IDs are isomorphs; @ID is an archetype. XJ207/XJ507
// deliberately have no archetype: a dead isomorph does not block joining.
const ISOMORPHS: Readonly<Partial<Record<HeroId, readonly HeroId[]>>> = {
  "xyy.hero.xj102": ["xyy.hero.xj103"],
  "xyy.hero.xj103": ["xyy.hero.xj102"],
  "xyy.hero.xj206": ["xyy.hero.xj207"],
  "xyy.hero.xj207": ["xyy.hero.xj206"],
  "xyy.hero.xj303": ["xyy.hero.xj304"],
  "xyy.hero.xj304": ["xyy.hero.xj303"],
  "xyy.hero.xj506": ["xyy.hero.xj507"],
  "xyy.hero.xj507": ["xyy.hero.xj506"],
};
const ARCHETYPES: Readonly<Partial<Record<HeroId, HeroId>>> = {
  "xyy.hero.xj103": "xyy.hero.xj102",
  "xyy.hero.xj304": "xyy.hero.xj303",
};
const NOT_JOINABLE: readonly HeroId[] = [
  "xyy.hero.xj103",
  "xyy.hero.xj207",
  "xyy.hero.xj304",
  "xyy.hero.xj507",
];

export function isHeroJoinable(state: MatchState, hero: HeroId): boolean {
  if (!SETUP_HEROES.some((h) => h.id === hero) || NOT_JOINABLE.includes(hero))
    return false;
  const conflicts = (existing: HeroId, alive: boolean) =>
    (alive &&
      (existing === hero || ISOMORPHS[hero]?.includes(existing) === true)) ||
    ARCHETYPES[hero] === existing ||
    ARCHETYPES[existing] === hero;
  return (
    !Object.values(state.players).some(
      (p) => p.heroId !== null && conflicts(p.heroId, p.alive),
    ) && !state.encounterState.bannedHeroes.some((id) => conflicts(id, true))
  );
}

/** Dead player.heroId is a historical reference, not a second owned hero.
 * The canonical registry partitions every scoped identity exactly once. */
export function heroAvailability(state: MatchState) {
  const active = Object.values(state.players)
    .filter((p) => p.alive && p.heroId !== null)
    .map((p) => p.heroId!);
  const discarded = state.encounterState.heroDiscards;
  const banned = state.encounterState.bannedHeroes;
  const occupied = new Set([...active, ...discarded, ...banned]);
  if (occupied.size !== active.length + discarded.length + banned.length)
    throw new Error("Duplicate hero ownership.");
  return {
    active,
    discarded,
    banned,
    available: SETUP_HEROES.map((h) => h.id).filter((id) => !occupied.has(id)),
  };
}

export function validateHeroRoster(state: MatchState): void {
  const { heroDiscards, bannedHeroes } = state.encounterState;
  if (!Array.isArray(heroDiscards) || !Array.isArray(bannedHeroes))
    throw new Error("Missing hero roster.");
  const ids = [...heroDiscards, ...bannedHeroes];
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !SETUP_HEROES.some((h) => h.id === id)) ||
    Object.values(state.players).some(
      (p) => p.alive && p.heroId !== null && ids.includes(p.heroId),
    )
  )
    throw new Error("Invalid hero roster ownership.");
}

/** G0OY(0) then G0IY(0/2): reset role stats/uses, preserve physical zones,
 * import the new role's equipment skills and existing pet passives once. */
export function reloadHero(
  state: MatchState,
  playerId: PlayerId,
  heroId: HeroId,
  hp: number,
): MatchState {
  const player = state.players[playerId],
    hero = heroDefinition(heroId);
  if (
    player === undefined ||
    !Number.isSafeInteger(hp) ||
    hp < 1 ||
    state.encounterState.bannedHeroes.includes(heroId) ||
    Object.values(state.players).some(
      (p) => p.id !== playerId && p.alive && p.heroId === heroId,
    )
  )
    throw new Error("Invalid hero reload.");
  const [strength, dexterity] = petStatBonuses(
    state.encounterState.pets[playerId] ?? [],
  );
  const nextPlayer = withWeaponSkillEquipment(
    {
      ...player,
      heroId,
      alive: true,
      hp: Math.min(hp, hero.maxHp),
      maxHp: hero.maxHp,
      strength: hero.strength + strength,
      dexterity: hero.dexterity + dexterity,
      handLimit: handLimitForHero(heroId),
      equipment: { weapon: null, armor: null },
    },
    player.equipment,
  );
  const discards = new Set(state.encounterState.heroDiscards);
  if (
    player.heroId !== null &&
    !state.encounterState.bannedHeroes.includes(player.heroId) &&
    !Object.values(state.players).some(
      (p) => p.id !== playerId && p.alive && p.heroId === player.heroId,
    )
  )
    discards.add(player.heroId);
  discards.delete(heroId);
  return {
    ...state,
    players: { ...state.players, [playerId]: nextPlayer },
    encounterState: {
      ...state.encounterState,
      heroDiscards: [...discards].sort(),
    },
    turn:
      state.turn !== null && playerId === state.activePlayerId
        ? {
            ...state.turn,
            ...(state.turn.usedSkillIds === undefined
              ? {}
              : { usedSkillIds: [] }),
            ...(state.turn.usedSkillCounts === undefined
              ? {}
              : { usedSkillCounts: {} }),
            ...(state.turn.usedSkillTargetIds === undefined
              ? {}
              : { usedSkillTargetIds: {} }),
          }
        : state.turn,
  };
}
