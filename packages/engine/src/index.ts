import type {
  ChoiceId,
  EffectId,
  MatchId,
  PlayerId,
  WindowId,
} from "@xiaoyaoyou/protocol";

export const MATCH_SCHEMA_VERSION = 1 as const;

export type MatchPhase = "lobby" | "setup" | "playing" | "finished";

export interface PlayerState {
  readonly id: PlayerId;
  readonly seat: number;
  readonly nickname: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly hand: readonly string[];
}

export interface EffectFrame {
  readonly effectId: EffectId;
  readonly parentEffectId: EffectId | null;
  readonly kind: string;
  readonly sourcePlayerId: PlayerId | null;
  readonly targetIds: readonly string[];
  readonly step: string;
  readonly status: "pending" | "resolving" | "cancelled" | "resolved";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ReactionWindow {
  readonly windowId: WindowId;
  readonly effectId: EffectId;
  readonly eligiblePlayerIds: readonly PlayerId[];
  readonly priorityIndex: number;
  readonly passedPlayerIds: readonly PlayerId[];
  readonly continuationStep: string;
}

export interface PendingChoice {
  readonly choiceId: ChoiceId;
  readonly playerIds: readonly PlayerId[];
  readonly prompt: string;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly optionIds: readonly string[];
  readonly continuationStep: string;
}

export interface RngState {
  readonly seed: string;
  readonly cursor: number;
}

export interface MatchState {
  readonly schemaVersion: typeof MATCH_SCHEMA_VERSION;
  readonly rulesetVersion: string;
  readonly matchId: MatchId;
  readonly version: number;
  readonly phase: MatchPhase;
  readonly activePlayerId: PlayerId | null;
  readonly players: Readonly<Record<PlayerId, PlayerState>>;
  readonly effectStack: readonly EffectFrame[];
  readonly reactionWindow: ReactionWindow | null;
  readonly pendingChoice: PendingChoice | null;
  readonly rng: RngState;
}

export interface CreateMatchInput {
  readonly matchId: MatchId;
  readonly rulesetVersion: string;
  readonly seed: string;
  readonly players: readonly {
    readonly id: PlayerId;
    readonly nickname: string;
  }[];
}

export interface PublicPlayerView {
  readonly id: PlayerId;
  readonly seat: number;
  readonly nickname: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly handCount: number;
  readonly hand: readonly string[] | null;
}

export interface PlayerView {
  readonly matchId: MatchId;
  readonly version: number;
  readonly phase: MatchPhase;
  readonly activePlayerId: PlayerId | null;
  readonly players: readonly PublicPlayerView[];
  readonly effectStack: readonly EffectFrame[];
  readonly reactionWindow: ReactionWindow | null;
  readonly pendingChoice: PendingChoice | null;
}

export function createInitialMatch(input: CreateMatchInput): MatchState {
  if (input.players.length === 0) {
    throw new Error("A match requires at least one player.");
  }

  const players = Object.fromEntries(
    input.players.map((player, seat) => [
      player.id,
      {
        id: player.id,
        seat,
        nickname: player.nickname,
        hp: 0,
        maxHp: 0,
        hand: [],
      } satisfies PlayerState,
    ]),
  );

  return {
    schemaVersion: MATCH_SCHEMA_VERSION,
    rulesetVersion: input.rulesetVersion,
    matchId: input.matchId,
    version: 0,
    phase: "lobby",
    activePlayerId: null,
    players,
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    rng: { seed: input.seed, cursor: 0 },
  };
}

export function createPlayerView(
  state: MatchState,
  viewerId: PlayerId,
): PlayerView {
  if (!(viewerId in state.players)) {
    throw new Error(`Unknown viewer: ${viewerId}`);
  }

  return {
    matchId: state.matchId,
    version: state.version,
    phase: state.phase,
    activePlayerId: state.activePlayerId,
    players: Object.values(state.players)
      .sort((left, right) => left.seat - right.seat)
      .map((player) => ({
        id: player.id,
        seat: player.seat,
        nickname: player.nickname,
        hp: player.hp,
        maxHp: player.maxHp,
        handCount: player.hand.length,
        hand: player.id === viewerId ? player.hand : null,
      })),
    effectStack: state.effectStack,
    reactionWindow: state.reactionWindow,
    pendingChoice:
      state.pendingChoice?.playerIds.includes(viewerId) === true
        ? state.pendingChoice
        : null,
  };
}
