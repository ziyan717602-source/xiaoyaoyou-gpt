import type { PlayerState } from "./index.js";
import { heroHasSkill } from "./setup-content.js";

/**
 * Apply the legacy JN10401/JN10601 weapon import/export modifiers alongside
 * an equipment-zone transition. Replacing one weapon with another is a 1 -> 1
 * transition and therefore does not stack either locked skill.
 */
export function withWeaponSkillEquipment(
  player: Readonly<PlayerState>,
  equipment: PlayerState["equipment"],
): PlayerState {
  const weaponDelta =
    Number(equipment.weapon !== null) -
    Number(player.equipment.weapon !== null);
  const strengthDelta =
    weaponDelta !== 0 &&
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn10401")
      ? weaponDelta
      : 0;
  const dexterityDelta =
    weaponDelta !== 0 &&
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn10601")
      ? weaponDelta
      : 0;
  return {
    ...player,
    strength: player.strength + strengthDelta,
    dexterity: player.dexterity + dexterityDelta,
    equipment,
  };
}
