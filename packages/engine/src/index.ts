import type {
  ChoiceId,
  ContinuationId,
  EffectId,
  MatchId,
  PlayerId,
  WindowId,
} from "@xiaoyaoyou/protocol";
import { PROTOCOL_VERSION } from "@xiaoyaoyou/protocol";
import type { CardInstanceId, HeroId } from "./setup-content.js";

export const MATCH_SCHEMA_VERSION = 2 as const;
export const PERSISTENCE_VERSION = 1 as const;

export type MatchPhase = "lobby" | "setup" | "playing" | "finished";
export type TeamId = 1 | 2;

export interface HeroOffer {
  readonly candidateHeroIds: readonly HeroId[];
  readonly replacementHeroId: HeroId;
  readonly replacementIndex: number;
  readonly rerolled: boolean;
  readonly selectedHeroId: HeroId | null;
}

export interface SetupState {
  readonly status: "selecting-heroes" | "completed";
  readonly seedCommitment: string;
  readonly offers: Readonly<Record<PlayerId, HeroOffer>>;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly seat: number;
  readonly nickname: string;
  readonly turnIndex: number | null;
  readonly team: TeamId | null;
  readonly heroId: HeroId | null;
  readonly alive: boolean;
  readonly hp: number;
  readonly maxHp: number;
  readonly strength: number;
  readonly dexterity: number;
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
  readonly eventSequence: number;
  readonly phase: MatchPhase;
  readonly activePlayerId: PlayerId | null;
  readonly turnOrder: readonly PlayerId[];
  readonly players: Readonly<Record<PlayerId, PlayerState>>;
  readonly drawPile: readonly CardInstanceId[];
  readonly discardPile: readonly CardInstanceId[];
  readonly setup: SetupState | null;
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
  readonly turnIndex: number | null;
  readonly team: TeamId | null;
  readonly heroId: HeroId | null;
  readonly alive: boolean;
  readonly hp: number;
  readonly maxHp: number;
  readonly handCount: number;
  readonly hand: readonly string[] | null;
}

export interface SetupView {
  readonly status: SetupState["status"];
  readonly seedCommitment: string;
  readonly selectedPlayerIds: readonly PlayerId[];
  readonly ownOffer: {
    readonly candidateHeroIds: readonly HeroId[];
    readonly rerolled: boolean;
    readonly selectedHeroId: HeroId | null;
  } | null;
}

export type AvailableAction =
  | { readonly type: "choose-hero"; readonly heroIds: readonly HeroId[] }
  | { readonly type: "reroll-hero" };

export interface PlayerView {
  readonly matchId: MatchId;
  readonly version: number;
  readonly phase: MatchPhase;
  readonly activePlayerId: PlayerId | null;
  readonly players: readonly PublicPlayerView[];
  readonly setup: SetupView | null;
  readonly availableActions: readonly AvailableAction[];
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
        turnIndex: null,
        team: null,
        heroId: null,
        alive: false,
        hp: 0,
        maxHp: 0,
        strength: 0,
        dexterity: 0,
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
    eventSequence: 0,
    phase: "lobby",
    activePlayerId: null,
    turnOrder: [],
    players,
    drawPile: [],
    discardPile: [],
    setup: null,
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

  const ownOffer = state.setup?.offers[viewerId] ?? null;
  const canChoose =
    state.phase === "setup" && ownOffer?.selectedHeroId === null;
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
        turnIndex: player.turnIndex,
        team: player.team,
        heroId:
          state.phase !== "setup" || player.id === viewerId
            ? player.heroId
            : null,
        alive: player.alive,
        hp: player.hp,
        maxHp: player.maxHp,
        handCount: player.hand.length,
        hand: player.id === viewerId ? player.hand : null,
      })),
    setup:
      state.setup === null
        ? null
        : {
            status: state.setup.status,
            seedCommitment: state.setup.seedCommitment,
            selectedPlayerIds: Object.entries(state.setup.offers)
              .filter(([, offer]) => offer.selectedHeroId !== null)
              .map(([playerId]) => playerId),
            ownOffer:
              ownOffer === null
                ? null
                : {
                    candidateHeroIds: ownOffer.candidateHeroIds,
                    rerolled: ownOffer.rerolled,
                    selectedHeroId: ownOffer.selectedHeroId,
                  },
          },
    availableActions: canChoose
      ? [
          {
            type: "choose-hero",
            heroIds: ownOffer.candidateHeroIds,
          },
          ...(ownOffer.rerolled ? [] : [{ type: "reroll-hero" as const }]),
        ]
      : [],
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
export { applyCommand, createSetupMatch, reduceEvent } from "./setup.js";
export {
  SELECTABLE_HEROES,
  SETUP_CARD_INSTANCES,
  SETUP_HEROES,
  heroDefinition,
  type CardInstanceId,
  type HeroDefinition,
  type HeroId,
} from "./setup-content.js";
