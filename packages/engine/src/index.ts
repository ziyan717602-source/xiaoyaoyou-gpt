import type {
  ChoiceId,
  ContinuationId,
  EffectId,
  MatchId,
  PlayerId,
  WindowId,
} from "@xiaoyaoyou/protocol";
import { PROTOCOL_VERSION } from "@xiaoyaoyou/protocol";
import { cardDefinition, cardIdOf, heroHasSkill } from "./setup-content.js";
import type { CardInstanceId, HeroId } from "./setup-content.js";

export const MATCH_SCHEMA_VERSION = 6 as const;
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

export interface TurnState {
  readonly number: number;
  readonly phase: TurnPhase;
  readonly openedAt: number;
  readonly deadlineAt: number;
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
  readonly status: "awaiting-rescue" | "awaiting-death" | "after-death";
  readonly openedAt: number;
  readonly deadlineAt: number;
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
  readonly turn: TurnState | null;
  readonly winner: TeamId | "draw" | null;
  readonly turnOrder: readonly PlayerId[];
  readonly players: Readonly<Record<PlayerId, PlayerState>>;
  readonly connections: Readonly<Record<PlayerId, PlayerConnectionState>>;
  readonly drawPile: readonly CardInstanceId[];
  readonly discardPile: readonly CardInstanceId[];
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
    setup: null,
    effectStack: [],
    reactionWindow: null,
    pendingChoice: null,
    dyingBatch: null,
    rng: { algorithm: "sha256-counter-v1", seed: input.seed, cursor: 0 },
  };
}

/** Explicit in-memory forward migration; persistence bytes remain untouched until the next accepted snapshot. */
function upgradeDamageMasksFromV5(
  legacy: Omit<MatchState, "schemaVersion"> & { readonly schemaVersion: 5 },
): MatchState {
  return {
    ...legacy,
    schemaVersion: MATCH_SCHEMA_VERSION,
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
      throw new Error("Match schema v6 snapshot is missing required fields.");
    }
    return current;
  }
  if (raw.schemaVersion === 5) {
    return upgradeDamageMasksFromV5(
      value as Omit<MatchState, "schemaVersion"> & {
        readonly schemaVersion: 5;
      },
    );
  }
  if (raw.schemaVersion === 4) {
    const legacy = value as Omit<
      MatchState,
      "schemaVersion" | "connections" | "turn" | "setup"
    > & {
      readonly schemaVersion: 4;
      readonly turn: Omit<TurnState, "openedAt" | "deadlineAt"> | null;
      readonly setup: Omit<SetupState, "openedAt" | "deadlineAt"> | null;
    };
    return upgradeDamageMasksFromV5({
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
    });
  }
  if (raw.schemaVersion === 3) {
    const legacy = value as Omit<MatchState, "schemaVersion" | "dyingBatch"> & {
      readonly schemaVersion: 3;
    };
    return upgradeDamageMasksFromV5({
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
    });
  }
  if (raw.schemaVersion !== 2) {
    throw new Error(
      `Unsupported match schema version ${String(raw.schemaVersion)}.`,
    );
  }
  const legacy = value as Omit<MatchState, "schemaVersion"> & {
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
  return upgradeDamageMasksFromV5({
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
  });
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
    : state.dyingBatch !== null
      ? rescueActions(state, viewerId)
      : state.pendingChoice !== null
        ? pendingChoiceActions(state, viewerId)
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
  const reactions = player.hand.flatMap((cardInstanceId) =>
    (
      targetEffect?.kind === "damage-batch"
        ? cardDefinition(cardInstanceId).coreAction?.type === "prevent-damage"
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
  const damageItems = Array.isArray(targetEffect?.payload.damageItems)
    ? (targetEffect.payload.damageItems as readonly {
        readonly targetPlayerId?: string;
        readonly amount?: number;
        readonly hpEvoMask?: readonly string[];
      }[])
    : [];
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
    ...rescueCards,
    { type: "pass-rescue", choiceId: choice.choiceId },
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
  return [...playable, ...equippedPawn, { type: "end-action" }];
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
export { beginDamageResponse } from "./reaction.js";
export {
  applyPlannedDamage,
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
