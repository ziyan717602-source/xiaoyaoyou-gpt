export type BotActionKind = "play" | "pass" | "counter" | "rescue";

export interface BotAction {
  readonly id: string;
  readonly kind: BotActionKind;
}

export interface BotContext {
  readonly turn: number;
  readonly playerId: string;
}

export interface StrategyBot {
  readonly name: string;
  choose(actions: readonly BotAction[], context: BotContext): BotAction;
}

function sorted(actions: readonly BotAction[]): BotAction[] {
  if (actions.length === 0)
    throw new Error("A bot requires at least one available action.");
  return [...actions].sort((left, right) => left.id.localeCompare(right.id));
}

function prefer(actions: readonly BotAction[], kind: BotActionKind): BotAction {
  const ordered = sorted(actions);
  return ordered.find((action) => action.kind === kind) ?? ordered[0]!;
}

export const FirstLegalBot: StrategyBot = {
  name: "FirstLegalBot",
  choose: (actions) => sorted(actions)[0]!,
};

export const AlwaysPassBot: StrategyBot = {
  name: "AlwaysPassBot",
  choose: (actions) => prefer(actions, "pass"),
};

export const CounterHappyBot: StrategyBot = {
  name: "CounterHappyBot",
  choose: (actions) => prefer(actions, "counter"),
};

export const RescueBot: StrategyBot = {
  name: "RescueBot",
  choose: (actions) => prefer(actions, "rescue"),
};

export function createSeededRandomBot(seed: number): StrategyBot {
  let state = seed >>> 0;
  return {
    name: "SeededRandomBot",
    choose(actions) {
      const ordered = sorted(actions);
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ordered[(state >>> 0) % ordered.length]!;
    },
  };
}

export interface ChaosChoice {
  readonly action: BotAction;
  readonly mutation:
    "duplicate" | "stale-version" | "forbidden-player" | "none";
}

export const ProtocolChaosBot = {
  name: "ProtocolChaosBot",
  choose(actions: readonly BotAction[], context: BotContext): ChaosChoice {
    const mutations: readonly ChaosChoice["mutation"][] = [
      "duplicate",
      "stale-version",
      "forbidden-player",
      "none",
    ];
    return {
      action: sorted(actions)[context.turn % actions.length]!,
      mutation: mutations[context.turn % mutations.length]!,
    };
  },
};
