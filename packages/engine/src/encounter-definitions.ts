import type { HeroId } from "./setup-content.js";
import type { EncounterCardId, MonsterId, NpcId } from "./encounter-content.js";

export type NpcActionId =
  `xyy.npc-action.nj0${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export type PetElement = "water" | "fire" | "thunder" | "wind" | "earth";
export interface MonsterDefinition {
  readonly id: MonsterId;
  readonly kind: "monster";
  readonly name: string;
  readonly strength: number;
  readonly agility: number;
  readonly level: 1 | 2 | 3;
  readonly element: PetElement;
}
export interface NpcDefinition {
  readonly id: NpcId;
  readonly kind: "npc";
  readonly name: string;
  readonly strength: number;
  readonly heroId: HeroId;
  readonly actionIds: readonly NpcActionId[];
}
export type EncounterDefinition = MonsterDefinition | NpcDefinition;

function monster(
  code: string,
  name: string,
  strength: number,
  agility: number,
  level: 1 | 2 | 3,
  element: PetElement,
): MonsterDefinition {
  return Object.freeze({
    id: `xyy.monster.${code}`,
    kind: "monster",
    name,
    strength,
    agility,
    level,
    element,
  });
}
function npc(
  code: string,
  name: string,
  strength: number,
  hero: string,
  actions: readonly (1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9)[],
): NpcDefinition {
  return Object.freeze({
    id: `xyy.npc.${code}`,
    kind: "npc",
    name,
    strength,
    heroId: `xyy.hero.${hero}`,
    actionIds: Object.freeze(
      actions.map((n): NpcActionId => `xyy.npc-action.nj0${n}`),
    ),
  });
}

// Factual identity/stat metadata from the scoped SQLite rows. Having a definition
// is NOT evidence that the card's debut, win/loss or pet effects are implemented.
export const ENCOUNTER_DEFINITIONS: readonly EncounterDefinition[] =
  Object.freeze([
    monster("gs01", "千杯不醉", 4, 4, 1, "water"),
    monster("gs02", "勇气", 4, 5, 1, "water"),
    monster("gs03", "蛇妖男", 9, 2, 2, "water"),
    monster("gs04", "水魔兽", 7, 6, 3, "water"),
    monster("gh01", "赝月", 4, 1, 1, "fire"),
    monster("gh02", "肥肥", 2, 5, 1, "fire"),
    monster("gh03", "狐妖女", 6, 1, 2, "fire"),
    monster("gh04", "熔岩兽王", 10, 2, 3, "fire"),
    monster("gl01", "积粮隐者", 3, 3, 1, "thunder"),
    monster("gl02", "赤鬼王", 8, 5, 2, "thunder"),
    monster("gl03", "毒娘子", 7, 5, 3, "thunder"),
    monster("gl04", "邪剑仙", 11, 3, 3, "thunder"),
    monster("gf01", "叶灵", 2, 2, 1, "wind"),
    monster("gf02", "暗香", 4, 6, 1, "wind"),
    monster("gf03", "句芒", 7, 4, 2, "wind"),
    monster("gf04", "彩依", 6, 4, 3, "wind"),
    monster("gt01", "璇龟", 5, 2, 1, "earth"),
    monster("gt02", "刑天", 5, 3, 1, "earth"),
    monster("gt03", "金蟾鬼母", 4, 4, 2, "earth"),
    monster("gt04", "天鬼皇", 10, 2, 3, "earth"),
    npc("nc101", "李逍遥", 4, "xj101", [1, 9]),
    npc("nc102", "赵灵儿", 3, "xj102", [1, 9]),
    npc("nc103", "赵灵儿·梦蛇", 4, "xj103", [7, 9]),
    npc("nc104", "林月如", 2, "xj104", [1, 6]),
    npc("nc105", "阿奴", 4, "xj105", [1, 9]),
    npc("nc106", "酒剑仙", 5, "xj106", [1, 4]),
    npc("nc107", "拜月教主", 3, "xj107", [1, 7]),
    npc("nc201", "王小虎", 2, "xj201", [1, 3]),
    npc("nc202", "苏媚", 3, "xj202", [1, 5]),
    npc("nc203", "沈欺霜", 3, "xj203", [1, 2]),
    npc("nc206", "孔璘", 4, "xj206", [1, 5]),
    npc("nc207", "魔尊", 8, "xj207", [4, 5]),
    npc("nc302", "唐雪见", 2, "xj302", [1, 6]),
    npc("nc305", "紫萱", 3, "xj305", [1, 2]),
    npc("nc306", "重楼", 5, "xj306", [1, 9]),
    npc("n3w01", "南宫煌", 4, "x3w01", [1, 7]),
    npc("n3w02", "温慧", 2, "x3w02", [1, 9]),
    npc("n3w03", "星璇", 2, "x3w03", [1, 2]),
    npc("n3w04", "王蓬絮", 1, "x3w04", [1, 2]),
    npc("nc401", "云天河", 2, "xj401", [1, 9]),
    npc("nc402", "韩菱纱", 2, "xj402", [1, 8]),
    npc("nc403", "柳梦璃", 3, "xj403", [1, 7]),
    npc("nc404", "慕容紫英", 4, "xj404", [1, 3]),
    npc("nc405", "玄霄", 5, "xj405", [1, 4]),
    npc("nc503", "龙幽", 2, "xj503", [1, 9]),
    npc("nc504", "小蛮", 1, "xj504", [1, 8]),
  ]);
const byId = new Map(
  ENCOUNTER_DEFINITIONS.map((definition) => [definition.id, definition]),
);
export function encounterDefinition(id: EncounterCardId): EncounterDefinition {
  const definition = byId.get(id);
  if (definition === undefined) throw new Error("Unknown encounter card.");
  return definition;
}
