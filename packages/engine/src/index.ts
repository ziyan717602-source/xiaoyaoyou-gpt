import type {
  ChoiceId,
  ContinuationId,
  EffectId,
  MatchId,
  PlayerId,
  WindowId,
} from "@xiaoyaoyou/protocol";
import { PROTOCOL_VERSION } from "@xiaoyaoyou/protocol";

export const MATCH_SCHEMA_VERSION = 1 as const;
export const PERSISTENCE_VERSION = 1 as const;

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
  readonly status:
    "pending" | "waiting" | "resolving" | "cancelled" | "resolved" | "fizzled";
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface Continuation {
  readonly continuationId: ContinuationId;
  readonly effectId: EffectId;
  readonly step: string;
  readonly locals: Readonly<Record<string, unknown>>;
  readonly resumeWith: string;
}

export interface ReactionWindow {
  readonly windowId: WindowId;
  readonly effectId: EffectId;
  readonly parentWindowId: WindowId | null;
  readonly eligiblePlayerIds: readonly PlayerId[];
  readonly priorityOrder: readonly PlayerId[];
  readonly priorityIndex: number;
  readonly passedPlayerIds: readonly PlayerId[];
  readonly status: "open" | "closed" | "expired";
  readonly openedAt: number;
  readonly deadlineAt: number;
  readonly continuation: Continuation;
}

export interface PendingChoice {
  readonly choiceId: ChoiceId;
  readonly playerIds: readonly PlayerId[];
  readonly prompt: string;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly optionIds: readonly string[];
  readonly optional: boolean;
  readonly status: "open" | "closed" | "expired";
  readonly openedAt: number;
  readonly deadlineAt: number;
  readonly fallback: "pass" | "deterministic-random";
  readonly continuation: Continuation;
}

export interface RngState {
  readonly algorithm: "sha256-counter-v1";
  readonly seed: string;
  readonly cursor: number;
}

export interface MatchState {
  readonly schemaVersion: typeof MATCH_SCHEMA_VERSION;
  readonly persistenceVersion: typeof PERSISTENCE_VERSION;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
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
    persistenceVersion: PERSISTENCE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    rulesetVersion: input.rulesetVersion,
    matchId: input.matchId,
    version: 0,
    phase: "lobby",
    activePlayerId: null,
    players,
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    rng: { algorithm: "sha256-counter-v1", seed: input.seed, cursor: 0 },
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

export const projectPlayerView = createPlayerView;

export function resume(state: MatchState):
  | { readonly status: "resolved"; readonly state: MatchState }
  | {
      readonly status: "pending-choice";
      readonly state: MatchState;
      readonly pendingChoice: PendingChoice;
    }
  | {
      readonly status: "reaction-window";
      readonly state: MatchState;
      readonly reactionWindow: ReactionWindow;
    }
  | { readonly status: "game-over"; readonly state: MatchState } {
  if (state.phase === "finished") {
    return { status: "game-over", state };
  }
  if (state.pendingChoice !== null) {
    return {
      status: "pending-choice",
      state,
      pendingChoice: state.pendingChoice,
    };
  }
  if (state.reactionWindow !== null) {
    return {
      status: "reaction-window",
      state,
      reactionWindow: state.reactionWindow,
    };
  }
  return { status: "resolved", state };
}

export type {
  ApplyCommandResult,
  DomainEvent,
  EngineApi,
  EngineCommand,
  ResumeResult,
} from "./architecture.js";
