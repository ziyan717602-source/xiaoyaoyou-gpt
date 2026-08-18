export type HeroId = `xyy.hero.${string}`;
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
  | { readonly type: "draw-two" }
  | { readonly type: "damage-two"; readonly element: "thunder" }
  | { readonly type: "cancel-effect" }
  | { readonly type: "rescue-two" }
  | null;

export interface CardDefinition {
  readonly id: CardId;
  readonly name: string;
  readonly coreAction: CoreCardAction;
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
  { id: "xyy.card.jp01", name: "偷盗", coreAction: null },
  { id: "xyy.card.jp02", name: "窥测天机", coreAction: null },
  { id: "xyy.card.jp03", name: "五气朝元", coreAction: null },
  { id: "xyy.card.jp04", name: "鼠儿果", coreAction: { type: "draw-two" } },
  {
    id: "xyy.card.jp05",
    name: "天雷破",
    coreAction: { type: "damage-two", element: "thunder" },
  },
  { id: "xyy.card.jp06", name: "铜钱镖", coreAction: null },
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
    coreAction: { type: "rescue-two" },
  },
  { id: "xyy.card.tp03", name: "隐蛊", coreAction: null },
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
