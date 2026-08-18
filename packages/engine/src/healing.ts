import type { PlayerId } from "@xiaoyaoyou/protocol";
import type { MatchState, PlayerState } from "./index.js";
import { cardDefinition, type CardInstanceId } from "./setup-content.js";

export type HpEvolutionFlag =
  | "tux-inavo"
  | "immune-inavo"
  | "decr-inavo"
  | "chain-inavo"
  | "alive"
  | "alive-hard"
  | "termin-at"
  | "from-jp"
  | "from-sk"
  | "from-nmb"
  | "rsv-duel"
  | "rsv-worm";

const HP_EVOLUTION_FLAG_ORDER: readonly HpEvolutionFlag[] = [
  "tux-inavo",
  "immune-inavo",
  "decr-inavo",
  "chain-inavo",
  "alive",
  "alive-hard",
  "termin-at",
  "from-jp",
  "from-sk",
  "from-nmb",
  "rsv-duel",
  "rsv-worm",
];

export interface CureIntent {
  readonly itemId: string;
  readonly sourcePlayerId: PlayerId | null;
  readonly targetPlayerId: PlayerId;
  readonly amount: number;
  readonly element: string;
  /** Canonical names for the legacy C# HPEvoMask flags. */
  readonly hpEvoMask?: readonly HpEvolutionFlag[];
}

export interface AppliedCure {
  readonly itemId: string;
  readonly sourcePlayerId: PlayerId | null;
  readonly targetPlayerId: PlayerId;
  readonly baseAmount: number;
  readonly amount: number;
  readonly element: string;
  readonly hpEvoMask: readonly HpEvolutionFlag[];
  readonly hpBefore: number;
  readonly hpAfter: number;
  readonly appliedModifierCardInstanceIds: readonly CardInstanceId[];
}

function canonicalMask(
  flags: readonly HpEvolutionFlag[] | undefined,
): readonly HpEvolutionFlag[] {
  if (flags === undefined) return [];
  const requested = new Set(flags);
  if (requested.size !== flags.length) {
    throw new Error("HP evolution flags must not contain duplicates.");
  }
  for (const flag of requested) {
    if (!HP_EVOLUTION_FLAG_ORDER.includes(flag)) {
      throw new Error(`Unknown HP evolution flag ${flag}.`);
    }
  }
  return HP_EVOLUTION_FLAG_ORDER.filter((flag) => requested.has(flag));
}

function activeWq02(player: Readonly<PlayerState>): CardInstanceId | null {
  const weapon = player.equipment.weapon;
  return weapon !== null && cardDefinition(weapon).id === "xyy.card.wq02"
    ? weapon
    : null;
}

export function planCureBatch(
  state: Readonly<MatchState>,
  intents: readonly CureIntent[],
): readonly AppliedCure[] {
  const rollingHp = new Map<PlayerId, number>();
  return intents.map((intent) => {
    if (!Number.isSafeInteger(intent.amount) || intent.amount < 0) {
      throw new Error("Cure amount must be a nonnegative safe integer.");
    }
    const target = state.players[intent.targetPlayerId];
    if (target === undefined || !target.alive) {
      throw new Error(`Unknown or dead cure target ${intent.targetPlayerId}.`);
    }
    const hpEvoMask = canonicalMask(intent.hpEvoMask);
    let amount = intent.amount;
    const appliedModifierCardInstanceIds: CardInstanceId[] = [];
    const wq02 = activeWq02(target);
    if (amount > 0 && !hpEvoMask.includes("termin-at") && wq02 !== null) {
      amount += 1;
      appliedModifierCardInstanceIds.push(wq02);
    }
    const hpBefore = rollingHp.get(target.id) ?? target.hp;
    const hpAfter = Math.min(target.maxHp, hpBefore + amount);
    rollingHp.set(target.id, hpAfter);
    return {
      itemId: intent.itemId,
      sourcePlayerId: intent.sourcePlayerId,
      targetPlayerId: target.id,
      baseAmount: intent.amount,
      amount,
      element: intent.element,
      hpEvoMask,
      hpBefore,
      hpAfter,
      appliedModifierCardInstanceIds,
    };
  });
}

export function playersAfterCures(
  state: Readonly<MatchState>,
  items: readonly AppliedCure[],
): Readonly<Record<PlayerId, PlayerState>> {
  const players: Record<PlayerId, PlayerState> = { ...state.players };
  for (const item of items) {
    const target = players[item.targetPlayerId];
    if (
      target === undefined ||
      !target.alive ||
      target.hp !== item.hpBefore ||
      item.hpAfter !== Math.min(target.maxHp, target.hp + item.amount)
    ) {
      throw new Error("Applied cure disagrees with current HP.");
    }
    players[target.id] = { ...target, hp: item.hpAfter };
  }
  return players;
}
