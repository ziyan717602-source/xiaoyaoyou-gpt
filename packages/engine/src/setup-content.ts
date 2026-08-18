export type HeroId = `xyy.hero.${string}`;
export type SkillId = `xyy.skill.${string}`;
export type CardId = `xyy.card.${string}`;
export type CardInstanceId = `${CardId}@${number}`;

export interface HeroDefinition {
  readonly id: HeroId;
  readonly name: string;
  readonly maxHp: number;
  readonly strength: number;
  readonly dexterity: number;
  readonly gender: "M" | "F";
  readonly selectable: boolean;
}

export type EquipmentSlot = "weapon" | "armor";
export type CoreCardAction =
  | { readonly type: "equip"; readonly slot: EquipmentSlot }
  | { readonly type: "steal-one" }
  | { readonly type: "discard-one" }
  | { readonly type: "draw-two" }
  | { readonly type: "damage-two"; readonly element: "thunder" }
  | { readonly type: "heal-two" }
  | { readonly type: "heal-team-one"; readonly element: "water" }
  | { readonly type: "cancel-effect" }
  | { readonly type: "prevent-damage" }
  | null;

export type RescueCardAction = { readonly type: "rescue-two" } | null;
export type AlternateCardAction =
  { readonly type: "pawn-draw-one" } | { readonly type: "pawn-draw-two" };

export interface CardDefinition {
  readonly id: CardId;
  readonly name: string;
  readonly coreAction: CoreCardAction;
  readonly rescueAction?: RescueCardAction;
  readonly alternateActions?: readonly AlternateCardAction[];
}

// Values are the scoped Hero rows for legacy level 4 (packages 1 + 2).
export const SETUP_HEROES: readonly HeroDefinition[] = [
  {
    id: "xyy.hero.x3w01",
    name: "南宫煌",
    maxHp: 9,
    strength: 4,
    dexterity: 2,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.x3w02",
    name: "温慧",
    maxHp: 11,
    strength: 2,
    dexterity: 4,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.x3w03",
    name: "星璇",
    maxHp: 7,
    strength: 2,
    dexterity: 5,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.x3w04",
    name: "王蓬絮",
    maxHp: 6,
    strength: 1,
    dexterity: 4,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj101",
    name: "李逍遥",
    maxHp: 8,
    strength: 4,
    dexterity: 3,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj102",
    name: "赵灵儿",
    maxHp: 7,
    strength: 3,
    dexterity: 4,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj103",
    name: "赵灵儿·梦蛇",
    maxHp: 7,
    strength: 4,
    dexterity: 5,
    gender: "F",
    selectable: false,
  },
  {
    id: "xyy.hero.xj104",
    name: "林月如",
    maxHp: 9,
    strength: 2,
    dexterity: 5,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj105",
    name: "阿奴",
    maxHp: 5,
    strength: 4,
    dexterity: 2,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj106",
    name: "酒剑仙",
    maxHp: 8,
    strength: 5,
    dexterity: 1,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj107",
    name: "拜月教主",
    maxHp: 8,
    strength: 3,
    dexterity: 3,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj201",
    name: "王小虎",
    maxHp: 11,
    strength: 2,
    dexterity: 3,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj202",
    name: "苏媚",
    maxHp: 6,
    strength: 3,
    dexterity: 3,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj203",
    name: "沈欺霜",
    maxHp: 6,
    strength: 3,
    dexterity: 2,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj206",
    name: "孔璘",
    maxHp: 10,
    strength: 4,
    dexterity: 2,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj207",
    name: "魔尊",
    maxHp: 5,
    strength: 8,
    dexterity: 2,
    gender: "M",
    selectable: false,
  },
  {
    id: "xyy.hero.xj302",
    name: "唐雪见",
    maxHp: 6,
    strength: 2,
    dexterity: 4,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj303",
    name: "龙葵·蓝",
    maxHp: 6,
    strength: 2,
    dexterity: 5,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj304",
    name: "龙葵·红",
    maxHp: 6,
    strength: 5,
    dexterity: 1,
    gender: "F",
    selectable: false,
  },
  {
    id: "xyy.hero.xj305",
    name: "紫萱",
    maxHp: 5,
    strength: 3,
    dexterity: 4,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj306",
    name: "重楼",
    maxHp: 12,
    strength: 5,
    dexterity: 1,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj401",
    name: "云天河",
    maxHp: 8,
    strength: 2,
    dexterity: 6,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj402",
    name: "韩菱纱",
    maxHp: 7,
    strength: 2,
    dexterity: 4,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj403",
    name: "柳梦璃",
    maxHp: 7,
    strength: 3,
    dexterity: 3,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj404",
    name: "慕容紫英",
    maxHp: 7,
    strength: 4,
    dexterity: 1,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj405",
    name: "玄霄",
    maxHp: 6,
    strength: 5,
    dexterity: 2,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj501",
    name: "姜云凡",
    maxHp: 8,
    strength: 3,
    dexterity: 3,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj502",
    name: "唐雨柔",
    maxHp: 7,
    strength: 4,
    dexterity: 2,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj503",
    name: "龙幽",
    maxHp: 6,
    strength: 2,
    dexterity: 5,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj504",
    name: "小蛮",
    maxHp: 7,
    strength: 1,
    dexterity: 4,
    gender: "F",
    selectable: true,
  },
  {
    id: "xyy.hero.xj505",
    name: "姜世离",
    maxHp: 6,
    strength: 6,
    dexterity: 0,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj506",
    name: "魔翳",
    maxHp: 10,
    strength: 3,
    dexterity: 3,
    gender: "M",
    selectable: true,
  },
  {
    id: "xyy.hero.xj507",
    name: "湮世穹兵",
    maxHp: 6,
    strength: 6,
    dexterity: 6,
    gender: "M",
    selectable: false,
  },
  {
    id: "xyy.hero.xj508",
    name: "欧阳慧",
    maxHp: 5,
    strength: 4,
    dexterity: 2,
    gender: "F",
    selectable: true,
  },
] as const;

// The legacy Hero -> Skill ownership graph is static content, not mutable match
// state. Keep the complete scoped graph here so every runtime skill lookup has a
// single deterministic source and can be checked against the generated catalog.
export const HERO_SKILL_IDS = {
  "xyy.hero.x3w01": ["xyy.skill.jn40101", "xyy.skill.jn40102"],
  "xyy.hero.x3w02": ["xyy.skill.jn40201", "xyy.skill.jn40202"],
  "xyy.hero.x3w03": ["xyy.skill.jn40301", "xyy.skill.jn40302"],
  "xyy.hero.x3w04": [
    "xyy.skill.jn40401",
    "xyy.skill.jn40402",
    "xyy.skill.jn40403",
  ],
  "xyy.hero.xj101": ["xyy.skill.jn10101", "xyy.skill.jn10102"],
  "xyy.hero.xj102": ["xyy.skill.jn10201", "xyy.skill.jn10202"],
  "xyy.hero.xj103": [
    "xyy.skill.jn10201",
    "xyy.skill.jn10302",
    "xyy.skill.jn10303",
  ],
  "xyy.hero.xj104": ["xyy.skill.jn10401", "xyy.skill.jn10402"],
  "xyy.hero.xj105": ["xyy.skill.jn10501", "xyy.skill.jn10502"],
  "xyy.hero.xj106": ["xyy.skill.jn10601", "xyy.skill.jn10602"],
  "xyy.hero.xj107": ["xyy.skill.jn10701", "xyy.skill.jn10702"],
  "xyy.hero.xj201": ["xyy.skill.jn20101", "xyy.skill.jn20102"],
  "xyy.hero.xj202": ["xyy.skill.jn20201", "xyy.skill.jn20202"],
  "xyy.hero.xj203": ["xyy.skill.jn20301", "xyy.skill.jn20302"],
  "xyy.hero.xj206": ["xyy.skill.jn20601", "xyy.skill.jn20602"],
  "xyy.hero.xj207": ["xyy.skill.jn20701", "xyy.skill.jn20702"],
  "xyy.hero.xj302": [
    "xyy.skill.jn30201",
    "xyy.skill.jn30202",
    "xyy.skill.jn30203",
  ],
  "xyy.hero.xj303": [
    "xyy.skill.jn30301",
    "xyy.skill.jn30302",
    "xyy.skill.jn30303",
  ],
  "xyy.hero.xj304": [
    "xyy.skill.jn30401",
    "xyy.skill.jn30402",
    "xyy.skill.jn30403",
  ],
  "xyy.hero.xj305": ["xyy.skill.jn30501", "xyy.skill.jn30502"],
  "xyy.hero.xj306": [
    "xyy.skill.jn30601",
    "xyy.skill.jn30602",
    "xyy.skill.jn30603",
  ],
  "xyy.hero.xj401": ["xyy.skill.jn50101", "xyy.skill.jn50102"],
  "xyy.hero.xj402": [
    "xyy.skill.jn50201",
    "xyy.skill.jn50202",
    "xyy.skill.jn50203",
  ],
  "xyy.hero.xj403": ["xyy.skill.jn50301", "xyy.skill.jn50302"],
  "xyy.hero.xj404": ["xyy.skill.jn50401", "xyy.skill.jn50402"],
  "xyy.hero.xj405": ["xyy.skill.jn50501", "xyy.skill.jn50502"],
  "xyy.hero.xj501": ["xyy.skill.jn60101", "xyy.skill.jn60102"],
  "xyy.hero.xj502": ["xyy.skill.jn60201", "xyy.skill.jn60202"],
  "xyy.hero.xj503": ["xyy.skill.jn60301", "xyy.skill.jn60302"],
  "xyy.hero.xj504": [
    "xyy.skill.jn60401",
    "xyy.skill.jn60402",
    "xyy.skill.jn60403",
  ],
  "xyy.hero.xj505": ["xyy.skill.jn60501", "xyy.skill.jn60502"],
  "xyy.hero.xj506": ["xyy.skill.jn60601", "xyy.skill.jn60602"],
  "xyy.hero.xj507": ["xyy.skill.jn60701", "xyy.skill.jn60702"],
  "xyy.hero.xj508": [
    "xyy.skill.jn60801",
    "xyy.skill.jn60802",
    "xyy.skill.jn60803",
  ],
} as const satisfies Readonly<Record<HeroId, readonly SkillId[]>>;

export function skillIdsForHero(heroId: HeroId): readonly SkillId[] {
  const skillIds = (
    HERO_SKILL_IDS as Readonly<Record<string, readonly SkillId[]>>
  )[heroId];
  if (skillIds === undefined) throw new Error(`Unknown setup hero ${heroId}.`);
  return skillIds;
}

export function heroHasSkill(heroId: HeroId, skillId: SkillId): boolean {
  return skillIdsForHero(heroId).includes(skillId);
}

export function handLimitForHero(heroId: HeroId): number {
  return heroHasSkill(heroId, "xyy.skill.jn50402") ? 5 : 3;
}

const CARD_SERIALS: Readonly<Record<CardId, readonly number[]>> = {
  "xyy.card.jp01": [1, 2],
  "xyy.card.jp02": [3, 4],
  "xyy.card.jp03": [5, 6],
  "xyy.card.jp04": [7, 8, 9],
  "xyy.card.jp05": [10, 11, 12],
  "xyy.card.jp06": [13, 14, 15],
  "xyy.card.zp01": [16, 17],
  "xyy.card.zp02": [18, 19],
  "xyy.card.zp03": [20, 21, 22, 23, 24],
  "xyy.card.zp04": [25, 26, 27, 28, 29, 30, 31, 32],
  "xyy.card.tp01": [33, 34, 35],
  "xyy.card.tp02": [36, 37, 38],
  "xyy.card.tp03": [39, 40, 41, 42],
  "xyy.card.tp04": [43, 44, 45, 46],
  "xyy.card.wq01": [47],
  "xyy.card.wq02": [48],
  "xyy.card.wq03": [49],
  "xyy.card.wq04": [50],
  "xyy.card.wq05": [51],
  "xyy.card.fj01": [52],
  "xyy.card.fj02": [53],
  "xyy.card.fj03": [54],
  "xyy.card.fj04": [55],
  "xyy.card.fj05": [56],
};

export const SETUP_CARDS: readonly CardDefinition[] = [
  { id: "xyy.card.jp01", name: "偷盗", coreAction: { type: "steal-one" } },
  { id: "xyy.card.jp02", name: "窥测天机", coreAction: null },
  {
    id: "xyy.card.jp03",
    name: "五气朝元",
    coreAction: { type: "heal-team-one", element: "water" },
    alternateActions: [{ type: "pawn-draw-one" }],
  },
  { id: "xyy.card.jp04", name: "鼠儿果", coreAction: { type: "draw-two" } },
  {
    id: "xyy.card.jp05",
    name: "天雷破",
    coreAction: { type: "damage-two", element: "thunder" },
  },
  {
    id: "xyy.card.jp06",
    name: "铜钱镖",
    coreAction: { type: "discard-one" },
  },
  { id: "xyy.card.zp01", name: "金蝉脱壳", coreAction: null },
  { id: "xyy.card.zp02", name: "天罡战气", coreAction: null },
  { id: "xyy.card.zp03", name: "金蚕王", coreAction: null },
  { id: "xyy.card.zp04", name: "天玄五音", coreAction: null },
  {
    id: "xyy.card.tp01",
    name: "冰心诀",
    coreAction: { type: "cancel-effect" },
  },
  {
    id: "xyy.card.tp02",
    name: "灵葫仙丹",
    coreAction: { type: "heal-two" },
    rescueAction: { type: "rescue-two" },
  },
  {
    id: "xyy.card.tp03",
    name: "隐蛊",
    coreAction: { type: "prevent-damage" },
  },
  { id: "xyy.card.tp04", name: "洞冥宝镜", coreAction: null },
  {
    id: "xyy.card.wq01",
    name: "无尘剑",
    coreAction: { type: "equip", slot: "weapon" },
  },
  {
    id: "xyy.card.wq02",
    name: "天蛇杖",
    coreAction: { type: "equip", slot: "weapon" },
  },
  {
    id: "xyy.card.wq03",
    name: "魔刀天叱",
    coreAction: { type: "equip", slot: "weapon" },
  },
  {
    id: "xyy.card.wq04",
    name: "魔剑",
    coreAction: { type: "equip", slot: "weapon" },
    alternateActions: [{ type: "pawn-draw-two" }],
  },
  {
    id: "xyy.card.wq05",
    name: "彩环",
    coreAction: { type: "equip", slot: "weapon" },
  },
  {
    id: "xyy.card.fj01",
    name: "五彩霞衣",
    coreAction: { type: "equip", slot: "armor" },
  },
  {
    id: "xyy.card.fj02",
    name: "天帝祭服",
    coreAction: { type: "equip", slot: "armor" },
  },
  {
    id: "xyy.card.fj03",
    name: "龙魂战铠",
    coreAction: { type: "equip", slot: "armor" },
  },
  {
    id: "xyy.card.fj04",
    name: "乾坤道袍",
    coreAction: { type: "equip", slot: "armor" },
  },
  {
    id: "xyy.card.fj05",
    name: "踏云靴",
    coreAction: { type: "equip", slot: "armor" },
  },
] as const;

export const SETUP_CARD_INSTANCES: readonly CardInstanceId[] = Object.entries(
  CARD_SERIALS,
).flatMap(([cardId, serials]) =>
  serials.map((serial) => `${cardId as CardId}@${serial}` as CardInstanceId),
);

export const SELECTABLE_HEROES = SETUP_HEROES.filter((hero) => hero.selectable);

export function heroDefinition(heroId: HeroId): HeroDefinition {
  const hero = SETUP_HEROES.find((candidate) => candidate.id === heroId);
  if (hero === undefined) throw new Error(`Unknown setup hero ${heroId}.`);
  return hero;
}

export function cardIdOf(instanceId: string): CardId {
  const separator = instanceId.lastIndexOf("@");
  if (separator <= 0) throw new Error(`Invalid card instance ${instanceId}.`);
  return instanceId.slice(0, separator) as CardId;
}

export function cardDefinition(instanceId: string): CardDefinition {
  const cardId = cardIdOf(instanceId);
  const card = SETUP_CARDS.find((candidate) => candidate.id === cardId);
  if (card === undefined) throw new Error(`Unknown card ${cardId}.`);
  return card;
}
