import type {
  ChoiceId,
  ContinuationId,
  EffectId,
  MatchId,
  PlayerId,
  WindowId,
} from "@xiaoyaoyou/protocol";
import { PROTOCOL_VERSION } from "@xiaoyaoyou/protocol";
import {
  cardDefinition,
  cardIdOf,
  heroDefinition,
  heroHasSkill,
} from "./setup-content.js";
import type { CardInstanceId, HeroId } from "./setup-content.js";
import { createEncounterDecks } from "./encounter-content.js";
import type { EncounterCardId, NpcId } from "./encounter-content.js";

export const MATCH_SCHEMA_VERSION = 8 as const;
export const PERSISTENCE_VERSION = 1 as const;

export type MatchPhase = "lobby" | "setup" | "playing" | "finished";
export type TeamId = 1 | 2;
export type TurnPhase =
  | "turn-start"
  | "event"
  | "action"
  | "encounter"
  | "battle"
  | "reward"
  | "discard"
  | "turn-end";

export interface DiceRollState {
  readonly playerId: PlayerId;
  readonly value: number;
  readonly attempt: number;
  readonly rngCursorStart: number;
  readonly rngCursorEnd: number;
  readonly optionSetHash: string;
}

export interface DuelContinuation {
  readonly kind: "jn30601-duel";
  readonly sourceEffectId: EffectId;
  readonly ownerPlayerId: PlayerId;
  readonly targetPlayerIds: readonly PlayerId[];
  readonly currentTargetIndex: number;
  readonly stage:
    "rolling-owner" | "rolling-target" | "ready-damage" | "resolving-damage";
  readonly attempt: number;
  readonly ownerRoll: DiceRollState | null;
  readonly targetRoll: DiceRollState | null;
}

export interface TurnState {
  readonly number: number;
  readonly phase: TurnPhase;
  readonly openedAt: number;
  readonly deadlineAt: number;
  /** Skill ids already consumed for this turn; absent only on legacy snapshots. */
  readonly usedSkillIds?: readonly string[];
  /** Per-skill targets already visited this turn; omitted until a skill needs it. */
  readonly usedSkillTargetIds?: Readonly<Record<string, readonly PlayerId[]>>;
  /** Per-skill activation counts for repeatable skills with rising costs. */
  readonly usedSkillCounts?: Readonly<Record<string, number>>;
  /** Serialized per-target JN30601 dice, reroll and damage continuation. */
  readonly duelContinuation?: DuelContinuation;
  /** Serialized reward-phase continuation while JN10502 draws/damage resolve. */
  readonly rewardContinuation?: {
    readonly kind: "jn10502-damage";
    readonly step: "drawing-team" | "resolving-damage";
    readonly pendingTeamDrawPlayerIds: readonly PlayerId[];
  };
  /** Serialized turn-end continuation while mandatory JN20702 damage resolves. */
  readonly turnEndContinuation?: {
    readonly kind: "jn20702-damage";
    readonly step: "resolving-damage";
  };
}

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
  readonly openedAt: number;
  readonly deadlineAt: number;
  readonly offers: Readonly<Record<PlayerId, HeroOffer>>;
}

export interface PlayerConnectionState {
  readonly status: "connected" | "grace" | "auto";
  readonly disconnectedAt: number | null;
  readonly autoAt: number | null;
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
  readonly handLimit: number;
  readonly hand: readonly CardInstanceId[];
  readonly equipment: {
    readonly weapon: CardInstanceId | null;
    readonly armor: CardInstanceId | null;
  };
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

export interface DyingBatch {
  readonly batchId: string;
  readonly sourceEffectId: EffectId;
  readonly targetPlayerIds: readonly PlayerId[];
  readonly currentIndex: number;
  readonly currentTargetPlayerId: PlayerId;
  readonly priorityOrder: readonly PlayerId[];
  readonly priorityIndex: number;
  readonly passedPlayerIds: readonly PlayerId[];
  readonly rescuedPlayerIds: readonly PlayerId[];
  readonly deadPlayerIds: readonly PlayerId[];
  readonly status:
    | "awaiting-rescue"
    | "awaiting-death"
    | "after-death"
    | "awaiting-batch-cleanup"
    | "distributing-loot";
  readonly openedAt: number;
  readonly deadlineAt: number;
}

export interface RngState {
  readonly algorithm: "sha256-counter-v1";
  readonly seed: string;
  readonly cursor: number;
}

/** Private historical knowledge, not a live projection of the deck top. */
export interface EncounterInspection {
  readonly effectId: EffectId;
  readonly inspectedAt: number;
  readonly cardIds: readonly EncounterCardId[];
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
  readonly turn: TurnState | null;
  readonly winner: TeamId | "draw" | null;
  readonly turnOrder: readonly PlayerId[];
  readonly players: Readonly<Record<PlayerId, PlayerState>>;
  readonly connections: Readonly<Record<PlayerId, PlayerConnectionState>>;
  readonly drawPile: readonly CardInstanceId[];
  readonly discardPile: readonly CardInstanceId[];
  readonly encounterDeck: readonly EncounterCardId[];
  readonly encounterDiscard: readonly EncounterCardId[];
  readonly encounterInspections: Readonly<
    Partial<Record<PlayerId, EncounterInspection>>
  >;
  readonly reserveNpcDeck: readonly NpcId[];
  readonly reserveNpcDiscard: readonly NpcId[];
  readonly setup: SetupState | null;
  readonly effectStack: readonly EffectFrame[];
  readonly reactionWindow: ReactionWindow | null;
  readonly pendingChoice: PendingChoice | null;
  readonly dyingBatch: DyingBatch | null;
  readonly rng: RngState;
}

export interface CreateMatchInput {
  readonly matchId: MatchId;
  readonly rulesetVersion: string;
  readonly seed: string;
  readonly openedAt?: number;
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
  readonly strength: number;
  readonly dexterity: number;
  readonly handLimit: number;
  readonly handCount: number;
  readonly hand: readonly CardInstanceId[] | null;
  readonly equipment: {
    readonly weapon: CardInstanceId | null;
    readonly armor: CardInstanceId | null;
  };
  readonly connection: PlayerConnectionState;
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
  | { readonly type: "reroll-hero" }
  | {
      readonly type: "play-card";
      readonly cardInstanceId: CardInstanceId;
      readonly targetPlayerIds: readonly PlayerId[];
      readonly mode?: "primary" | "pawn";
    }
  | {
      readonly type: "play-skill-converted-card";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly requiredCardCount: 2;
      readonly skillId: "xyy.skill.jn40301";
      readonly targetPlayerIds: readonly PlayerId[];
    }
  | {
      readonly type: "play-skill-converted-card";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly requiredCardCount: 1;
      readonly skillId: "xyy.skill.jn50201";
      readonly convertedCardId: "xyy.card.jp01" | "xyy.card.jp06";
      readonly targetPlayerIds: readonly PlayerId[];
    }
  | {
      readonly type: "activate-hero-skill";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly requiredCardCount: 1;
      readonly skillId: "xyy.skill.jn50401";
      readonly targetPlayerIds: readonly PlayerId[];
      readonly requiredTargetCount: 1;
    }
  | {
      readonly type: "activate-hero-skill";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly minCardCount: 1;
      readonly maxCardCount: number;
      readonly skillId: "xyy.skill.jn10501";
      readonly targetPlayerIds: readonly PlayerId[];
      readonly requiredTargetCount: 1;
    }
  | {
      readonly type: "activate-hero-skill";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly requiredCardCount: 1;
      readonly skillId: "xyy.skill.jn20302";
      readonly targetPlayerIds: readonly PlayerId[];
      readonly requiredTargetCount: 1;
    }
  | {
      readonly type: "activate-hero-skill";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly requiredCardCount: 1;
      readonly skillId: "xyy.skill.jn40401";
      readonly targetPlayerIds: readonly PlayerId[];
      readonly requiredTargetCount: 0;
    }
  | {
      readonly type: "activate-hero-skill";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly requiredCardCount: 0;
      readonly skillId: "xyy.skill.jn40302";
      readonly targetPlayerIds: readonly PlayerId[];
      readonly requiredTargetCount: 0;
    }
  | {
      readonly type: "activate-hero-skill";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly requiredCardCount: 0;
      readonly skillId: "xyy.skill.jn50202";
      readonly targetPlayerIds: readonly PlayerId[];
      readonly requiredTargetCount: 0;
    }
  | {
      readonly type: "activate-hero-skill";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly requiredCardCount: 0;
      readonly skillId: "xyy.skill.jn20601";
      readonly targetPlayerIds: readonly PlayerId[];
      readonly requiredTargetCount: 1;
    }
  | {
      readonly type: "activate-hero-skill";
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly requiredCardCount: number;
      readonly skillId: "xyy.skill.jn30601";
      readonly targetPlayerIds: readonly PlayerId[];
      readonly minTargetCount: 1;
      readonly maxTargetCount: 2;
    }
  | { readonly type: "end-action" }
  | {
      readonly type: "play-reaction-card";
      readonly cardInstanceId: CardInstanceId;
      readonly targetEffectId: EffectId;
    }
  | {
      readonly type: "play-converted-reaction-card";
      readonly cardInstanceId: CardInstanceId;
      readonly equipmentCardInstanceId: CardInstanceId;
      readonly targetEffectId: EffectId;
    }
  | {
      readonly type: "play-skill-converted-reaction-card";
      readonly cardInstanceId: CardInstanceId;
      readonly skillId: "xyy.skill.jn20202";
      readonly targetEffectId: EffectId;
    }
  | {
      readonly type: "activate-damage-equipment";
      readonly cardInstanceId: CardInstanceId;
      readonly targetEffectId: EffectId;
    }
  | { readonly type: "pass-reaction"; readonly windowId: WindowId }
  | {
      readonly type: "play-rescue-card";
      readonly cardInstanceId: CardInstanceId;
      readonly targetPlayerId: PlayerId;
    }
  | {
      readonly type: "activate-rescue-equipment";
      readonly cardInstanceId: CardInstanceId;
      readonly targetPlayerId: PlayerId;
    }
  | { readonly type: "pass-rescue"; readonly choiceId: ChoiceId }
  | {
      readonly type: "distribute-death-loot";
      readonly choiceId: ChoiceId;
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly minCardCount: 1;
      readonly maxCardCount: number;
      readonly targetPlayerIds: readonly PlayerId[];
    }
  | {
      readonly type: "finish-death-loot";
      readonly choiceId: ChoiceId;
    }
  | {
      readonly type: "distribute-brother-hand";
      readonly choiceId: ChoiceId;
      readonly cardInstanceIds: readonly CardInstanceId[];
      readonly minCardCount: 1;
      readonly maxCardCount: number;
      readonly targetPlayerIds: readonly PlayerId[];
    }
  | {
      readonly type: "finish-brother-hand";
      readonly choiceId: ChoiceId;
    }
  | {
      readonly type: "submit-choice";
      readonly choiceId: ChoiceId;
      readonly optionIds: readonly string[];
      readonly minSelections: number;
      readonly maxSelections: number;
    }
  | {
      readonly type: "discard-cards";
      readonly count: number;
      readonly cardInstanceIds: readonly CardInstanceId[];
    };

export interface PlayerView {
  readonly matchId: MatchId;
  readonly version: number;
  readonly phase: MatchPhase;
  readonly activePlayerId: PlayerId | null;
  readonly turn: TurnState | null;
  readonly winner: TeamId | "draw" | null;
  readonly players: readonly PublicPlayerView[];
  readonly encounter: {
    readonly deckCount: number;
    readonly discardPile: readonly EncounterCardId[];
    readonly lastInspection: EncounterInspection | null;
  };
  readonly setup: SetupView | null;
  readonly availableActions: readonly AvailableAction[];
  readonly effectStack: readonly EffectFrame[];
  readonly reactionWindow: ReactionWindowView | null;
  readonly pendingChoice: PendingChoice | null;
  readonly dyingBatch: DyingBatch | null;
}

export interface ReactionWindowView {
  readonly windowId: WindowId;
  readonly effectId: EffectId;
  readonly parentWindowId: WindowId | null;
  readonly priorityPlayerId: PlayerId | null;
  readonly passedPlayerIds: readonly PlayerId[];
  readonly status: ReactionWindow["status"];
  readonly openedAt: number;
  readonly deadlineAt: number;
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
        handLimit: 3,
        hand: [],
        equipment: { weapon: null, armor: null },
      } satisfies PlayerState,
    ]),
  );

  const encounterDecks = createEncounterDecks(input.seed);
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
    turn: null,
    winner: null,
    turnOrder: [],
    players,
    connections: Object.fromEntries(
      input.players.map((player) => [
        player.id,
        {
          status: "connected",
          disconnectedAt: null,
          autoAt: null,
        } satisfies PlayerConnectionState,
      ]),
    ),
    drawPile: [],
    discardPile: [],
    ...encounterDecks,
    encounterInspections: {},
    setup: null,
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
    rng: { algorithm: "sha256-counter-v1", seed: input.seed, cursor: 0 },
  };
}

type MatchStateV6 = Omit<
  MatchState,
  | "schemaVersion"
  | "encounterDeck"
  | "encounterDiscard"
  | "encounterInspections"
  | "reserveNpcDeck"
  | "reserveNpcDiscard"
> & { readonly schemaVersion: 6 };

/** Explicit in-memory forward migration; persistence bytes remain untouched until the next accepted snapshot. */
function upgradeEncounterDecksFromV6(legacy: MatchStateV6): MatchState {
  return {
    ...legacy,
    schemaVersion: MATCH_SCHEMA_VERSION,
    ...createEncounterDecks(legacy.rng.seed),
    encounterInspections: {},
  };
}

function upgradeDamageMasksFromV5(
  legacy: Omit<MatchStateV6, "schemaVersion"> & { readonly schemaVersion: 5 },
): MatchStateV6 {
  return {
    ...legacy,
    schemaVersion: 6,
    effectStack: legacy.effectStack.map((effect) => {
      const damageItems = effect.payload.damageItems;
      if (!Array.isArray(damageItems)) return effect;
      return {
        ...effect,
        payload: {
          ...effect.payload,
          damageItems: damageItems.map((item) => {
            if (item === null || typeof item !== "object") return item;
            const damage = item as Record<string, unknown>;
            const oldMask = damage.hpEvoMask;
            return {
              ...damage,
              hpEvoMask:
                oldMask === "normal"
                  ? []
                  : oldMask === "tux-inavo"
                    ? ["tux-inavo"]
                    : oldMask,
              appliedModifierCardInstanceIds: Array.isArray(
                damage.appliedModifierCardInstanceIds,
              )
                ? damage.appliedModifierCardInstanceIds
                : [],
            };
          }),
        },
      };
    }),
  };
}

export function migrateMatchState(value: unknown): MatchState {
  if (value === null || typeof value !== "object") {
    throw new Error("Match snapshot is not an object.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion === MATCH_SCHEMA_VERSION) {
    const current = value as MatchState;
    if (
      !("turn" in raw) ||
      !("winner" in raw) ||
      !("dyingBatch" in raw) ||
      !("connections" in raw) ||
      !Array.isArray(current.encounterDeck) ||
      !Array.isArray(current.encounterDiscard) ||
      !Array.isArray(current.reserveNpcDeck) ||
      !Array.isArray(current.reserveNpcDiscard) ||
      current.encounterInspections === null ||
      typeof current.encounterInspections !== "object" ||
      Array.isArray(current.encounterInspections) ||
      Object.entries(current.encounterInspections).some(
        ([playerId, inspection]) =>
          current.players[playerId] === undefined ||
          inspection === undefined ||
          inspection === null ||
          typeof inspection.effectId !== "string" ||
          !Number.isSafeInteger(inspection.inspectedAt) ||
          inspection.inspectedAt < 0 ||
          !Array.isArray(inspection.cardIds) ||
          inspection.cardIds.length < 1 ||
          inspection.cardIds.length > 2 ||
          inspection.cardIds.some((id) => typeof id !== "string"),
      ) ||
      (current.turn !== null &&
        (typeof current.turn.openedAt !== "number" ||
          typeof current.turn.deadlineAt !== "number")) ||
      (current.setup !== null &&
        (typeof current.setup.openedAt !== "number" ||
          typeof current.setup.deadlineAt !== "number")) ||
      Object.values(current.players).some(
        (player) =>
          typeof player.handLimit !== "number" ||
          player.equipment === undefined,
      )
    ) {
      throw new Error("Match schema v8 snapshot is missing required fields.");
    }
    return current;
  }
  if (raw.schemaVersion === 7) {
    return migrateMatchState({
      ...raw,
      schemaVersion: MATCH_SCHEMA_VERSION,
      encounterInspections: {},
    });
  }
  if (raw.schemaVersion === 6) {
    return upgradeEncounterDecksFromV6(value as MatchStateV6);
  }
  if (raw.schemaVersion === 5) {
    return upgradeEncounterDecksFromV6(
      upgradeDamageMasksFromV5(
        value as Omit<MatchStateV6, "schemaVersion"> & {
          readonly schemaVersion: 5;
        },
      ),
    );
  }
  if (raw.schemaVersion === 4) {
    const legacy = value as Omit<
      MatchStateV6,
      "schemaVersion" | "connections" | "turn" | "setup"
    > & {
      readonly schemaVersion: 4;
      readonly turn: Omit<TurnState, "openedAt" | "deadlineAt"> | null;
      readonly setup: Omit<SetupState, "openedAt" | "deadlineAt"> | null;
    };
    return upgradeEncounterDecksFromV6(
      upgradeDamageMasksFromV5({
        ...legacy,
        schemaVersion: 5,
        turn:
          legacy.turn === null
            ? null
            : { ...legacy.turn, openedAt: 0, deadlineAt: 0 },
        setup:
          legacy.setup === null
            ? null
            : { ...legacy.setup, openedAt: 0, deadlineAt: 0 },
        connections: Object.fromEntries(
          Object.keys(legacy.players).map((playerId) => [
            playerId,
            { status: "connected", disconnectedAt: null, autoAt: null },
          ]),
        ),
      }),
    );
  }
  if (raw.schemaVersion === 3) {
    const legacy = value as Omit<
      MatchStateV6,
      "schemaVersion" | "dyingBatch"
    > & { readonly schemaVersion: 3 };
    return upgradeEncounterDecksFromV6(
      upgradeDamageMasksFromV5({
        ...legacy,
        schemaVersion: 5,
        dyingBatch: null,
        turn:
          legacy.turn === null
            ? null
            : { ...legacy.turn, openedAt: 0, deadlineAt: 0 },
        setup:
          legacy.setup === null
            ? null
            : { ...legacy.setup, openedAt: 0, deadlineAt: 0 },
        connections: Object.fromEntries(
          Object.keys(legacy.players).map((playerId) => [
            playerId,
            { status: "connected", disconnectedAt: null, autoAt: null },
          ]),
        ),
      }),
    );
  }
  if (raw.schemaVersion !== 2) {
    throw new Error(
      `Unsupported match schema version ${String(raw.schemaVersion)}.`,
    );
  }
  const legacy = value as Omit<MatchStateV6, "schemaVersion"> & {
    readonly schemaVersion: 2;
  };
  const players = Object.fromEntries(
    Object.values(legacy.players).map((player) => [
      player.id,
      {
        ...player,
        handLimit: typeof player.handLimit === "number" ? player.handLimit : 3,
        equipment: player.equipment ?? { weapon: null, armor: null },
      },
    ]),
  );
  return upgradeEncounterDecksFromV6(
    upgradeDamageMasksFromV5({
      ...legacy,
      schemaVersion: 5,
      turn:
        legacy.turn ??
        (legacy.phase === "playing"
          ? { number: 1, phase: "action", openedAt: 0, deadlineAt: 0 }
          : null),
      winner: legacy.winner ?? null,
      players,
      dyingBatch: null,
      setup:
        legacy.setup === null
          ? null
          : { ...legacy.setup, openedAt: 0, deadlineAt: 0 },
      connections: Object.fromEntries(
        Object.keys(players).map((playerId) => [
          playerId,
          { status: "connected", disconnectedAt: null, autoAt: null },
        ]),
      ),
    }),
  );
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
  const availableActions: AvailableAction[] = canChoose
    ? [
        {
          type: "choose-hero",
          heroIds: ownOffer.candidateHeroIds,
        },
        ...(ownOffer.rerolled ? [] : [{ type: "reroll-hero" as const }]),
      ]
    : state.dyingBatch?.status === "distributing-loot"
      ? deathLootActions(state, viewerId)
      : state.dyingBatch !== null
        ? rescueActions(state, viewerId)
        : state.pendingChoice !== null
          ? state.pendingChoice.prompt === "jn40302-distribute-hand"
            ? brotherHandActions(state, viewerId)
            : pendingChoiceActions(state, viewerId)
          : state.reactionWindow === null
            ? turnActions(state, viewerId)
            : reactionActions(state, viewerId);
  return {
    matchId: state.matchId,
    version: state.version,
    phase: state.phase,
    activePlayerId: state.activePlayerId,
    turn: state.turn,
    winner: state.winner,
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
        strength: player.strength,
        dexterity: player.dexterity,
        handLimit: player.handLimit,
        handCount: player.hand.length,
        hand: player.id === viewerId ? player.hand : null,
        equipment: player.equipment,
        connection: state.connections[player.id] ?? {
          status: "connected",
          disconnectedAt: null,
          autoAt: null,
        },
      })),
    encounter: {
      deckCount: state.encounterDeck.length,
      discardPile: state.encounterDiscard,
      lastInspection: state.encounterInspections[viewerId] ?? null,
    },
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
    availableActions,
    effectStack: state.effectStack,
    reactionWindow:
      state.reactionWindow === null
        ? null
        : {
            windowId: state.reactionWindow.windowId,
            effectId: state.reactionWindow.effectId,
            parentWindowId: state.reactionWindow.parentWindowId,
            priorityPlayerId:
              state.reactionWindow.priorityOrder[
                state.reactionWindow.priorityIndex
              ] ?? null,
            passedPlayerIds: state.reactionWindow.passedPlayerIds,
            status: state.reactionWindow.status,
            openedAt: state.reactionWindow.openedAt,
            deadlineAt: state.reactionWindow.deadlineAt,
          },
    pendingChoice:
      state.pendingChoice?.playerIds.includes(viewerId) === true
        ? state.pendingChoice
        : null,
    dyingBatch: state.dyingBatch,
  };
}

function pendingChoiceActions(
  state: Readonly<MatchState>,
  viewerId: PlayerId,
): AvailableAction[] {
  const choice = state.pendingChoice;
  if (
    state.phase !== "playing" ||
    choice === null ||
    choice.status !== "open" ||
    !choice.playerIds.includes(viewerId)
  ) {
    return [];
  }
  return [
    {
      type: "submit-choice",
      choiceId: choice.choiceId,
      optionIds: choice.optionIds,
      minSelections: choice.minSelections,
      maxSelections: choice.maxSelections,
    },
  ];
}

function brotherHandActions(
  state: Readonly<MatchState>,
  viewerId: PlayerId,
): AvailableAction[] {
  const choice = state.pendingChoice;
  const owner = state.players[viewerId];
  if (
    state.phase !== "playing" ||
    choice === null ||
    choice.status !== "open" ||
    choice.prompt !== "jn40302-distribute-hand" ||
    !choice.playerIds.includes(viewerId) ||
    owner?.alive !== true
  ) {
    return [];
  }
  const targets = Object.values(state.players)
    .filter(
      (player) =>
        player.alive && player.id !== viewerId && player.team === owner.team,
    )
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  return [
    ...(targets.length === 0 || choice.optionIds.length === 0
      ? []
      : [
          {
            type: "distribute-brother-hand" as const,
            choiceId: choice.choiceId,
            cardInstanceIds: choice.optionIds as readonly CardInstanceId[],
            minCardCount: 1 as const,
            maxCardCount: choice.optionIds.length,
            targetPlayerIds: targets,
          },
        ]),
    { type: "finish-brother-hand", choiceId: choice.choiceId },
  ];
}

function reactionActions(
  state: Readonly<MatchState>,
  viewerId: PlayerId,
): AvailableAction[] {
  const window = state.reactionWindow;
  if (
    state.phase !== "playing" ||
    window === null ||
    window.status !== "open" ||
    window.priorityOrder[window.priorityIndex] !== viewerId
  ) {
    return [];
  }
  const player = state.players[viewerId];
  if (player === undefined || !player.alive) return [];
  const targetEffect = state.effectStack.find(
    (effect) => effect.effectId === window.effectId,
  );
  const damageItems = Array.isArray(targetEffect?.payload.damageItems)
    ? (targetEffect.payload.damageItems as readonly {
        readonly targetPlayerId?: string;
        readonly amount?: number;
        readonly hpEvoMask?: readonly string[];
      }[])
    : [];
  const reactions = player.hand.flatMap((cardInstanceId) =>
    (
      targetEffect?.kind === "damage-batch"
        ? cardDefinition(cardInstanceId).coreAction?.type ===
            "prevent-damage" &&
          damageItems.some(
            (item) =>
              item.targetPlayerId === viewerId &&
              (item.amount ?? 0) > 0 &&
              !item.hpEvoMask?.includes("tux-inavo"),
          )
        : cardDefinition(cardInstanceId).coreAction?.type === "cancel-effect"
    )
      ? [
          {
            type: "play-reaction-card" as const,
            cardInstanceId,
            targetEffectId: window.effectId,
          },
        ]
      : [],
  );
  const armor = player.equipment.armor;
  const equipmentActions =
    targetEffect?.kind === "damage-batch" &&
    armor !== null &&
    cardDefinition(armor).id === "xyy.card.fj05" &&
    damageItems.some(
      (item) =>
        item.targetPlayerId === viewerId &&
        (item.amount ?? 0) > 0 &&
        !item.hpEvoMask?.includes("decr-inavo") &&
        !item.hpEvoMask?.includes("immune-inavo"),
    )
      ? [
          {
            type: "activate-damage-equipment" as const,
            cardInstanceId: armor,
            targetEffectId: targetEffect.effectId,
          },
        ]
      : [];
  const conversionActions =
    targetEffect?.kind === "damage-batch" &&
    armor !== null &&
    cardDefinition(armor).id === "xyy.card.fj02" &&
    damageItems.some(
      (item) =>
        item.targetPlayerId === viewerId &&
        (item.amount ?? 0) > 0 &&
        !item.hpEvoMask?.includes("tux-inavo"),
    )
      ? player.hand.flatMap((cardInstanceId) =>
          cardDefinition(cardInstanceId).coreAction?.type === "prevent-damage"
            ? []
            : [
                {
                  type: "play-converted-reaction-card" as const,
                  cardInstanceId,
                  equipmentCardInstanceId: armor,
                  targetEffectId: targetEffect.effectId,
                },
              ],
        )
      : [];
  const skillConversionActions =
    targetEffect !== undefined &&
    targetEffect.kind !== "damage-batch" &&
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn20202")
      ? player.hand.flatMap((cardInstanceId) =>
          cardIdOf(cardInstanceId).startsWith("xyy.card.tp")
            ? [
                {
                  type: "play-skill-converted-reaction-card" as const,
                  cardInstanceId,
                  skillId: "xyy.skill.jn20202" as const,
                  targetEffectId: targetEffect.effectId,
                },
              ]
            : [],
        )
      : [];
  return [
    ...equipmentActions,
    ...conversionActions,
    ...skillConversionActions,
    ...reactions,
    { type: "pass-reaction", windowId: window.windowId },
  ];
}

function rescueActions(
  state: Readonly<MatchState>,
  viewerId: PlayerId,
): AvailableAction[] {
  const batch = state.dyingBatch;
  const choice = state.pendingChoice;
  if (
    state.phase !== "playing" ||
    batch === null ||
    choice === null ||
    batch.status !== "awaiting-rescue" ||
    choice.status !== "open" ||
    batch.priorityOrder[batch.priorityIndex] !== viewerId ||
    !choice.playerIds.includes(viewerId)
  ) {
    return [];
  }
  const player = state.players[viewerId];
  if (player === undefined || !player.alive) return [];
  const rescueCards = player.hand.flatMap((cardInstanceId) =>
    cardDefinition(cardInstanceId).rescueAction?.type === "rescue-two"
      ? [
          {
            type: "play-rescue-card" as const,
            cardInstanceId,
            targetPlayerId: batch.currentTargetPlayerId,
          },
        ]
      : [],
  );
  const skillConversion =
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn40301") &&
    player.hand.length >= 2
      ? [
          {
            type: "play-skill-converted-card" as const,
            cardInstanceIds: player.hand,
            requiredCardCount: 2 as const,
            skillId: "xyy.skill.jn40301" as const,
            targetPlayerIds: [batch.currentTargetPlayerId],
          },
        ]
      : [];
  const armor = player.equipment.armor;
  const rescueEquipment =
    viewerId === batch.currentTargetPlayerId &&
    armor !== null &&
    cardDefinition(armor).id === "xyy.card.fj01"
      ? [
          {
            type: "activate-rescue-equipment" as const,
            cardInstanceId: armor,
            targetPlayerId: viewerId,
          },
        ]
      : [];
  return [
    ...rescueEquipment,
    ...skillConversion,
    ...rescueCards,
    { type: "pass-rescue", choiceId: choice.choiceId },
  ];
}

function deathLootActions(
  state: Readonly<MatchState>,
  viewerId: PlayerId,
): AvailableAction[] {
  const batch = state.dyingBatch;
  const choice = state.pendingChoice;
  if (
    state.phase !== "playing" ||
    batch?.status !== "distributing-loot" ||
    choice === null ||
    choice.status !== "open" ||
    !choice.playerIds.includes(viewerId)
  ) {
    return [];
  }
  const targets = Object.values(state.players)
    .filter((player) => player.alive && player.id !== viewerId)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  return [
    ...(targets.length === 0
      ? []
      : [
          {
            type: "distribute-death-loot" as const,
            choiceId: choice.choiceId,
            cardInstanceIds: choice.optionIds as readonly CardInstanceId[],
            minCardCount: 1 as const,
            maxCardCount: choice.optionIds.length,
            targetPlayerIds: targets,
          },
        ]),
    { type: "finish-death-loot", choiceId: choice.choiceId },
  ];
}

function jn50201TurnActions(
  state: Readonly<MatchState>,
  viewerId: PlayerId,
  player: Readonly<PlayerState>,
): AvailableAction[] {
  const usedSkillIds = state.turn?.usedSkillIds ?? [];
  const livingPlayers = Object.values(state.players)
    .filter((candidate) => candidate.alive)
    .sort((left, right) => left.seat - right.seat);
  const otherCardTargets = livingPlayers.filter(
    (candidate) =>
      candidate.id !== viewerId &&
      (candidate.hand.length > 0 ||
        candidate.equipment.weapon !== null ||
        candidate.equipment.armor !== null),
  );
  if (
    player.heroId === null ||
    !heroHasSkill(player.heroId, "xyy.skill.jn50201") ||
    usedSkillIds.includes("xyy.skill.jn50201") ||
    player.hand.length === 0 ||
    otherCardTargets.length === 0
  ) {
    return [];
  }
  const stealTargets = otherCardTargets.filter(
    (candidate) => candidate.hand.length > 0,
  );
  const selfHasCardAfterPayment =
    player.hand.length > 1 ||
    player.equipment.weapon !== null ||
    player.equipment.armor !== null;
  const discardTargets = [
    ...(selfHasCardAfterPayment ? [player] : []),
    ...otherCardTargets,
  ].sort((left, right) => left.seat - right.seat);
  return [
    ...(stealTargets.length === 0
      ? []
      : [
          {
            type: "play-skill-converted-card" as const,
            cardInstanceIds: player.hand,
            requiredCardCount: 1 as const,
            skillId: "xyy.skill.jn50201" as const,
            convertedCardId: "xyy.card.jp01" as const,
            targetPlayerIds: stealTargets.map((candidate) => candidate.id),
          },
        ]),
    {
      type: "play-skill-converted-card" as const,
      cardInstanceIds: player.hand,
      requiredCardCount: 1 as const,
      skillId: "xyy.skill.jn50201" as const,
      convertedCardId: "xyy.card.jp06" as const,
      targetPlayerIds: discardTargets.map((candidate) => candidate.id),
    },
  ];
}

function turnActions(
  state: Readonly<MatchState>,
  viewerId: PlayerId,
): AvailableAction[] {
  if (
    state.phase !== "playing" ||
    state.activePlayerId !== viewerId ||
    state.turn === null
  ) {
    return [];
  }
  const player = state.players[viewerId];
  if (player === undefined || !player.alive) return [];
  if (state.turn.phase === "discard") {
    const count = player.hand.length - player.handLimit;
    return count > 0
      ? [
          {
            type: "discard-cards",
            count,
            cardInstanceIds: player.hand,
          },
        ]
      : [];
  }
  if (state.turn.phase !== "action") return [];
  const playable = player.hand.flatMap((instanceId) => {
    const definition = cardDefinition(instanceId);
    const alternate =
      definition.alternateActions?.flatMap((action) =>
        action.type === "pawn-draw-one" || action.type === "pawn-draw-two"
          ? [
              {
                type: "play-card" as const,
                cardInstanceId: instanceId,
                targetPlayerIds: [],
                mode: "pawn" as const,
              },
            ]
          : [],
      ) ?? [];
    if (definition.coreAction?.type === "equip") {
      return [
        ...alternate,
        {
          type: "play-card" as const,
          cardInstanceId: instanceId,
          targetPlayerIds: [viewerId],
        },
      ];
    }
    if (definition.coreAction?.type === "inspect-encounter") {
      return state.encounterDeck.length === 0
        ? alternate
        : [
            ...alternate,
            {
              type: "play-card" as const,
              cardInstanceId: instanceId,
              targetPlayerIds: [viewerId],
            },
          ];
    }
    if (definition.coreAction?.type === "draw-two") {
      return [
        ...alternate,
        {
          type: "play-card" as const,
          cardInstanceId: instanceId,
          targetPlayerIds: Object.values(state.players)
            .filter((candidate) => candidate.alive)
            .sort((left, right) => left.seat - right.seat)
            .map((candidate) => candidate.id),
        },
      ];
    }
    if (definition.coreAction?.type === "steal-one") {
      const targetPlayerIds = Object.values(state.players)
        .filter(
          (candidate) =>
            candidate.id !== viewerId &&
            candidate.alive &&
            candidate.hand.length > 0,
        )
        .sort((left, right) => left.seat - right.seat)
        .map((candidate) => candidate.id);
      return targetPlayerIds.length === 0
        ? alternate
        : [
            ...alternate,
            {
              type: "play-card" as const,
              cardInstanceId: instanceId,
              targetPlayerIds,
            },
          ];
    }
    if (definition.coreAction?.type === "discard-one") {
      const targetPlayerIds = Object.values(state.players)
        .filter(
          (candidate) =>
            candidate.alive &&
            (candidate.hand.length > 0 ||
              candidate.equipment.weapon !== null ||
              candidate.equipment.armor !== null),
        )
        .sort((left, right) => left.seat - right.seat)
        .map((candidate) => candidate.id);
      return targetPlayerIds.length === 0
        ? alternate
        : [
            ...alternate,
            {
              type: "play-card" as const,
              cardInstanceId: instanceId,
              targetPlayerIds,
            },
          ];
    }
    if (definition.coreAction?.type === "damage-two") {
      return [
        ...alternate,
        {
          type: "play-card" as const,
          cardInstanceId: instanceId,
          targetPlayerIds: Object.values(state.players)
            .filter((candidate) => candidate.alive)
            .sort((left, right) => left.seat - right.seat)
            .map((candidate) => candidate.id),
        },
      ];
    }
    if (definition.coreAction?.type === "heal-two") {
      return [
        ...alternate,
        {
          type: "play-card" as const,
          cardInstanceId: instanceId,
          targetPlayerIds: [viewerId],
        },
      ];
    }
    if (definition.coreAction?.type === "heal-team-one") {
      return [
        ...alternate,
        {
          type: "play-card" as const,
          cardInstanceId: instanceId,
          targetPlayerIds: Object.values(state.players)
            .filter(
              (candidate) => candidate.alive && candidate.team === player.team,
            )
            .sort((left, right) => left.seat - right.seat)
            .map((candidate) => candidate.id),
          mode: "primary" as const,
        },
      ];
    }
    return alternate;
  });
  const equippedPawn =
    player.equipment.weapon !== null &&
    cardDefinition(player.equipment.weapon).alternateActions?.some(
      (action) => action.type === "pawn-draw-two",
    ) === true
      ? [
          {
            type: "play-card" as const,
            cardInstanceId: player.equipment.weapon,
            targetPlayerIds: [],
            mode: "pawn" as const,
          },
        ]
      : [];
  const skillConversion =
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn40301") &&
    player.hand.length >= 2
      ? [
          {
            type: "play-skill-converted-card" as const,
            cardInstanceIds: player.hand,
            requiredCardCount: 2 as const,
            skillId: "xyy.skill.jn40301" as const,
            targetPlayerIds: [viewerId],
          },
        ]
      : [];
  const techniqueCards = player.hand.filter((cardInstanceId) =>
    cardIdOf(cardInstanceId).startsWith("xyy.card.jp"),
  );
  const heroSkillActions =
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn20302") &&
    techniqueCards.length > 0
      ? [
          {
            type: "activate-hero-skill" as const,
            cardInstanceIds: techniqueCards,
            requiredCardCount: 1 as const,
            skillId: "xyy.skill.jn20302" as const,
            targetPlayerIds: Object.values(state.players)
              .filter((candidate) => candidate.alive)
              .sort((left, right) => left.seat - right.seat)
              .map((candidate) => candidate.id),
            requiredTargetCount: 1 as const,
          },
        ]
      : [];
  const allOwnCards = [
    ...player.hand,
    ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
    ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
  ];
  const selfHealingActions =
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn40401") &&
    allOwnCards.length > 0
      ? [
          {
            type: "activate-hero-skill" as const,
            cardInstanceIds: allOwnCards,
            requiredCardCount: 1 as const,
            skillId: "xyy.skill.jn40401" as const,
            targetPlayerIds: [viewerId],
            requiredTargetCount: 0 as const,
          },
        ]
      : [];
  const drawDiscardActions =
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn50202") &&
    !(state.turn.usedSkillIds ?? []).includes("xyy.skill.jn50202")
      ? [
          {
            type: "activate-hero-skill" as const,
            cardInstanceIds: [],
            requiredCardCount: 0 as const,
            skillId: "xyy.skill.jn50202" as const,
            targetPlayerIds: [],
            requiredTargetCount: 0 as const,
          },
        ]
      : [];
  const presentSwordTargets = Object.values(state.players)
    .filter(
      (candidate) =>
        candidate.alive &&
        candidate.id !== viewerId &&
        !(state.turn?.usedSkillTargetIds?.["xyy.skill.jn50401"] ?? []).includes(
          candidate.id,
        ),
    )
    .sort((left, right) => left.seat - right.seat)
    .map((candidate) => candidate.id);
  const equippedCards = [
    ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
    ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
  ];
  const presentSwordActions =
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn50401") &&
    equippedCards.length > 0 &&
    presentSwordTargets.length > 0
      ? [
          {
            type: "activate-hero-skill" as const,
            cardInstanceIds: equippedCards,
            requiredCardCount: 1 as const,
            skillId: "xyy.skill.jn50401" as const,
            targetPlayerIds: presentSwordTargets,
            requiredTargetCount: 1 as const,
          },
        ]
      : [];
  const giftHandTargets = Object.values(state.players)
    .filter(
      (candidate) =>
        candidate.alive &&
        candidate.id !== viewerId &&
        candidate.team === player.team,
    )
    .sort((left, right) => left.seat - right.seat)
    .map((candidate) => candidate.id);
  const giftHandActions =
    player.heroId !== null &&
    player.team !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn10501") &&
    player.hand.length > 0 &&
    giftHandTargets.length > 0
      ? [
          {
            type: "activate-hero-skill" as const,
            cardInstanceIds: player.hand,
            minCardCount: 1 as const,
            maxCardCount: player.hand.length,
            skillId: "xyy.skill.jn10501" as const,
            targetPlayerIds: giftHandTargets,
            requiredTargetCount: 1 as const,
          },
        ]
      : [];
  const harmedTargets =
    state.turn.usedSkillTargetIds?.["xyy.skill.jn20601"] ?? [];
  const harmFemaleTargets = Object.values(state.players)
    .filter(
      (candidate) =>
        candidate.alive &&
        candidate.id !== viewerId &&
        candidate.heroId !== null &&
        heroDefinition(candidate.heroId).gender === "F" &&
        !harmedTargets.includes(candidate.id),
    )
    .sort((left, right) => left.seat - right.seat)
    .map((candidate) => candidate.id);
  const harmFemaleActions =
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn20601") &&
    player.hp >= 2 &&
    harmFemaleTargets.length > 0
      ? [
          {
            type: "activate-hero-skill" as const,
            cardInstanceIds: [],
            requiredCardCount: 0 as const,
            skillId: "xyy.skill.jn20601" as const,
            targetPlayerIds: harmFemaleTargets,
            requiredTargetCount: 1 as const,
          },
        ]
      : [];
  const brothersActions =
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn40302") &&
    !(state.turn.usedSkillIds ?? []).includes("xyy.skill.jn40302") &&
    Object.values(state.players).some(
      (candidate) =>
        candidate.alive &&
        candidate.team === player.team &&
        candidate.hand.length > 0,
    )
      ? [
          {
            type: "activate-hero-skill" as const,
            cardInstanceIds: [],
            requiredCardCount: 0 as const,
            skillId: "xyy.skill.jn40302" as const,
            targetPlayerIds: [],
            requiredTargetCount: 0 as const,
          },
        ]
      : [];
  const duelTargets = Object.values(state.players)
    .filter((candidate) => candidate.alive && candidate.id !== viewerId)
    .sort((left, right) => left.seat - right.seat)
    .map((candidate) => candidate.id);
  const duelCost = (state.turn.usedSkillCounts?.["xyy.skill.jn30601"] ?? 0) + 1;
  const duelActions =
    player.heroId !== null &&
    heroHasSkill(player.heroId, "xyy.skill.jn30601") &&
    player.hand.length >= duelCost &&
    duelTargets.length > 0
      ? [
          {
            type: "activate-hero-skill" as const,
            cardInstanceIds: player.hand,
            requiredCardCount: duelCost,
            skillId: "xyy.skill.jn30601" as const,
            targetPlayerIds: duelTargets,
            minTargetCount: 1 as const,
            maxTargetCount: 2 as const,
          },
        ]
      : [];
  return [
    ...playable,
    ...equippedPawn,
    ...skillConversion,
    ...jn50201TurnActions(state, viewerId, player),
    ...heroSkillActions,
    ...selfHealingActions,
    ...drawDiscardActions,
    ...presentSwordActions,
    ...giftHandActions,
    ...harmFemaleActions,
    ...brothersActions,
    ...duelActions,
    { type: "end-action" },
  ];
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
  ENCOUNTER_DECK_ALGORITHM,
  SETUP_MONSTER_IDS,
  SETUP_NPC_IDS,
  createEncounterDecks,
  type EncounterCardId,
  type EncounterDecks,
  type MonsterId,
  type NpcId,
} from "./encounter-content.js";
export {
  applyEncounterHinderChoice,
  applyEncounterSupportChoice,
  applyEncounterTimeout,
  createEncounterDecision,
  opposingDecisionPlayerId,
  projectEncounterDecision,
  revealEncounterCard,
  type EncounterDecisionStage,
  type EncounterDecisionState,
  type EncounterDecisionView,
  type EncounterHinderChoice,
  type EncounterParticipant,
  type EncounterRevealResult,
  type EncounterSupportChoice,
  type EncounterZones,
} from "./encounter.js";
export { reduceDuelEvent } from "./duel.js";
export {
  ENCOUNTER_DEFINITIONS,
  encounterDefinition,
  type EncounterDefinition,
  type MonsterDefinition,
  type NpcDefinition,
  type NpcActionId,
  type PetElement,
} from "./encounter-definitions.js";
export {
  assertEncounterOwnership,
  beginEncounterResolution,
  openNpcDecision,
  chooseNpcAction,
  defaultNpcAction,
  finishNpcAction,
  finishMonsterBattle,
  chooseCapturedPet,
  defaultCapturedPet,
  projectEncounterResolution,
  evaluateBattle,
  evaluatePetScore,
  type EncounterResolution,
  type EncounterResolutionResult,
  type EncounterResolutionZones,
  type NpcDecision,
  type BattlePlayer,
  type BattleInput,
} from "./encounter-resolution.js";
export { beginDamageResponse } from "./reaction.js";
export {
  applyPlannedDamage,
  beginDyingBatch,
  planDamageBatch,
  type AppliedDamage,
  type DamageIntent,
  type DamageModifier,
} from "./damage-dying.js";
export {
  planCureBatch,
  playersAfterCures,
  type AppliedCure,
  type CureIntent,
} from "./healing.js";
export {
  canonicalHpEvolutionMask,
  hasHpEvolutionFlag,
  isCanonicalHpEvolutionMask,
  type HpEvolutionFlag,
} from "./hp-evolution.js";
export {
  ACTION_DEADLINE_MS,
  DISCONNECT_GRACE_MS,
  applySystemCommand,
  collectSystemDeadlines,
  reduceTimeRecoveryEvent,
  type SystemDeadline,
} from "./time-recovery.js";
export {
  SETUP_CARDS,
  SELECTABLE_HEROES,
  SETUP_CARD_INSTANCES,
  SETUP_HEROES,
  HERO_SKILL_IDS,
  cardDefinition,
  cardIdOf,
  handLimitForHero,
  heroHasSkill,
  heroDefinition,
  skillIdsForHero,
  type CardDefinition,
  type CardId,
  type CardInstanceId,
  type CoreCardAction,
  type AlternateCardAction,
  type RescueCardAction,
  type EquipmentSlot,
  type HeroDefinition,
  type HeroId,
  type SkillId,
} from "./setup-content.js";
