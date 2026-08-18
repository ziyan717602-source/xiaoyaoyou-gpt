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

export const HP_EVOLUTION_FLAG_ORDER: readonly HpEvolutionFlag[] = [
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

export function isHpEvolutionFlag(value: unknown): value is HpEvolutionFlag {
  return (
    typeof value === "string" &&
    HP_EVOLUTION_FLAG_ORDER.includes(value as HpEvolutionFlag)
  );
}

export function canonicalHpEvolutionMask(
  flags: readonly HpEvolutionFlag[] | undefined,
): readonly HpEvolutionFlag[] {
  if (flags === undefined) return [];
  const requested = new Set(flags);
  if (requested.size !== flags.length) {
    throw new Error("HP evolution flags must not contain duplicates.");
  }
  for (const flag of requested) {
    if (!isHpEvolutionFlag(flag)) {
      throw new Error(`Unknown HP evolution flag ${flag}.`);
    }
  }
  return HP_EVOLUTION_FLAG_ORDER.filter((flag) => requested.has(flag));
}

export function isCanonicalHpEvolutionMask(
  value: unknown,
): value is readonly HpEvolutionFlag[] {
  if (!Array.isArray(value) || value.some((flag) => !isHpEvolutionFlag(flag))) {
    return false;
  }
  try {
    return (
      JSON.stringify(value) ===
      JSON.stringify(canonicalHpEvolutionMask(value as HpEvolutionFlag[]))
    );
  } catch {
    return false;
  }
}

export function hasHpEvolutionFlag(
  mask: readonly HpEvolutionFlag[],
  flag: HpEvolutionFlag,
): boolean {
  return mask.includes(flag);
}
