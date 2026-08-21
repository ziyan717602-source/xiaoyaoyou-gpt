import type { PlayerId } from "@xiaoyaoyou/protocol";
import type { EncounterCardId } from "./encounter-content.js";
import type { MatchState, TeamId } from "./index.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";

export type EncounterParticipant =
  | { readonly kind: "player"; readonly playerId: PlayerId }
  | {
      readonly kind: "pet";
      readonly ownerPlayerId: PlayerId;
      readonly cardId: EncounterCardId;
    }
  | {
      readonly kind: "special";
      readonly ownerPlayerId: PlayerId;
      readonly contentId: string;
    };

export type EncounterDecisionStage =
  | "awaiting-support"
  | "awaiting-hinder"
  | "ready-reveal"
  | "revealed"
  | "completed"
  | "deck-empty";

export interface EncounterDecisionState {
  readonly kind: "encounter-decision";
  readonly activePlayerId: PlayerId;
  readonly stage: EncounterDecisionStage;
  readonly outcome: "fight" | "give-up" | null;
  readonly decisionOwnerPlayerId: PlayerId | null;
  readonly supporter: EncounterParticipant | null;
  readonly hinder: EncounterParticipant | null;
  readonly supportOptions: readonly EncounterParticipant[];
  readonly hinderOptions: readonly EncounterParticipant[];
  readonly configuredExtraHinderOptions: readonly EncounterParticipant[];
  readonly revealedCardId: EncounterCardId | null;
  readonly openedAt: number;
  readonly deadlineAt: number;
}

export type EncounterSupportChoice =
  | { readonly kind: "give-up" }
  | {
      readonly kind: "choose";
      readonly participant: EncounterParticipant;
    };

export type EncounterHinderChoice =
  | { readonly kind: "pass" }
  | {
      readonly kind: "choose";
      readonly participant: EncounterParticipant;
    };

export interface EncounterDecisionView {
  readonly activePlayerId: PlayerId;
  readonly stage: EncounterDecisionStage;
  readonly outcome: EncounterDecisionState["outcome"];
  readonly decisionOwnerPlayerId: PlayerId | null;
  readonly supporter: EncounterParticipant | null;
  readonly hinder: EncounterParticipant | null;
  readonly revealedCardId: EncounterCardId | null;
  readonly openedAt: number;
  readonly deadlineAt: number;
  readonly availableActions: readonly (
    | {
        readonly type: "choose-encounter-support";
        readonly options: readonly EncounterParticipant[];
        readonly canGiveUp: true;
      }
    | {
        readonly type: "choose-encounter-hinder";
        readonly options: readonly EncounterParticipant[];
        readonly canPass: true;
      }
  )[];
}

export interface EncounterZones {
  readonly encounterDeck: readonly EncounterCardId[];
  readonly encounterDiscard: readonly EncounterCardId[];
}

export interface EncounterRevealResult extends EncounterZones {
  readonly decision: EncounterDecisionState;
}

function participantKey(participant: EncounterParticipant): string {
  if (participant.kind === "player") return `player:${participant.playerId}`;
  if (participant.kind === "pet") {
    return `pet:${participant.ownerPlayerId}:${participant.cardId}`;
  }
  return `special:${participant.ownerPlayerId}:${participant.contentId}`;
}

function orderedTeamPlayers(
  state: Readonly<MatchState>,
  team: TeamId,
): readonly MatchState["players"][PlayerId][] {
  return Object.values(state.players)
    .filter((player) => player.team === team && player.turnIndex !== null)
    .sort(
      (left, right) =>
        left.turnIndex! - right.turnIndex! || left.seat - right.seat,
    );
}

function participantOwnerId(participant: EncounterParticipant): PlayerId {
  return participant.kind === "player"
    ? participant.playerId
    : participant.ownerPlayerId;
}

function legalExtraOptions(
  state: Readonly<MatchState>,
  team: TeamId,
  options: readonly EncounterParticipant[],
): readonly EncounterParticipant[] {
  return options.filter((option) => {
    const owner = state.players[participantOwnerId(option)];
    return owner?.alive === true && owner.team === team;
  });
}

function uniqueParticipants(
  options: readonly EncounterParticipant[],
): readonly EncounterParticipant[] {
  const keys = new Set<string>();
  return options.filter((option) => {
    const key = participantKey(option);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function baseOptions(
  state: Readonly<MatchState>,
  team: TeamId,
  extras: readonly EncounterParticipant[],
): readonly EncounterParticipant[] {
  return uniqueParticipants([
    ...orderedTeamPlayers(state, team)
      .filter((player) => player.alive)
      .map((player): EncounterParticipant => ({
        kind: "player",
        playerId: player.id,
      })),
    ...legalExtraOptions(state, team, extras),
  ]);
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

export function opposingDecisionPlayerId(
  state: Readonly<MatchState>,
  activePlayerId: PlayerId,
): PlayerId | null {
  const active = state.players[activePlayerId];
  if (active?.team === null || active?.team === undefined) return null;
  const ownTeam = orderedTeamPlayers(state, active.team);
  const ordinal = ownTeam.findIndex((player) => player.id === activePlayerId);
  if (ordinal < 0) return null;
  const opposingTeam = (active.team === 1 ? 2 : 1) as TeamId;
  const opponents = orderedTeamPlayers(state, opposingTeam);
  if (opponents.length === 0) return null;
  for (let offset = 0; offset < opponents.length; offset += 1) {
    const candidate = opponents[(ordinal + offset) % opponents.length];
    if (candidate?.alive === true) return candidate.id;
  }
  return null;
}

export function createEncounterDecision(
  state: Readonly<MatchState>,
  openedAt: number,
  options: {
    readonly extraSupportOptions?: readonly EncounterParticipant[];
    readonly extraHinderOptions?: readonly EncounterParticipant[];
  } = {},
): EncounterDecisionState {
  assertTimestamp(openedAt, "Encounter openedAt");
  const activePlayerId = state.activePlayerId;
  const active =
    activePlayerId === null ? undefined : state.players[activePlayerId];
  if (
    state.phase !== "playing" ||
    state.turn?.phase !== "encounter" ||
    activePlayerId === null ||
    active?.alive !== true ||
    active.team === null
  ) {
    throw new Error("Encounter decision requires a living active player.");
  }
  const supportOptions = baseOptions(
    state,
    active.team,
    options.extraSupportOptions ?? [],
  );
  if (supportOptions.length === 0) {
    throw new Error("Encounter decision requires a legal support option.");
  }
  return {
    kind: "encounter-decision",
    activePlayerId,
    stage: "awaiting-support",
    outcome: null,
    decisionOwnerPlayerId: activePlayerId,
    supporter: null,
    hinder: null,
    supportOptions,
    hinderOptions: [],
    configuredExtraHinderOptions: options.extraHinderOptions ?? [],
    revealedCardId: null,
    openedAt,
    deadlineAt: openedAt + ACTION_DEADLINE_MS,
  };
}

export function applyEncounterSupportChoice(
  decision: Readonly<EncounterDecisionState>,
  choice: Readonly<EncounterSupportChoice>,
  state: Readonly<MatchState>,
  resolvedAt: number,
): EncounterDecisionState {
  if (decision.stage !== "awaiting-support") {
    throw new Error("Encounter is not awaiting support.");
  }
  assertTimestamp(resolvedAt, "Encounter resolvedAt");
  if (resolvedAt > decision.deadlineAt) {
    throw new Error("Encounter support choice is after its deadline.");
  }
  if (choice.kind === "give-up") {
    return {
      ...decision,
      stage: "ready-reveal",
      outcome: "give-up",
      decisionOwnerPlayerId: null,
      supportOptions: [],
      openedAt: resolvedAt,
      deadlineAt: resolvedAt,
    };
  }
  const selectedKey = participantKey(choice.participant);
  if (
    !decision.supportOptions.some(
      (option) => participantKey(option) === selectedKey,
    )
  ) {
    throw new Error("Participant is not a legal support option.");
  }
  const active = state.players[decision.activePlayerId];
  if (active?.team === null || active?.team === undefined) {
    throw new Error("Encounter active player has no team.");
  }
  const decisionOwnerPlayerId = opposingDecisionPlayerId(
    state,
    decision.activePlayerId,
  );
  if (decisionOwnerPlayerId === null) {
    throw new Error("Encounter has no living opposing decision player.");
  }
  const opposingTeam = (active.team === 1 ? 2 : 1) as TeamId;
  return {
    ...decision,
    stage: "awaiting-hinder",
    outcome: "fight",
    decisionOwnerPlayerId,
    supporter: choice.participant,
    supportOptions: [],
    hinderOptions: baseOptions(
      state,
      opposingTeam,
      decision.configuredExtraHinderOptions,
    ),
    openedAt: resolvedAt,
    deadlineAt: resolvedAt + ACTION_DEADLINE_MS,
  };
}

export function applyEncounterHinderChoice(
  decision: Readonly<EncounterDecisionState>,
  choice: Readonly<EncounterHinderChoice>,
  resolvedAt: number,
): EncounterDecisionState {
  if (decision.stage !== "awaiting-hinder") {
    throw new Error("Encounter is not awaiting hinder.");
  }
  assertTimestamp(resolvedAt, "Encounter resolvedAt");
  if (resolvedAt > decision.deadlineAt) {
    throw new Error("Encounter hinder choice is after its deadline.");
  }
  if (choice.kind === "choose") {
    const selectedKey = participantKey(choice.participant);
    if (
      !decision.hinderOptions.some(
        (option) => participantKey(option) === selectedKey,
      )
    ) {
      throw new Error("Participant is not a legal hinder option.");
    }
  }
  return {
    ...decision,
    stage: "ready-reveal",
    decisionOwnerPlayerId: null,
    hinder: choice.kind === "choose" ? choice.participant : null,
    hinderOptions: [],
    openedAt: resolvedAt,
    deadlineAt: resolvedAt,
  };
}

export function applyEncounterTimeout(
  decision: Readonly<EncounterDecisionState>,
  state: Readonly<MatchState>,
  resolvedAt: number,
): EncounterDecisionState {
  assertTimestamp(resolvedAt, "Encounter timeout resolvedAt");
  if (resolvedAt < decision.deadlineAt) {
    throw new Error("Encounter timeout cannot resolve before its deadline.");
  }
  if (decision.stage === "awaiting-support") {
    return applyEncounterSupportChoice(
      decision,
      { kind: "give-up" },
      state,
      decision.deadlineAt,
    );
  }
  if (decision.stage === "awaiting-hinder") {
    return applyEncounterHinderChoice(
      decision,
      { kind: "pass" },
      decision.deadlineAt,
    );
  }
  throw new Error("Encounter decision has no timeout to resolve.");
}

export function revealEncounterCard(
  decision: Readonly<EncounterDecisionState>,
  zones: Readonly<EncounterZones>,
): EncounterRevealResult {
  if (decision.stage !== "ready-reveal") {
    throw new Error("Encounter is not ready to reveal.");
  }
  const revealedCardId = zones.encounterDeck[0];
  if (revealedCardId === undefined) {
    return {
      decision: {
        ...decision,
        stage: "deck-empty",
        revealedCardId: null,
      },
      encounterDeck: [],
      encounterDiscard: zones.encounterDiscard,
    };
  }
  const encounterDeck = zones.encounterDeck.slice(1);
  const gaveUp = decision.outcome === "give-up";
  return {
    decision: {
      ...decision,
      stage: gaveUp ? "completed" : "revealed",
      revealedCardId,
    },
    encounterDeck,
    encounterDiscard: gaveUp
      ? [...zones.encounterDiscard, revealedCardId]
      : zones.encounterDiscard,
  };
}

export function projectEncounterDecision(
  decision: Readonly<EncounterDecisionState>,
  viewerPlayerId: PlayerId,
): EncounterDecisionView {
  const availableActions: EncounterDecisionView["availableActions"] =
    decision.decisionOwnerPlayerId !== viewerPlayerId
      ? []
      : decision.stage === "awaiting-support"
        ? [
            {
              type: "choose-encounter-support",
              options: decision.supportOptions,
              canGiveUp: true,
            },
          ]
        : decision.stage === "awaiting-hinder"
          ? [
              {
                type: "choose-encounter-hinder",
                options: decision.hinderOptions,
                canPass: true,
              },
            ]
          : [];
  return {
    activePlayerId: decision.activePlayerId,
    stage: decision.stage,
    outcome: decision.outcome,
    decisionOwnerPlayerId: decision.decisionOwnerPlayerId,
    supporter: decision.supporter,
    hinder: decision.hinder,
    revealedCardId: decision.revealedCardId,
    openedAt: decision.openedAt,
    deadlineAt: decision.deadlineAt,
    availableActions,
  };
}
