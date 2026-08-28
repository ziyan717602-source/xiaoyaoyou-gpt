import type { PlayerId } from "@xiaoyaoyou/protocol";
import type { EncounterCardId, MonsterId, NpcId } from "./encounter-content.js";
import {
  encounterDefinition,
  type NpcActionId,
} from "./encounter-definitions.js";
import {
  revealEncounterCard,
  type EncounterDecisionState,
  type EncounterParticipant,
  type EncounterZones,
} from "./encounter.js";
import type { RngState, TeamId } from "./index.js";
import { nextInt } from "./random.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";

export interface EncounterResolutionZones extends EncounterZones {
  readonly pets: Readonly<Partial<Record<PlayerId, readonly MonsterId[]>>>;
  readonly companions: Readonly<Partial<Record<PlayerId, readonly NpcId[]>>>;
}
interface DecisionWindow {
  readonly choiceId: string;
  readonly ownerPlayerId: PlayerId;
  readonly openedAt: number;
  readonly deadlineAt: number;
}
export interface NpcDecision extends DecisionWindow {
  readonly actionIds: readonly NpcActionId[];
  readonly canPass: boolean;
}
export interface EncounterResolution {
  readonly flowId: string;
  readonly activePlayerId: PlayerId;
  readonly supporter: EncounterParticipant | null;
  readonly hinder: EncounterParticipant | null;
  readonly stage:
    | "monster-effects"
    | "npc-options"
    | "npc-choice"
    | "npc-effect"
    | "pet-choice"
    | "completed"
    | "deck-exhausted";
  readonly heldCardId: EncounterCardId | null;
  readonly revealCount: number;
  readonly updatedAt: number;
  readonly npcDecision: NpcDecision | null;
  readonly petDecision:
    (DecisionWindow & { readonly cardIds: readonly MonsterId[] }) | null;
  readonly pendingEffect: {
    readonly effectId: string;
    readonly actionId: NpcActionId;
    readonly npcId: NpcId;
  } | null;
  readonly result: "monster-battle" | "npc-action" | "give-up" | null;
  readonly rewardDrawCount: 0 | 1 | 2;
  readonly scoreTiming: "none" | "turn-end" | "immediate";
}
export interface EncounterResolutionResult {
  readonly flow: EncounterResolution;
  readonly zones: EncounterResolutionZones;
}

function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid encounter time.");
}
function id(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    ["__proto__", "constructor", "prototype"].includes(value)
  ) {
    throw new Error("Invalid encounter identity.");
  }
}

/** Main/reserve deck partitioning belongs to MatchState; this owns the active
 * main deck, its discard, held card and harvested entities. Never duplicate a
 * held entity in a destination, even between successive serialized frames. */
export function assertEncounterOwnership(
  flow: EncounterResolution | null,
  zones: EncounterResolutionZones,
): void {
  const cards: EncounterCardId[] = [
    ...zones.encounterDeck,
    ...zones.encounterDiscard,
  ];
  if (flow?.heldCardId != null) cards.push(flow.heldCardId);
  for (const [owner, pets] of Object.entries(zones.pets)) {
    id(owner);
    const elements = new Set<string>();
    for (const pet of pets ?? []) {
      const definition = encounterDefinition(pet);
      if (definition.kind !== "monster" || elements.has(definition.element))
        throw new Error("Invalid pet slots.");
      elements.add(definition.element);
      cards.push(pet);
    }
  }
  for (const [owner, companions] of Object.entries(zones.companions)) {
    id(owner);
    for (const companion of companions ?? []) {
      if (encounterDefinition(companion).kind !== "npc")
        throw new Error("Invalid companion.");
      cards.push(companion);
    }
  }
  for (const card of cards) encounterDefinition(card);
  if (new Set(cards).size !== cards.length)
    throw new Error("Duplicate encounter entity.");
}
function checked(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
): EncounterResolutionResult {
  assertEncounterOwnership(flow, zones);
  return { flow, zones };
}
function complete(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
  result: NonNullable<EncounterResolution["result"]>,
): EncounterResolutionResult {
  return checked(
    {
      ...flow,
      stage: "completed",
      heldCardId: null,
      npcDecision: null,
      petDecision: null,
      pendingEffect: null,
      result,
      rewardDrawCount: result === "give-up" ? 1 : 2,
      scoreTiming: zones.encounterDeck.length === 0 ? "turn-end" : "none",
    },
    zones,
  );
}
function revealNext(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
): EncounterResolutionResult {
  if (flow.heldCardId !== null)
    throw new Error("Cannot reveal over a held card.");
  const card = zones.encounterDeck[0];
  if (card === undefined) {
    return checked(
      {
        ...flow,
        stage: "deck-exhausted",
        npcDecision: null,
        pendingEffect: null,
        rewardDrawCount: 0,
        scoreTiming: "immediate",
      },
      zones,
    );
  }
  const definition = encounterDefinition(card);
  return checked(
    {
      ...flow,
      stage: definition.kind === "monster" ? "monster-effects" : "npc-options",
      heldCardId: card,
      revealCount: flow.revealCount + 1,
      npcDecision: null,
      pendingEffect: null,
    },
    { ...zones, encounterDeck: zones.encounterDeck.slice(1) },
  );
}
export function beginEncounterResolution(
  flowId: string,
  decision: EncounterDecisionState,
  zones: EncounterResolutionZones,
): EncounterResolutionResult {
  id(flowId);
  id(decision.activePlayerId);
  timestamp(decision.openedAt);
  assertEncounterOwnership(null, zones);
  if (
    decision.stage !== "ready-reveal" ||
    decision.outcome === null ||
    decision.revealedCardId !== null
  ) {
    throw new Error("Encounter decision is not ready.");
  }
  const flow: EncounterResolution = {
    flowId,
    activePlayerId: decision.activePlayerId,
    supporter: decision.supporter,
    hinder: decision.hinder,
    stage: "deck-exhausted",
    heldCardId: null,
    revealCount: 0,
    updatedAt: decision.openedAt,
    npcDecision: null,
    petDecision: null,
    pendingEffect: null,
    result: null,
    rewardDrawCount: 0,
    scoreTiming: "none",
  };
  if (decision.outcome === "give-up" && zones.encounterDeck.length > 0) {
    const revealed = revealEncounterCard(decision, zones);
    return complete(
      { ...flow, revealCount: 1 },
      {
        ...zones,
        encounterDeck: revealed.encounterDeck,
        encounterDiscard: revealed.encounterDiscard,
      },
      "give-up",
    );
  }
  return revealNext(flow, zones);
}

/** The engine's NPC validity resolver supplies the legal subset, never a client.
 * Missing handlers must fail before this call, not masquerade as no legal actions. */
export function openNpcDecision(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
  legalActions: readonly NpcActionId[],
  openedAt: number,
): EncounterResolutionResult {
  assertEncounterOwnership(flow, zones);
  timestamp(openedAt);
  timestamp(openedAt + ACTION_DEADLINE_MS);
  const definition =
    flow.heldCardId === null ? null : encounterDefinition(flow.heldCardId);
  if (
    flow.stage !== "npc-options" ||
    definition?.kind !== "npc" ||
    openedAt < flow.updatedAt ||
    new Set(legalActions).size !== legalActions.length ||
    legalActions.some((action) => !definition.actionIds.includes(action))
  ) {
    throw new Error("Invalid NPC options.");
  }
  if (legalActions.length === 0)
    return discardNpcAndReveal({ ...flow, updatedAt: openedAt }, zones);
  return checked(
    {
      ...flow,
      stage: "npc-choice",
      updatedAt: openedAt,
      npcDecision: {
        choiceId: `${flow.flowId}:npc:${flow.revealCount}`,
        ownerPlayerId: flow.activePlayerId,
        actionIds: definition.actionIds.filter((action) =>
          legalActions.includes(action),
        ),
        canPass: zones.encounterDeck.length > 0,
        openedAt,
        deadlineAt: openedAt + ACTION_DEADLINE_MS,
      },
    },
    zones,
  );
}
function discardNpcAndReveal(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
): EncounterResolutionResult {
  if (
    flow.heldCardId === null ||
    encounterDefinition(flow.heldCardId).kind !== "npc"
  )
    throw new Error("No held NPC.");
  return revealNext(
    { ...flow, heldCardId: null, npcDecision: null },
    {
      ...zones,
      encounterDiscard: [...zones.encounterDiscard, flow.heldCardId],
    },
  );
}
function validateChoice(
  window: DecisionWindow,
  actor: PlayerId,
  choiceId: string,
  at: number,
): void {
  timestamp(at);
  if (
    actor !== window.ownerPlayerId ||
    choiceId !== window.choiceId ||
    at < window.openedAt ||
    at > window.deadlineAt
  ) {
    throw new Error("Invalid encounter choice.");
  }
}
export function chooseNpcAction(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
  actor: PlayerId,
  choiceId: string,
  actionId: NpcActionId | null,
  at: number,
): EncounterResolutionResult {
  assertEncounterOwnership(flow, zones);
  const choice = flow.npcDecision;
  if (
    flow.stage !== "npc-choice" ||
    choice === null ||
    flow.heldCardId === null ||
    encounterDefinition(flow.heldCardId).kind !== "npc"
  )
    throw new Error("Invalid encounter choice.");
  validateChoice(choice, actor, choiceId, at);
  if (actionId === null) {
    if (!choice.canPass || zones.encounterDeck.length === 0)
      throw new Error("Invalid encounter choice.");
    return discardNpcAndReveal({ ...flow, updatedAt: at }, zones);
  }
  if (!choice.actionIds.includes(actionId))
    throw new Error("Invalid encounter choice.");
  return checked(
    {
      ...flow,
      stage: "npc-effect",
      npcDecision: null,
      updatedAt: at,
      pendingEffect: {
        effectId: `${choice.choiceId}:effect`,
        actionId,
        npcId: flow.heldCardId as NpcId,
      },
    },
    zones,
  );
}
export function defaultNpcAction(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
  rng: RngState,
  at: number,
): EncounterResolutionResult & { readonly rng: RngState } {
  timestamp(at);
  const choice = flow.npcDecision;
  if (flow.stage !== "npc-choice" || choice === null || at < choice.deadlineAt)
    throw new Error("NPC timeout is not due.");
  const drawn = choice.canPass ? null : nextInt(rng, choice.actionIds.length);
  return {
    ...chooseNpcAction(
      flow,
      zones,
      choice.ownerPlayerId,
      choice.choiceId,
      drawn === null ? null : choice.actionIds[drawn.value]!,
      choice.deadlineAt,
    ),
    rng: drawn?.rng ?? rng,
  };
}

/** Internal completion hook: call ONLY after the selected NPC handler and all
 * nested effects/death continuations have resolved. It is not a client action. */
export function finishNpcAction(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
  effectId: string,
): EncounterResolutionResult {
  assertEncounterOwnership(flow, zones);
  const effect = flow.pendingEffect;
  if (
    flow.stage !== "npc-effect" ||
    effect === null ||
    effect.effectId !== effectId ||
    flow.heldCardId !== effect.npcId
  )
    throw new Error("NPC effect is not pending.");
  const destination =
    effect.actionId === "xyy.npc-action.nj09"
      ? {
          ...zones,
          companions: {
            ...zones.companions,
            [flow.activePlayerId]: [
              ...(zones.companions[flow.activePlayerId] ?? []),
              effect.npcId,
            ],
          },
        }
      : {
          ...zones,
          encounterDiscard: [...zones.encounterDiscard, effect.npcId],
        };
  return complete(flow, destination, "npc-action");
}

/** Internal post-effects hook, not a substitute for debut/combat/win/loss rules.
 * Element conflicts create a mandatory retain-one window (Kitty.cs HarvestPet). */
export function finishMonsterBattle(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
  result: {
    readonly outcome: "win" | "lose";
    readonly capture: boolean;
    readonly ownerPlayerId: PlayerId;
  },
  at: number = flow.updatedAt,
): EncounterResolutionResult {
  assertEncounterOwnership(flow, zones);
  timestamp(at);
  id(result.ownerPlayerId);
  const definition =
    flow.heldCardId === null ? null : encounterDefinition(flow.heldCardId);
  if (
    flow.stage !== "monster-effects" ||
    definition?.kind !== "monster" ||
    at < flow.updatedAt ||
    !["win", "lose"].includes(result.outcome) ||
    (result.capture && result.outcome !== "win")
  )
    throw new Error("Battle is not ready to finish.");
  const next = { ...flow, updatedAt: at };
  if (!result.capture)
    return complete(
      next,
      {
        ...zones,
        encounterDiscard: [...zones.encounterDiscard, definition.id],
      },
      "monster-battle",
    );
  const pets = zones.pets[result.ownerPlayerId] ?? [];
  const old = pets.find((pet) => {
    const existing = encounterDefinition(pet);
    return (
      existing.kind === "monster" && existing.element === definition.element
    );
  });
  if (old !== undefined) {
    timestamp(at + ACTION_DEADLINE_MS);
    return checked(
      {
        ...next,
        stage: "pet-choice",
        petDecision: {
          choiceId: `${flow.flowId}:pet:${flow.revealCount}`,
          ownerPlayerId: result.ownerPlayerId,
          cardIds: [old, definition.id],
          openedAt: at,
          deadlineAt: at + ACTION_DEADLINE_MS,
        },
      },
      zones,
    );
  }
  return complete(
    next,
    {
      ...zones,
      pets: { ...zones.pets, [result.ownerPlayerId]: [...pets, definition.id] },
    },
    "monster-battle",
  );
}
export function chooseCapturedPet(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
  actor: PlayerId,
  choiceId: string,
  keptCardId: MonsterId,
  at: number,
): EncounterResolutionResult {
  assertEncounterOwnership(flow, zones);
  const choice = flow.petDecision;
  if (
    flow.stage !== "pet-choice" ||
    choice === null ||
    flow.heldCardId === null
  )
    throw new Error("Invalid encounter choice.");
  validateChoice(choice, actor, choiceId, at);
  if (!choice.cardIds.includes(keptCardId))
    throw new Error("Invalid encounter choice.");
  const pets = zones.pets[actor] ?? [];
  const old = choice.cardIds[0]!;
  if (!pets.includes(old) || choice.cardIds[1] !== flow.heldCardId)
    throw new Error("Pet ownership changed.");
  const discarded = keptCardId === old ? flow.heldCardId : old;
  return complete(
    { ...flow, updatedAt: at },
    {
      ...zones,
      encounterDiscard: [...zones.encounterDiscard, discarded],
      pets: {
        ...zones.pets,
        [actor]: pets.map((pet) => (pet === old ? keptCardId : pet)),
      },
    },
    "monster-battle",
  );
}
export function defaultCapturedPet(
  flow: EncounterResolution,
  zones: EncounterResolutionZones,
  rng: RngState,
  at: number,
): EncounterResolutionResult & { readonly rng: RngState } {
  timestamp(at);
  const choice = flow.petDecision;
  if (flow.stage !== "pet-choice" || choice === null || at < choice.deadlineAt)
    throw new Error("Pet timeout is not due.");
  const drawn = nextInt(rng, choice.cardIds.length);
  const canonicalOptions = [...choice.cardIds].sort();
  return {
    ...chooseCapturedPet(
      flow,
      zones,
      choice.ownerPlayerId,
      choice.choiceId,
      canonicalOptions[drawn.value]!,
      choice.deadlineAt,
    ),
    rng: drawn.rng,
  };
}

export function projectEncounterResolution(
  flow: EncounterResolution,
  viewer: PlayerId,
) {
  const npc = flow.stage === "npc-choice" ? flow.npcDecision : null;
  const pet = flow.stage === "pet-choice" ? flow.petDecision : null;
  const window = npc ?? pet;
  return {
    flowId: flow.flowId,
    activePlayerId: flow.activePlayerId,
    stage: flow.stage,
    heldCardId: flow.heldCardId,
    supporter: flow.supporter,
    hinder: flow.hinder,
    result: flow.result,
    rewardDrawCount: flow.rewardDrawCount,
    decisionOwnerPlayerId: window?.ownerPlayerId ?? null,
    openedAt: window?.openedAt ?? null,
    deadlineAt: window?.deadlineAt ?? null,
    availableActions:
      npc?.ownerPlayerId === viewer
        ? [
            {
              type: "choose-npc-action" as const,
              choiceId: npc.choiceId,
              actionIds: npc.actionIds,
              canPass: npc.canPass,
            },
          ]
        : pet?.ownerPlayerId === viewer
          ? [
              {
                type: "choose-captured-pet" as const,
                choiceId: pet.choiceId,
                cardIds: pet.cardIds,
                canPass: false as const,
              },
            ]
          : [],
  };
}

export interface BattlePlayer {
  readonly playerId: PlayerId;
  readonly team: TeamId;
  readonly seat: number;
  readonly alive: boolean;
  readonly strength: number;
  readonly dexterity: number;
  readonly hitOverride: -1 | 0 | 1;
  readonly winOverride: -1 | 0 | 1;
}
export interface BattleInput {
  readonly players: readonly BattlePlayer[];
  readonly activePlayerId: PlayerId;
  readonly supporterPlayerId: PlayerId | null;
  readonly hinderPlayerId: PlayerId | null;
  readonly monsterStrength: number;
  readonly monsterAgility: number;
  readonly attackingBonus: number;
  readonly defendingBonus: number;
  readonly attackingDrummerPlayerIds?: readonly PlayerId[];
  readonly defendingDrummerPlayerIds?: readonly PlayerId[];
}
function integer(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid battle number.");
  return value;
}
function team(value: TeamId): void {
  if (value !== 1 && value !== 2) throw new Error("Invalid battle team.");
}
export function evaluateBattle(input: BattleInput) {
  const players = [...input.players].sort((a, b) => a.seat - b.seat);
  if (
    new Set(players.map((p) => p.playerId)).size !== players.length ||
    new Set(players.map((p) => p.seat)).size !== players.length
  )
    throw new Error("Duplicate battle participant.");
  for (const p of players) {
    id(p.playerId);
    team(p.team);
    integer(p.strength);
    integer(p.dexterity);
    integer(p.seat);
    if (
      p.seat < 0 ||
      p.seat > 5 ||
      ![-1, 0, 1].includes(p.hitOverride) ||
      ![-1, 0, 1].includes(p.winOverride)
    )
      throw new Error("Invalid battle participant.");
  }
  const active = players.find((p) => p.playerId === input.activePlayerId);
  if (active === undefined)
    throw new Error("Missing active battle participant.");
  const agility = Math.max(integer(input.monsterAgility), 0);
  const hit = (p: BattlePlayer | undefined) =>
    p?.alive === true &&
    (p.hitOverride > 0 ||
      (p.hitOverride === 0 && Math.max(p.dexterity, 0) >= agility));
  function participant(
    playerId: PlayerId | null,
    side: TeamId,
  ): BattlePlayer | undefined {
    if (playerId === null) return undefined;
    const p = players.find((p) => p.playerId === playerId);
    if (p === undefined || p.team !== side)
      throw new Error("Invalid battle side.");
    return p;
  }
  const opponentTeam: TeamId = active.team === 1 ? 2 : 1;
  const support = participant(input.supporterPlayerId, active.team);
  const hinder = participant(input.hinderPlayerId, opponentTeam);
  const supportHit =
    input.supporterPlayerId !== active.playerId && hit(support);
  const hinderHit = hit(hinder);
  const used = new Set(
    [active.playerId, input.supporterPlayerId, input.hinderPlayerId].filter(
      (v) => v !== null,
    ),
  );
  function drums(ids: readonly PlayerId[], side: TeamId): number {
    let strength = 0;
    for (const playerId of ids) {
      if (used.has(playerId)) throw new Error("Duplicate battle role.");
      used.add(playerId);
      const p = participant(playerId, side)!;
      if (hit(p)) strength += Math.max(p.strength, 0);
    }
    return integer(strength);
  }
  const attackingStrength = Math.max(
    integer(
      Math.max(active.strength, 0) +
        integer(input.attackingBonus) +
        (supportHit ? Math.max(support!.strength, 0) : 0) +
        drums(input.attackingDrummerPlayerIds ?? [], active.team),
    ),
    0,
  );
  const defendingStrength = Math.max(
    integer(
      Math.max(integer(input.monsterStrength), 0) +
        integer(input.defendingBonus) +
        (hinderHit ? Math.max(hinder!.strength, 0) : 0) +
        drums(input.defendingDrummerPlayerIds ?? [], opponentTeam),
    ),
    0,
  );
  const forced = players.find((p) => p.alive && p.winOverride !== 0);
  const activeSideWins =
    forced === undefined
      ? attackingStrength >= defendingStrength
      : forced.winOverride > 0
        ? forced.team === active.team
        : forced.team !== active.team;
  return {
    attackingStrength,
    defendingStrength,
    supportHit,
    hinderHit,
    activeSideWins,
  };
}
export function evaluatePetScore(
  owners: readonly {
    readonly playerId: PlayerId;
    readonly team: TeamId;
    readonly alive: boolean;
    readonly pets: readonly {
      readonly cardId: MonsterId;
      readonly strength: number;
    }[];
  }[],
): { readonly team1: number; readonly team2: number; readonly winner: TeamId } {
  let team1 = 0,
    team2 = 0;
  const seen = new Set<string>();
  const playerIds = new Set<string>();
  for (const owner of owners) {
    id(owner.playerId);
    team(owner.team);
    if (playerIds.has(owner.playerId))
      throw new Error("Duplicate score owner.");
    playerIds.add(owner.playerId);
    for (const pet of owner.pets) {
      if (
        encounterDefinition(pet.cardId).kind !== "monster" ||
        seen.has(pet.cardId)
      )
        throw new Error("Invalid scoring pet.");
      seen.add(pet.cardId);
      integer(pet.strength);
      if (owner.alive) {
        if (owner.team === 1)
          team1 = integer(team1 + Math.max(pet.strength, 0));
        else team2 = integer(team2 + Math.max(pet.strength, 0));
      }
    }
  }
  return { team1, team2, winner: team1 > team2 ? 1 : 2 };
}
