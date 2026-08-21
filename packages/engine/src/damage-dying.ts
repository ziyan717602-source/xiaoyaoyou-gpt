import type {
  CommandEnvelope,
  CommandId,
  EffectId,
  PlayerId,
} from "@xiaoyaoyou/protocol";
import type {
  ApplyCommandResult,
  DomainEvent,
  EngineCommand,
} from "./architecture.js";
import type {
  DyingBatch,
  MatchState,
  PendingChoice,
  PlayerState,
  TeamId,
} from "./index.js";
import { planCureBatch, playersAfterCures } from "./healing.js";
import {
  canonicalHpEvolutionMask,
  hasHpEvolutionFlag,
  type HpEvolutionFlag,
} from "./hp-evolution.js";
import {
  cardDefinition,
  handLimitForHero,
  heroDefinition,
  heroHasSkill,
  type CardInstanceId,
} from "./setup-content.js";
import { beginDamageResponse } from "./reaction.js";
import { reduceTurnEvent } from "./turn.js";

export const RESCUE_DEADLINE_MS = 15_000;

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function playerCards(player: Readonly<PlayerState>): readonly CardInstanceId[] {
  return [
    ...player.hand,
    ...(player.equipment.weapon === null ? [] : [player.equipment.weapon]),
    ...(player.equipment.armor === null ? [] : [player.equipment.armor]),
  ];
}

function deadBatchCards(
  state: Readonly<MatchState>,
  batch: Readonly<DyingBatch>,
): readonly CardInstanceId[] {
  return batch.deadPlayerIds.flatMap((playerId) =>
    playerCards(state.players[playerId]!),
  );
}

function jn50203Owner(
  state: Readonly<MatchState>,
  batch: Readonly<DyingBatch>,
): PlayerState | undefined {
  if (aliveTeams(state).length <= 1) return undefined;
  return Object.values(state.players)
    .filter(
      (player) =>
        player.alive &&
        player.heroId !== null &&
        !batch.deadPlayerIds.includes(player.id) &&
        heroHasSkill(player.heroId, "xyy.skill.jn50203"),
    )
    .sort((left, right) => left.seat - right.seat)[0];
}

export interface DamageIntent {
  readonly itemId: string;
  readonly sourcePlayerId: PlayerId | null;
  readonly targetPlayerId: PlayerId;
  readonly amount: number;
  readonly element: string;
  /** Canonical names for the combinable legacy C# HPEvoMask flags. */
  readonly hpEvoMask?: readonly HpEvolutionFlag[];
}

export interface DamageModifier {
  readonly effectId: EffectId;
  readonly sourcePlayerId: PlayerId;
  readonly priority: number;
  readonly kind: "replacement" | "addition" | "reduction";
  readonly amount: number;
  readonly replacementTargetPlayerId?: PlayerId;
}

export interface AppliedDamage {
  readonly itemId: string;
  readonly sourcePlayerId: PlayerId | null;
  readonly targetPlayerId: PlayerId;
  readonly amount: number;
  readonly element: string;
  readonly hpEvoMask: readonly HpEvolutionFlag[];
  readonly appliedReplacementEffectIds: readonly EffectId[];
  readonly appliedModifierCardInstanceIds: readonly CardInstanceId[];
}

function numberPayload(event: Readonly<DomainEvent>, key: string): number {
  const value = event.payload[key];
  if (typeof value !== "number") throw new Error(`Invalid ${key} payload.`);
  return value;
}

function stringPayload(event: Readonly<DomainEvent>, key: string): string {
  const value = event.payload[key];
  if (typeof value !== "string") throw new Error(`Invalid ${key} payload.`);
  return value;
}

function stringsPayload(
  event: Readonly<DomainEvent>,
  key: string,
): readonly string[] {
  const value = event.payload[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid ${key} payload.`);
  }
  return value as string[];
}

function seatOrder(
  state: Readonly<MatchState>,
  livingOnly = true,
): readonly PlayerId[] {
  return Object.values(state.players)
    .filter((player) => !livingOnly || player.alive)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
}

function priorityFromTarget(
  state: Readonly<MatchState>,
  targetPlayerId: PlayerId,
): readonly PlayerId[] {
  const living = seatOrder(state);
  const start = living.indexOf(targetPlayerId);
  if (start < 0) return living;
  return Array.from(
    { length: living.length },
    (_, offset) => living[(start + offset) % living.length]!,
  );
}

function modifierSeat(
  state: Readonly<MatchState>,
  modifier: DamageModifier,
): number {
  return (
    state.players[modifier.sourcePlayerId]?.seat ?? Number.MAX_SAFE_INTEGER
  );
}

export function planDamageBatch(
  state: Readonly<MatchState>,
  intents: readonly DamageIntent[],
  modifiers: readonly DamageModifier[] = [],
): readonly AppliedDamage[] {
  for (const modifier of modifiers) {
    if (!Number.isSafeInteger(modifier.amount) || modifier.amount < 0) {
      throw new Error(
        "Damage modifier amount must be a nonnegative safe integer.",
      );
    }
    if (!Number.isSafeInteger(modifier.priority)) {
      throw new Error("Damage modifier priority must be a safe integer.");
    }
  }
  const orderedModifiers = [...modifiers].sort(
    (left, right) =>
      left.priority - right.priority ||
      modifierSeat(state, left) - modifierSeat(state, right) ||
      left.effectId.localeCompare(right.effectId),
  );
  const planned = intents.map((intent) => {
    if (!Number.isSafeInteger(intent.amount) || intent.amount < 0) {
      throw new Error("Damage amount must be a nonnegative safe integer.");
    }
    let targetPlayerId = intent.targetPlayerId;
    let amount = intent.amount;
    const hpEvoMask = canonicalHpEvolutionMask(intent.hpEvoMask);
    const replacements = new Set<EffectId>();
    for (const modifier of orderedModifiers) {
      if (modifier.kind !== "replacement") continue;
      if (replacements.has(modifier.effectId)) continue;
      replacements.add(modifier.effectId);
      targetPlayerId = modifier.replacementTargetPlayerId ?? targetPlayerId;
      amount = modifier.amount;
    }
    for (const modifier of orderedModifiers) {
      if (modifier.kind === "addition") amount += modifier.amount;
    }
    for (const modifier of orderedModifiers) {
      if (modifier.kind === "reduction") amount -= modifier.amount;
    }
    if (!Number.isSafeInteger(amount)) {
      throw new Error("Modified damage amount must remain a safe integer.");
    }
    const target = state.players[targetPlayerId];
    if (target === undefined) {
      throw new Error(`Unknown damage target ${targetPlayerId}.`);
    }
    amount = Math.max(0, amount);
    return {
      intent,
      target,
      targetPlayerId,
      amount,
      hpEvoMask,
      appliedReplacementEffectIds: [...replacements],
    };
  });
  const jn50501TriggeredOwners = new Set(
    planned
      .filter(
        ({ intent, target, amount, hpEvoMask }) =>
          amount > 0 &&
          target.heroId !== null &&
          heroHasSkill(target.heroId, "xyy.skill.jn50501") &&
          (intent.element === "water" || intent.element === "fire") &&
          !hasHpEvolutionFlag(hpEvoMask, "immune-inavo"),
      )
      .map(({ targetPlayerId }) => targetPlayerId),
  );
  return planned.flatMap((item) => {
    const {
      intent,
      target,
      targetPlayerId,
      hpEvoMask,
      appliedReplacementEffectIds,
    } = item;
    let { amount } = item;
    if (
      jn50501TriggeredOwners.has(targetPlayerId) &&
      (intent.element === "water" || intent.element === "fire") &&
      !hasHpEvolutionFlag(hpEvoMask, "immune-inavo")
    ) {
      return [];
    }
    const appliedModifierCardInstanceIds: CardInstanceId[] = [];
    const armor = target.equipment.armor;
    if (
      amount > 0 &&
      armor !== null &&
      cardDefinition(armor).id === "xyy.card.fj03" &&
      !hasHpEvolutionFlag(hpEvoMask, "termin-at") &&
      !hasHpEvolutionFlag(hpEvoMask, "decr-inavo")
    ) {
      amount -= 1;
      appliedModifierCardInstanceIds.push(armor);
      if (amount === 0) return [];
    }
    if (
      amount > 0 &&
      armor !== null &&
      cardDefinition(armor).id === "xyy.card.fj04" &&
      hasHpEvolutionFlag(hpEvoMask, "from-jp") &&
      !hasHpEvolutionFlag(hpEvoMask, "immune-inavo")
    ) {
      return [];
    }
    return [
      {
        ...intent,
        targetPlayerId,
        amount,
        hpEvoMask,
        appliedReplacementEffectIds,
        appliedModifierCardInstanceIds,
      },
    ];
  });
}

function makePendingChoice(
  state: Readonly<MatchState>,
  batch: DyingBatch,
): PendingChoice {
  const priority = batch.priorityOrder[batch.priorityIndex];
  if (priority === undefined) throw new Error("Rescue priority is empty.");
  return {
    choiceId: `${batch.batchId}:choice:${batch.currentIndex}`,
    playerIds: [priority],
    prompt: `rescue:${batch.currentTargetPlayerId}`,
    minSelections: 0,
    maxSelections: 1,
    optionIds: [batch.currentTargetPlayerId],
    optional: true,
    status: "open",
    openedAt: batch.openedAt,
    deadlineAt: batch.deadlineAt,
    fallback: "pass",
    continuation: {
      continuationId: `${batch.batchId}:continuation:${batch.currentIndex}`,
      effectId: batch.sourceEffectId,
      step: "after-rescue",
      locals: {
        batchId: batch.batchId,
        targetPlayerId: batch.currentTargetPlayerId,
      },
      resumeWith: "advance-dying-batch",
    },
  };
}

function openTarget(
  state: Readonly<MatchState>,
  batch: DyingBatch,
  fromIndex: number,
  openedAt: number,
): MatchState {
  let currentIndex = fromIndex;
  while (currentIndex < batch.targetPlayerIds.length) {
    const candidate = state.players[batch.targetPlayerIds[currentIndex]!];
    if (candidate?.alive === true && candidate.hp === 0) break;
    currentIndex += 1;
  }
  if (currentIndex >= batch.targetPlayerIds.length) {
    return batch.deadPlayerIds.length === 0
      ? { ...state, dyingBatch: null, pendingChoice: null }
      : {
          ...state,
          dyingBatch: {
            ...batch,
            status: "awaiting-batch-cleanup",
            openedAt,
            deadlineAt: openedAt,
          },
          pendingChoice: null,
        };
  }
  const currentTargetPlayerId = batch.targetPlayerIds[currentIndex]!;
  const priorityOrder = priorityFromTarget(state, currentTargetPlayerId);
  const opened: DyingBatch = {
    ...batch,
    currentIndex,
    currentTargetPlayerId,
    priorityOrder,
    priorityIndex: 0,
    passedPlayerIds: [],
    status: "awaiting-rescue",
    openedAt,
    deadlineAt: openedAt + RESCUE_DEADLINE_MS,
  };
  return {
    ...state,
    dyingBatch: opened,
    pendingChoice: makePendingChoice(state, opened),
  };
}

export function beginDyingBatch(
  state: Readonly<MatchState>,
  sourceEffectId: EffectId,
  openedAt: number,
): MatchState {
  const targetPlayerIds = Object.values(state.players)
    .filter((player) => player.alive && player.hp === 0)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
  if (targetPlayerIds.length === 0) {
    return { ...state, dyingBatch: null, pendingChoice: null };
  }
  const initial: DyingBatch = {
    batchId: `${state.matchId}:dying:${sourceEffectId}`,
    sourceEffectId,
    targetPlayerIds,
    currentIndex: 0,
    currentTargetPlayerId: targetPlayerIds[0]!,
    priorityOrder: [],
    priorityIndex: 0,
    passedPlayerIds: [],
    rescuedPlayerIds: [],
    deadPlayerIds: [],
    status: "awaiting-rescue",
    openedAt,
    deadlineAt: openedAt + RESCUE_DEADLINE_MS,
  };
  return openTarget(state, initial, 0, openedAt);
}

export function applyPlannedDamage(
  state: Readonly<MatchState>,
  sourceEffectId: EffectId,
  applied: readonly AppliedDamage[],
  openedAt: number,
): MatchState {
  const players: Record<PlayerId, PlayerState> = { ...state.players };
  for (const damage of applied) {
    const target = players[damage.targetPlayerId];
    if (target === undefined || !target.alive) {
      throw new Error("Applied damage target is not alive.");
    }
    players[damage.targetPlayerId] = {
      ...target,
      hp: Math.max(0, target.hp - damage.amount),
    };
  }
  return beginDyingBatch({ ...state, players }, sourceEffectId, openedAt);
}

function advanceBatch(
  state: Readonly<MatchState>,
  batch: DyingBatch,
  openedAt: number,
): MatchState {
  return openTarget(state, batch, batch.currentIndex + 1, openedAt);
}

export function reduceDyingEvent(
  state: Readonly<MatchState>,
  event: Readonly<DomainEvent>,
): MatchState {
  if (
    event.matchId !== state.matchId ||
    event.sequence !== state.eventSequence + 1 ||
    event.rulesetVersion !== state.rulesetVersion
  ) {
    throw new Error("Dying event does not extend the current match head.");
  }
  if (
    state.phase !== "playing" ||
    (state.turn?.phase !== "action" && state.turn?.phase !== "reward")
  ) {
    throw new Error("Dying events require an interactive turn phase.");
  }
  const matchVersion = numberPayload(event, "matchVersion");
  const expectedMatchVersion =
    event.causationEventId === null ? state.version + 1 : state.version;
  if (matchVersion !== expectedMatchVersion) {
    throw new Error("Dying event has an invalid match version.");
  }
  const batch = state.dyingBatch;
  if (batch === null) throw new Error("Dying batch is missing.");
  let next: MatchState;
  if (event.type === "rescue.passed") {
    const playerId = stringPayload(event, "playerId");
    const choiceId = stringPayload(event, "choiceId");
    const passedAt = numberPayload(event, "passedAt");
    const priority = batch.priorityOrder[batch.priorityIndex];
    if (
      batch.status !== "awaiting-rescue" ||
      state.pendingChoice?.status !== "open" ||
      state.pendingChoice.choiceId !== choiceId ||
      priority !== playerId
    ) {
      throw new Error("Rescue pass is not applicable.");
    }
    const passedPlayerIds = [...batch.passedPlayerIds, playerId];
    const closed = passedPlayerIds.length === batch.priorityOrder.length;
    const updated: DyingBatch = {
      ...batch,
      passedPlayerIds,
      priorityIndex: closed ? batch.priorityIndex : batch.priorityIndex + 1,
      status: closed ? "awaiting-death" : "awaiting-rescue",
      openedAt: passedAt,
      deadlineAt: passedAt + RESCUE_DEADLINE_MS,
    };
    next = {
      ...state,
      dyingBatch: updated,
      pendingChoice: closed
        ? { ...state.pendingChoice, status: "closed" }
        : makePendingChoice(state, updated),
    };
  } else if (event.type === "rescue.card-played") {
    const playerId = stringPayload(event, "playerId");
    const targetPlayerId = stringPayload(event, "targetPlayerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const rescuedAt = numberPayload(event, "rescuedAt");
    const player = state.players[playerId];
    const target = state.players[targetPlayerId];
    if (
      batch.status !== "awaiting-rescue" ||
      state.pendingChoice?.status !== "open" ||
      batch.priorityOrder[batch.priorityIndex] !== playerId ||
      targetPlayerId !== batch.currentTargetPlayerId ||
      player === undefined ||
      target === undefined ||
      !target.alive ||
      target.hp !== 0 ||
      !player.hand.includes(cardInstanceId) ||
      cardDefinition(cardInstanceId).rescueAction?.type !== "rescue-two"
    ) {
      throw new Error("Rescue card event is not applicable.");
    }
    const expectedCures = planCureBatch(state, [
      {
        itemId: `${event.eventId}:cure:0`,
        sourcePlayerId: playerId,
        targetPlayerId,
        amount: 2,
        element: "neutral",
      },
    ]);
    if (
      JSON.stringify(event.payload.healingItems) !==
      JSON.stringify(expectedCures)
    ) {
      throw new Error("Rescue healing disagrees with deterministic plan.");
    }
    const curedPlayers = playersAfterCures(state, expectedCures);
    const intermediate: MatchState = {
      ...state,
      players: {
        ...curedPlayers,
        [playerId]: {
          ...curedPlayers[playerId]!,
          hand: player.hand.filter((card) => card !== cardInstanceId),
        },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      dyingBatch: {
        ...batch,
        rescuedPlayerIds: [...batch.rescuedPlayerIds, targetPlayerId],
      },
      pendingChoice: null,
    };
    next = advanceBatch(intermediate, intermediate.dyingBatch!, rescuedAt);
  } else if (event.type === "rescue.skill-card-converted") {
    const playerId = stringPayload(event, "playerId");
    const targetPlayerId = stringPayload(event, "targetPlayerId");
    const cardInstanceIds = stringsPayload(
      event,
      "cardInstanceIds",
    ) as readonly CardInstanceId[];
    const skillId = stringPayload(event, "skillId");
    const rescuedAt = numberPayload(event, "rescuedAt");
    const player = state.players[playerId];
    const target = state.players[targetPlayerId];
    if (
      batch.status !== "awaiting-rescue" ||
      state.pendingChoice?.status !== "open" ||
      batch.priorityOrder[batch.priorityIndex] !== playerId ||
      targetPlayerId !== batch.currentTargetPlayerId ||
      player === undefined ||
      player.heroId === null ||
      target === undefined ||
      !target.alive ||
      target.hp !== 0 ||
      skillId !== "xyy.skill.jn40301" ||
      !heroHasSkill(player.heroId, "xyy.skill.jn40301") ||
      cardInstanceIds.length !== 2 ||
      new Set(cardInstanceIds).size !== 2 ||
      cardInstanceIds.some((card) => !player.hand.includes(card))
    ) {
      throw new Error("Skill-converted rescue is not applicable.");
    }
    const expectedCures = planCureBatch(state, [
      {
        itemId: `${event.eventId}:cure:0`,
        sourcePlayerId: playerId,
        targetPlayerId,
        amount: 2,
        element: "neutral",
      },
    ]);
    if (
      JSON.stringify(event.payload.healingItems) !==
      JSON.stringify(expectedCures)
    ) {
      throw new Error(
        "Skill-converted rescue healing disagrees with deterministic plan.",
      );
    }
    const paidCards = new Set(cardInstanceIds);
    const curedPlayers = playersAfterCures(state, expectedCures);
    const intermediate: MatchState = {
      ...state,
      players: {
        ...curedPlayers,
        [playerId]: {
          ...curedPlayers[playerId]!,
          hand: player.hand.filter((card) => !paidCards.has(card)),
        },
      },
      discardPile: [...state.discardPile, ...cardInstanceIds],
      dyingBatch: {
        ...batch,
        rescuedPlayerIds: [...batch.rescuedPlayerIds, targetPlayerId],
      },
      pendingChoice: null,
    };
    next = advanceBatch(intermediate, intermediate.dyingBatch!, rescuedAt);
  } else if (event.type === "rescue.equipment-activated") {
    const playerId = stringPayload(event, "playerId");
    const targetPlayerId = stringPayload(event, "targetPlayerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const rescuedAt = numberPayload(event, "rescuedAt");
    const player = state.players[playerId];
    if (
      batch.status !== "awaiting-rescue" ||
      state.pendingChoice?.status !== "open" ||
      batch.priorityOrder[batch.priorityIndex] !== playerId ||
      targetPlayerId !== playerId ||
      targetPlayerId !== batch.currentTargetPlayerId ||
      player === undefined ||
      !player.alive ||
      player.hp !== 0 ||
      player.equipment.armor !== cardInstanceId ||
      cardDefinition(cardInstanceId).id !== "xyy.card.fj01"
    ) {
      throw new Error("Rescue equipment event is not applicable.");
    }
    const expectedCures = planCureBatch(state, [
      {
        itemId: `${event.eventId}:cure:0`,
        sourcePlayerId: playerId,
        targetPlayerId,
        amount: 2,
        element: "neutral",
      },
    ]);
    if (
      JSON.stringify(event.payload.healingItems) !==
      JSON.stringify(expectedCures)
    ) {
      throw new Error(
        "Rescue equipment healing disagrees with deterministic plan.",
      );
    }
    const curedPlayers = playersAfterCures(state, expectedCures);
    const intermediate: MatchState = {
      ...state,
      players: {
        ...curedPlayers,
        [playerId]: {
          ...curedPlayers[playerId]!,
          equipment: { ...player.equipment, armor: null },
        },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      dyingBatch: {
        ...batch,
        rescuedPlayerIds: [...batch.rescuedPlayerIds, targetPlayerId],
      },
      pendingChoice: null,
    };
    next = advanceBatch(intermediate, intermediate.dyingBatch!, rescuedAt);
  } else if (event.type === "death.hero-transformed") {
    const playerId = stringPayload(event, "playerId");
    const sourceHeroId = stringPayload(event, "sourceHeroId");
    const targetHeroId = stringPayload(event, "targetHeroId");
    const completedAt = numberPayload(event, "completedAt");
    const preservedCardInstanceIds = stringsPayload(
      event,
      "preservedCardInstanceIds",
    ) as readonly CardInstanceId[];
    const player = state.players[playerId];
    const targetHero = heroDefinition("xyy.hero.xj207");
    if (
      batch.status !== "awaiting-death" ||
      playerId !== batch.currentTargetPlayerId ||
      player === undefined ||
      !player.alive ||
      player.hp !== 0 ||
      player.heroId !== "xyy.hero.xj206" ||
      !heroHasSkill(player.heroId, "xyy.skill.jn20602") ||
      sourceHeroId !== "xyy.hero.xj206" ||
      targetHeroId !== "xyy.hero.xj207" ||
      !sameValues(preservedCardInstanceIds, playerCards(player))
    ) {
      throw new Error("JN20602 transformation is not applicable.");
    }
    const transformed: MatchState = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          heroId: targetHero.id,
          alive: true,
          hp: targetHero.maxHp,
          maxHp: targetHero.maxHp,
          strength: targetHero.strength,
          dexterity: targetHero.dexterity,
          handLimit: handLimitForHero(targetHero.id),
        },
      },
      pendingChoice: null,
    };
    next = advanceBatch(transformed, batch, completedAt);
  } else if (event.type === "death.player-died") {
    const playerId = stringPayload(event, "playerId");
    const player = state.players[playerId];
    if (
      batch.status !== "awaiting-death" ||
      playerId !== batch.currentTargetPlayerId ||
      player === undefined ||
      !player.alive ||
      player.hp !== 0
    ) {
      throw new Error("Death event is not applicable.");
    }
    const discarded = playerCards(player);
    const expectedDiscarded = stringsPayload(event, "cardInstanceIds");
    if (
      discarded.length !== expectedDiscarded.length ||
      discarded.some((card, index) => card !== expectedDiscarded[index])
    ) {
      throw new Error("Death cleanup cards do not match player zones.");
    }
    next = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          alive: false,
          hp: 0,
        },
      },
      dyingBatch: {
        ...batch,
        deadPlayerIds: [...batch.deadPlayerIds, playerId],
        status: "after-death",
      },
      pendingChoice: null,
    };
  } else if (event.type === "death.after-effects-completed") {
    const playerId = stringPayload(event, "playerId");
    const completedAt = numberPayload(event, "completedAt");
    if (
      batch.status !== "after-death" ||
      playerId !== batch.currentTargetPlayerId ||
      state.players[playerId]?.alive !== false
    ) {
      throw new Error("After-death completion is not applicable.");
    }
    next = advanceBatch(state, batch, completedAt);
  } else if (event.type === "death.batch-cleaned") {
    const deadPlayerIds = stringsPayload(
      event,
      "deadPlayerIds",
    ) as readonly PlayerId[];
    const cardInstanceIds = stringsPayload(
      event,
      "cardInstanceIds",
    ) as readonly CardInstanceId[];
    const expectedCards = deadBatchCards(state, batch);
    if (
      batch.status !== "awaiting-batch-cleanup" ||
      !sameValues(deadPlayerIds, batch.deadPlayerIds) ||
      !sameValues(cardInstanceIds, expectedCards)
    ) {
      throw new Error("Death batch cleanup is not applicable.");
    }
    const players = { ...state.players };
    for (const playerId of batch.deadPlayerIds) {
      const player = players[playerId]!;
      players[playerId] = {
        ...player,
        hand: [],
        equipment: { weapon: null, armor: null },
      };
    }
    next = {
      ...state,
      players,
      discardPile: [...state.discardPile, ...cardInstanceIds],
      dyingBatch: null,
      pendingChoice: null,
    };
  } else if (event.type === "death.loot-opened") {
    const ownerPlayerId = stringPayload(event, "ownerPlayerId");
    const deadPlayerIds = stringsPayload(
      event,
      "deadPlayerIds",
    ) as readonly PlayerId[];
    const cardInstanceIds = stringsPayload(
      event,
      "cardInstanceIds",
    ) as readonly CardInstanceId[];
    const choiceId = stringPayload(event, "choiceId");
    const openedAt = numberPayload(event, "openedAt");
    const owner = jn50203Owner(state, batch);
    const expectedCards = deadBatchCards(state, batch);
    if (
      batch.status !== "awaiting-batch-cleanup" ||
      owner?.id !== ownerPlayerId ||
      expectedCards.length === 0 ||
      !sameValues(deadPlayerIds, batch.deadPlayerIds) ||
      !sameValues(cardInstanceIds, expectedCards) ||
      choiceId !== `${batch.batchId}:choice:jn50203`
    ) {
      throw new Error("JN50203 loot opening is not applicable.");
    }
    const players = { ...state.players };
    for (const playerId of batch.deadPlayerIds) {
      const player = players[playerId]!;
      players[playerId] = {
        ...player,
        hand: [],
        equipment: { weapon: null, armor: null },
      };
    }
    players[owner.id] = {
      ...owner,
      hand: [...owner.hand, ...cardInstanceIds],
    };
    next = {
      ...state,
      players,
      dyingBatch: {
        ...batch,
        status: "distributing-loot",
        openedAt,
        deadlineAt: openedAt + RESCUE_DEADLINE_MS,
      },
      pendingChoice: {
        choiceId,
        playerIds: [owner.id],
        prompt: "jn50203-distribute-loot",
        minSelections: 0,
        maxSelections: cardInstanceIds.length,
        optionIds: cardInstanceIds,
        optional: true,
        status: "open",
        openedAt,
        deadlineAt: openedAt + RESCUE_DEADLINE_MS,
        fallback: "pass",
        continuation: {
          continuationId: `${choiceId}:continuation`,
          effectId: batch.sourceEffectId,
          step: "distribute-jn50203-loot",
          locals: { ownerPlayerId: owner.id },
          resumeWith: "finish-jn50203-loot",
        },
      },
    };
  } else if (event.type === "death.loot-distributed") {
    const ownerPlayerId = stringPayload(event, "ownerPlayerId");
    const targetPlayerId = stringPayload(event, "targetPlayerId");
    const choiceId = stringPayload(event, "choiceId");
    const cardInstanceIds = stringsPayload(
      event,
      "cardInstanceIds",
    ) as readonly CardInstanceId[];
    const remainingCardInstanceIds = stringsPayload(
      event,
      "remainingCardInstanceIds",
    ) as readonly CardInstanceId[];
    const distributedAt = numberPayload(event, "distributedAt");
    const choice = state.pendingChoice;
    const owner = state.players[ownerPlayerId];
    const target = state.players[targetPlayerId];
    const selected = new Set<string>(cardInstanceIds);
    const expectedRemaining =
      choice?.optionIds.filter((card) => !selected.has(card)) ?? [];
    if (
      batch.status !== "distributing-loot" ||
      choice === null ||
      choice.status !== "open" ||
      choice.choiceId !== choiceId ||
      choice.playerIds[0] !== ownerPlayerId ||
      owner === undefined ||
      !owner.alive ||
      target === undefined ||
      !target.alive ||
      target.id === owner.id ||
      cardInstanceIds.length === 0 ||
      selected.size !== cardInstanceIds.length ||
      cardInstanceIds.some(
        (card) =>
          !choice.optionIds.includes(card) || !owner.hand.includes(card),
      ) ||
      !sameValues(remainingCardInstanceIds, expectedRemaining)
    ) {
      throw new Error("JN50203 loot distribution is not applicable.");
    }
    const nextChoice =
      remainingCardInstanceIds.length === 0
        ? null
        : {
            ...choice,
            optionIds: remainingCardInstanceIds,
            maxSelections: remainingCardInstanceIds.length,
            openedAt: distributedAt,
            deadlineAt: distributedAt + RESCUE_DEADLINE_MS,
          };
    next = {
      ...state,
      players: {
        ...state.players,
        [owner.id]: {
          ...owner,
          hand: owner.hand.filter((card) => !selected.has(card)),
        },
        [target.id]: {
          ...target,
          hand: [...target.hand, ...cardInstanceIds],
        },
      },
      dyingBatch: {
        ...batch,
        openedAt: distributedAt,
        deadlineAt: distributedAt + RESCUE_DEADLINE_MS,
      },
      pendingChoice: nextChoice,
    };
  } else if (event.type === "death.loot-finished") {
    const ownerPlayerId = stringPayload(event, "ownerPlayerId");
    const choiceId = stringPayload(event, "choiceId");
    const finishedAt = numberPayload(event, "finishedAt");
    const remainingCardInstanceIds = stringsPayload(
      event,
      "remainingCardInstanceIds",
    ) as readonly CardInstanceId[];
    const choice = state.pendingChoice;
    const owner = state.players[ownerPlayerId];
    const expectedRemaining = choice?.optionIds ?? [];
    if (
      batch.status !== "distributing-loot" ||
      owner === undefined ||
      !owner.alive ||
      (choice !== null &&
        (choice.status !== "open" ||
          choice.choiceId !== choiceId ||
          choice.playerIds[0] !== ownerPlayerId)) ||
      (choice === null && choiceId !== `${batch.batchId}:choice:jn50203`) ||
      !sameValues(remainingCardInstanceIds, expectedRemaining)
    ) {
      throw new Error("JN50203 loot finish is not applicable.");
    }
    const cleared: MatchState = {
      ...state,
      dyingBatch: null,
      pendingChoice: null,
    };
    const sourceEffectId = `${event.eventId}:jn50203`;
    const expectedDamage = planDamageBatch(cleared, [
      {
        itemId: `${sourceEffectId}:damage:0`,
        sourcePlayerId: owner.id,
        targetPlayerId: owner.id,
        amount: 1,
        element: "neutral",
      },
    ]);
    if (
      JSON.stringify(event.payload.damageItems) !==
      JSON.stringify(expectedDamage)
    ) {
      throw new Error("JN50203 self damage disagrees with deterministic plan.");
    }
    next = beginDamageResponse(
      cleared,
      sourceEffectId,
      owner.id,
      expectedDamage,
      finishedAt,
    );
  } else {
    throw new Error(`Unsupported dying event ${event.type}.`);
  }
  return { ...next, version: matchVersion, eventSequence: event.sequence };
}

function aliveTeams(state: Readonly<MatchState>): readonly TeamId[] {
  return [
    ...new Set(
      Object.values(state.players)
        .filter((player) => player.alive && player.team !== null)
        .map((player) => player.team!),
    ),
  ].sort();
}

class EventBuilder {
  readonly events: DomainEvent[] = [];
  state: MatchState;

  constructor(
    state: Readonly<MatchState>,
    private readonly commandId: CommandId,
    private readonly matchVersion: number,
    private readonly serverReceivedAt: number,
  ) {
    this.state = state as MatchState;
  }

  append(type: string, payload: Readonly<Record<string, unknown>>): void {
    const sequence = this.state.eventSequence + 1;
    const previous = this.events.at(-1);
    const event: DomainEvent = {
      eventId: `${this.state.matchId}:event:${sequence}`,
      sequence,
      matchId: this.state.matchId,
      causationCommandId: this.commandId,
      causationEventId: previous?.eventId ?? null,
      rulesetVersion: this.state.rulesetVersion,
      type,
      payload: { ...payload, matchVersion: this.matchVersion },
    };
    this.events.push(event);
    this.state =
      type === "match.finished"
        ? reduceTurnEvent(this.state, event)
        : reduceDyingEvent(this.state, event);
  }

  resolveClosedRescue(): void {
    if (this.state.dyingBatch?.status !== "awaiting-death") return;
    const playerId = this.state.dyingBatch.currentTargetPlayerId;
    const player = this.state.players[playerId]!;
    if (
      player.heroId !== null &&
      heroHasSkill(player.heroId, "xyy.skill.jn20602")
    ) {
      this.append("death.hero-transformed", {
        playerId,
        sourceHeroId: "xyy.hero.xj206",
        targetHeroId: "xyy.hero.xj207",
        preservedCardInstanceIds: playerCards(player),
        completedAt: this.serverReceivedAt,
      });
      this.resolveBatchCleanup();
      return;
    }
    const cardInstanceIds = playerCards(player);
    this.append("death.player-died", { playerId, cardInstanceIds });
    this.append("death.after-effects-completed", {
      playerId,
      completedAt: this.serverReceivedAt,
    });
    this.resolveBatchCleanup();
  }

  resolveBatchCleanup(): void {
    const batch = this.state.dyingBatch;
    if (batch?.status !== "awaiting-batch-cleanup") return;
    const cardInstanceIds = deadBatchCards(this.state, batch);
    const owner = jn50203Owner(this.state, batch);
    if (owner !== undefined && cardInstanceIds.length > 0) {
      this.append("death.loot-opened", {
        ownerPlayerId: owner.id,
        deadPlayerIds: batch.deadPlayerIds,
        cardInstanceIds,
        choiceId: `${batch.batchId}:choice:jn50203`,
        openedAt: this.serverReceivedAt,
      });
    } else {
      this.append("death.batch-cleaned", {
        deadPlayerIds: batch.deadPlayerIds,
        cardInstanceIds,
        completedAt: this.serverReceivedAt,
      });
    }
  }

  finishLoot(timeout: boolean): void {
    const batch = this.state.dyingBatch;
    if (batch?.status !== "distributing-loot") {
      throw new Error("JN50203 loot is not ready to finish.");
    }
    const owner = jn50203Owner(this.state, batch);
    if (owner === undefined) throw new Error("JN50203 owner is missing.");
    const choiceId = `${batch.batchId}:choice:jn50203`;
    const nextEventId = `${this.state.matchId}:event:${this.state.eventSequence + 1}`;
    const sourceEffectId = `${nextEventId}:jn50203`;
    const cleared: MatchState = {
      ...this.state,
      dyingBatch: null,
      pendingChoice: null,
    };
    this.append("death.loot-finished", {
      ownerPlayerId: owner.id,
      choiceId,
      remainingCardInstanceIds: this.state.pendingChoice?.optionIds ?? [],
      finishedAt: this.serverReceivedAt,
      timeout,
      damageItems: planDamageBatch(cleared, [
        {
          itemId: `${sourceEffectId}:damage:0`,
          sourcePlayerId: owner.id,
          targetPlayerId: owner.id,
          amount: 1,
          element: "neutral",
        },
      ]),
    });
  }

  resolveLootCompletion(): void {
    if (
      this.state.dyingBatch?.status === "distributing-loot" &&
      this.state.pendingChoice === null
    ) {
      this.finishLoot(false);
    }
  }

  finishIfNeeded(): void {
    if (
      this.state.dyingBatch !== null ||
      this.state.pendingChoice !== null ||
      this.state.reactionWindow !== null
    )
      return;
    const teams = aliveTeams(this.state);
    if (teams.length > 1) return;
    this.append("match.finished", {
      winner: teams.length === 1 ? teams[0]! : "draw",
      reason: "death-cycle",
    });
  }
}

export function applyDyingCommand(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
): ApplyCommandResult {
  const batch = input.dyingBatch;
  const choice = input.pendingChoice;
  if (batch?.status === "distributing-loot") {
    if (
      choice === null ||
      choice.status !== "open" ||
      !choice.playerIds.includes(envelope.playerId)
    ) {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: input.version,
      };
    }
    if (
      !Number.isSafeInteger(serverReceivedAt) ||
      serverReceivedAt < 0 ||
      serverReceivedAt > choice.deadlineAt
    ) {
      return {
        accepted: false,
        reason:
          serverReceivedAt > choice.deadlineAt ? "expired-window" : "invalid",
        currentVersion: input.version,
      };
    }
    const builder = new EventBuilder(
      input,
      envelope.commandId,
      input.version + 1,
      serverReceivedAt,
    );
    const command = envelope.command;
    if (command.type === "distribute-death-loot") {
      const cardInstanceIds = command.cardInstanceIds as CardInstanceId[];
      const target = input.players[command.targetPlayerId];
      if (
        command.choiceId !== choice.choiceId ||
        target === undefined ||
        !target.alive ||
        target.id === envelope.playerId ||
        cardInstanceIds.length === 0 ||
        new Set(cardInstanceIds).size !== cardInstanceIds.length ||
        cardInstanceIds.some((card) => !choice.optionIds.includes(card))
      ) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      const selected = new Set<string>(cardInstanceIds);
      builder.append("death.loot-distributed", {
        ownerPlayerId: envelope.playerId,
        targetPlayerId: target.id,
        choiceId: choice.choiceId,
        cardInstanceIds,
        remainingCardInstanceIds: choice.optionIds.filter(
          (card) => !selected.has(card),
        ),
        distributedAt: serverReceivedAt,
      });
      builder.resolveLootCompletion();
    } else if (command.type === "finish-death-loot") {
      if (command.choiceId !== choice.choiceId) {
        return {
          accepted: false,
          reason: "forbidden",
          currentVersion: input.version,
        };
      }
      builder.finishLoot(false);
    } else {
      return {
        accepted: false,
        reason: "not-available",
        currentVersion: input.version,
      };
    }
    builder.finishIfNeeded();
    return { accepted: true, state: builder.state, events: builder.events };
  }
  if (
    batch === null ||
    choice === null ||
    batch.status !== "awaiting-rescue" ||
    choice.status !== "open"
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  if (
    !Number.isSafeInteger(serverReceivedAt) ||
    serverReceivedAt < 0 ||
    serverReceivedAt > choice.deadlineAt
  ) {
    return {
      accepted: false,
      reason:
        serverReceivedAt > choice.deadlineAt ? "expired-window" : "invalid",
      currentVersion: input.version,
    };
  }
  const priority = batch.priorityOrder[batch.priorityIndex];
  if (priority !== envelope.playerId) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    envelope.commandId,
    input.version + 1,
    serverReceivedAt,
  );
  const command = envelope.command;
  if (command.type === "pass-rescue") {
    if (command.choiceId !== choice.choiceId) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    builder.append("rescue.passed", {
      playerId: envelope.playerId,
      choiceId: choice.choiceId,
      passedAt: serverReceivedAt,
    });
    builder.resolveClosedRescue();
  } else if (command.type === "activate-rescue-equipment") {
    const cardInstanceId = command.cardInstanceId as CardInstanceId;
    const player = input.players[envelope.playerId]!;
    if (
      command.targetPlayerId !== envelope.playerId ||
      command.targetPlayerId !== batch.currentTargetPlayerId ||
      player.equipment.armor !== cardInstanceId ||
      cardDefinition(cardInstanceId).id !== "xyy.card.fj01"
    ) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const nextEventId = `${input.matchId}:event:${input.eventSequence + 1}`;
    builder.append("rescue.equipment-activated", {
      playerId: envelope.playerId,
      targetPlayerId: command.targetPlayerId,
      cardInstanceId,
      rescuedAt: serverReceivedAt,
      healingItems: planCureBatch(input, [
        {
          itemId: `${nextEventId}:cure:0`,
          sourcePlayerId: envelope.playerId,
          targetPlayerId: command.targetPlayerId,
          amount: 2,
          element: "neutral",
        },
      ]),
    });
  } else if (command.type === "play-skill-converted-card") {
    const player = input.players[envelope.playerId]!;
    const cardInstanceIds = command.cardInstanceIds as CardInstanceId[];
    if (
      command.targetPlayerIds.length !== 1 ||
      command.targetPlayerIds[0] !== batch.currentTargetPlayerId ||
      command.skillId !== "xyy.skill.jn40301" ||
      player.heroId === null ||
      !heroHasSkill(player.heroId, "xyy.skill.jn40301") ||
      cardInstanceIds.length !== 2 ||
      new Set(cardInstanceIds).size !== 2 ||
      cardInstanceIds.some((card) => !player.hand.includes(card))
    ) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const nextEventId = `${input.matchId}:event:${input.eventSequence + 1}`;
    builder.append("rescue.skill-card-converted", {
      playerId: envelope.playerId,
      targetPlayerId: batch.currentTargetPlayerId,
      cardInstanceIds,
      skillId: "xyy.skill.jn40301",
      rescuedAt: serverReceivedAt,
      healingItems: planCureBatch(input, [
        {
          itemId: `${nextEventId}:cure:0`,
          sourcePlayerId: envelope.playerId,
          targetPlayerId: batch.currentTargetPlayerId,
          amount: 2,
          element: "neutral",
        },
      ]),
    });
  } else if (command.type === "play-rescue-card") {
    if (command.targetPlayerId !== batch.currentTargetPlayerId) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const cardInstanceId = command.cardInstanceId as CardInstanceId;
    const player = input.players[envelope.playerId]!;
    let rescueCard = false;
    try {
      rescueCard =
        cardDefinition(cardInstanceId).rescueAction?.type === "rescue-two";
    } catch {
      rescueCard = false;
    }
    if (!player.hand.includes(cardInstanceId) || !rescueCard) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const nextEventId = `${input.matchId}:event:${input.eventSequence + 1}`;
    builder.append("rescue.card-played", {
      playerId: envelope.playerId,
      targetPlayerId: command.targetPlayerId,
      cardInstanceId,
      rescuedAt: serverReceivedAt,
      healingItems: planCureBatch(input, [
        {
          itemId: `${nextEventId}:cure:0`,
          sourcePlayerId: envelope.playerId,
          targetPlayerId: command.targetPlayerId,
          amount: 2,
          element: "neutral",
        },
      ]),
    });
  } else {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  builder.resolveBatchCleanup();
  builder.finishIfNeeded();
  return { accepted: true, state: builder.state, events: builder.events };
}

export function applyDeathLootTimeout(
  input: Readonly<MatchState>,
  command: Readonly<Extract<EngineCommand, { origin: "system-timeout" }>>,
  playerId: PlayerId,
): ApplyCommandResult {
  const batch = input.dyingBatch;
  const choice = input.pendingChoice;
  if (
    batch?.status !== "distributing-loot" ||
    choice === null ||
    choice.status !== "open" ||
    choice.fallback !== "pass" ||
    choice.playerIds[0] !== playerId ||
    command.targetId !== `death-loot:${choice.choiceId}:${playerId}` ||
    command.deadlineAt < choice.openedAt ||
    command.deadlineAt > choice.deadlineAt
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    command.commandId,
    input.version + 1,
    command.deadlineAt,
  );
  builder.finishLoot(true);
  builder.finishIfNeeded();
  return { accepted: true, state: builder.state, events: builder.events };
}
