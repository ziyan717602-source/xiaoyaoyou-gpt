import type {
  CommandEnvelope,
  CommandId,
  EffectId,
  PlayerId,
  WindowId,
} from "@xiaoyaoyou/protocol";
import type {
  ApplyCommandResult,
  DomainEvent,
  EngineCommand,
} from "./architecture.js";
import { planDraw } from "./card-zones.js";
import {
  applyPlannedDamage,
  planDamageBatch,
  type AppliedDamage,
  type DamageIntent,
} from "./damage-dying.js";
import { planCureBatch, playersAfterCures } from "./healing.js";
import { withWeaponSkillEquipment } from "./hero-stats.js";
import {
  hasHpEvolutionFlag,
  isCanonicalHpEvolutionMask,
} from "./hp-evolution.js";
import type {
  Continuation,
  EffectFrame,
  MatchState,
  PendingChoice,
  ReactionWindow,
} from "./index.js";
import { nextInt } from "./random.js";
import { reduceInspectionEvent } from "./inspection.js";
import {
  cardDefinition,
  cardIdOf,
  heroHasSkill,
  type CardInstanceId,
} from "./setup-content.js";

const REACTION_DEADLINE_MS = 15_000;

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

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function playerHasAnyCards(
  player: Readonly<MatchState["players"][PlayerId]>,
): boolean {
  return (
    player.hand.length > 0 ||
    player.equipment.weapon !== null ||
    player.equipment.armor !== null
  );
}

function effectById(
  state: Readonly<MatchState>,
  effectId: EffectId,
): EffectFrame | undefined {
  return state.effectStack.find((effect) => effect.effectId === effectId);
}

function choiceOptionsForEffect(
  state: Readonly<MatchState>,
  effect: Readonly<EffectFrame>,
): readonly string[] {
  const source = state.players[effect.sourcePlayerId ?? ""];
  const target = state.players[effect.targetIds[0] ?? ""];
  if (source === undefined || target === undefined) return [];
  if (effect.kind === "card:xyy.card.jp01") {
    return target.hand.map((_, index) => `opaque-hand-slot-${index + 1}`);
  }
  if (effect.kind !== "card:xyy.card.jp06") return [];
  const handOptions =
    source.id === target.id
      ? target.hand.map((card) => `own-hand:${card}`)
      : target.hand.map((_, index) => `opaque-hand-slot-${index + 1}`);
  return [
    ...handOptions,
    ...(target.equipment.weapon === null ? [] : ["equipment:weapon"]),
    ...(target.equipment.armor === null ? [] : ["equipment:armor"]),
  ];
}

function cardForChoiceOption(
  state: Readonly<MatchState>,
  effect: Readonly<EffectFrame>,
  optionId: string,
):
  | {
      readonly cardInstanceId: CardInstanceId;
      readonly zone: "hand" | "weapon" | "armor";
    }
  | undefined {
  const source = state.players[effect.sourcePlayerId ?? ""];
  const target = state.players[effect.targetIds[0] ?? ""];
  if (source === undefined || target === undefined) return undefined;
  if (effect.kind === "hero-skill:xyy.skill.jn50202") {
    const cardInstanceId = optionId as CardInstanceId;
    return source.id === target.id && source.hand.includes(cardInstanceId)
      ? { cardInstanceId, zone: "hand" }
      : undefined;
  }
  const opaquePrefix = "opaque-hand-slot-";
  if (optionId.startsWith(opaquePrefix)) {
    const index = Number(optionId.slice(opaquePrefix.length)) - 1;
    const cardInstanceId = target.hand[index];
    return cardInstanceId === undefined
      ? undefined
      : { cardInstanceId, zone: "hand" };
  }
  const ownPrefix = "own-hand:";
  if (
    effect.kind === "card:xyy.card.jp06" &&
    source.id === target.id &&
    optionId.startsWith(ownPrefix)
  ) {
    const cardInstanceId = optionId.slice(ownPrefix.length) as CardInstanceId;
    return target.hand.includes(cardInstanceId)
      ? { cardInstanceId, zone: "hand" }
      : undefined;
  }
  if (effect.kind === "card:xyy.card.jp06" && optionId === "equipment:weapon") {
    return target.equipment.weapon === null
      ? undefined
      : { cardInstanceId: target.equipment.weapon, zone: "weapon" };
  }
  if (effect.kind === "card:xyy.card.jp06" && optionId === "equipment:armor") {
    return target.equipment.armor === null
      ? undefined
      : { cardInstanceId: target.equipment.armor, zone: "armor" };
  }
  return undefined;
}

function updateEffects(
  state: Readonly<MatchState>,
  statuses: Readonly<Record<EffectId, EffectFrame["status"]>>,
): readonly EffectFrame[] {
  return state.effectStack.map((effect) =>
    statuses[effect.effectId] === undefined
      ? effect
      : {
          ...effect,
          status: statuses[effect.effectId]!,
          step:
            statuses[effect.effectId] === "waiting"
              ? "awaiting-reactions"
              : statuses[effect.effectId]!,
        },
  );
}

function pruneTerminalTail(
  effects: readonly EffectFrame[],
): readonly EffectFrame[] {
  const active = [...effects];
  while (
    active.length > 0 &&
    ["cancelled", "resolved", "fizzled"].includes(active.at(-1)!.status)
  ) {
    active.pop();
  }
  return active;
}

function livingSeatOrder(state: Readonly<MatchState>): readonly PlayerId[] {
  return Object.values(state.players)
    .filter((player) => player.alive)
    .sort((left, right) => left.seat - right.seat)
    .map((player) => player.id);
}

function priorityAfter(
  state: Readonly<MatchState>,
  eligible: ReadonlySet<PlayerId>,
  afterPlayerId: PlayerId,
): readonly PlayerId[] {
  const seats = livingSeatOrder(state);
  const start = seats.indexOf(afterPlayerId);
  if (start < 0) return seats.filter((playerId) => eligible.has(playerId));
  const result: PlayerId[] = [];
  for (let offset = 1; offset <= seats.length; offset += 1) {
    const playerId = seats[(start + offset) % seats.length]!;
    if (eligible.has(playerId)) result.push(playerId);
  }
  return result;
}

function makeWindow(input: {
  readonly state: Readonly<MatchState>;
  readonly effect: EffectFrame;
  readonly windowId: WindowId;
  readonly parentWindow: ReactionWindow | null;
  readonly afterPlayerId: PlayerId;
  readonly openedAt: number;
  readonly eligiblePlayerIds?: readonly PlayerId[];
}): ReactionWindow {
  const sourcePlayerId = input.effect.sourcePlayerId;
  if (sourcePlayerId === null && input.eligiblePlayerIds === undefined) {
    throw new Error("A player-card effect requires a source player.");
  }
  const eligiblePlayerIds =
    input.eligiblePlayerIds ??
    livingSeatOrder(input.state).filter(
      (playerId) => playerId !== sourcePlayerId,
    );
  const eligible = new Set(eligiblePlayerIds);
  const priorityOrder = priorityAfter(
    input.state,
    eligible,
    input.afterPlayerId,
  );
  const continuation: Continuation = {
    continuationId: `${input.state.matchId}:continuation:${input.windowId}`,
    effectId: input.effect.effectId,
    step: "after-reactions",
    locals:
      input.parentWindow === null ? {} : { parentWindow: input.parentWindow },
    resumeWith: "resolve-effect",
  };
  return {
    windowId: input.windowId,
    effectId: input.effect.effectId,
    parentWindowId: input.parentWindow?.windowId ?? null,
    eligiblePlayerIds,
    priorityOrder,
    priorityIndex: 0,
    passedPlayerIds: [],
    status: priorityOrder.length === 0 ? "closed" : "open",
    openedAt: input.openedAt,
    deadlineAt: input.openedAt + REACTION_DEADLINE_MS,
    continuation,
  };
}

function damageItemsForEffect(
  effect: Readonly<EffectFrame>,
): readonly AppliedDamage[] {
  const value = effect.payload.damageItems;
  if (!Array.isArray(value)) {
    throw new Error("Damage-batch effect is missing its planned items.");
  }
  for (const item of value) {
    if (
      item === null ||
      typeof item !== "object" ||
      typeof (item as Partial<AppliedDamage>).itemId !== "string" ||
      typeof (item as Partial<AppliedDamage>).targetPlayerId !== "string" ||
      typeof (item as Partial<AppliedDamage>).amount !== "number" ||
      !isCanonicalHpEvolutionMask((item as Partial<AppliedDamage>).hpEvoMask)
    ) {
      throw new Error("Damage-batch effect has an invalid planned item.");
    }
  }
  return value as readonly AppliedDamage[];
}

function damageSourceEffectId(effect: Readonly<EffectFrame>): EffectId {
  const value = effect.payload.sourceEffectId;
  if (typeof value !== "string") {
    throw new Error("Damage-batch effect is missing its source effect.");
  }
  return value;
}

function fj05Preventable(
  item: Readonly<AppliedDamage>,
  playerId: PlayerId,
): boolean {
  return (
    item.targetPlayerId === playerId &&
    item.amount > 0 &&
    !hasHpEvolutionFlag(item.hpEvoMask, "decr-inavo") &&
    !hasHpEvolutionFlag(item.hpEvoMask, "immune-inavo")
  );
}

function tp03Preventable(
  item: Readonly<AppliedDamage>,
  playerId: PlayerId,
): boolean {
  return (
    item.targetPlayerId === playerId &&
    item.amount > 0 &&
    !hasHpEvolutionFlag(item.hpEvoMask, "tux-inavo")
  );
}

function damageResponders(
  state: Readonly<MatchState>,
  items: readonly AppliedDamage[],
): readonly PlayerId[] {
  const targetIds = new Set(
    items
      .filter((item) => tp03Preventable(item, item.targetPlayerId))
      .map((item) => item.targetPlayerId),
  );
  for (const player of Object.values(state.players)) {
    const armor = player.equipment.armor;
    if (
      armor !== null &&
      cardDefinition(armor).id === "xyy.card.fj05" &&
      items.some((item) => fj05Preventable(item, player.id))
    ) {
      targetIds.add(player.id);
    }
  }
  return livingSeatOrder(state).filter((playerId) => targetIds.has(playerId));
}

function advanceInterruptedWindow(
  window: Readonly<ReactionWindow>,
  playerId: PlayerId,
  openedAt: number,
): ReactionWindow {
  if (window.priorityOrder[window.priorityIndex] !== playerId) {
    throw new Error("Interrupted response source did not own priority.");
  }
  const passedPlayerIds = window.passedPlayerIds.includes(playerId)
    ? window.passedPlayerIds
    : [...window.passedPlayerIds, playerId];
  const closed = passedPlayerIds.length === window.priorityOrder.length;
  return {
    ...window,
    priorityIndex: closed ? window.priorityIndex : window.priorityIndex + 1,
    passedPlayerIds,
    status: closed ? "closed" : "open",
    openedAt,
    deadlineAt: openedAt + REACTION_DEADLINE_MS,
  };
}

function parentWindow(value: unknown): ReactionWindow | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<ReactionWindow>;
  return typeof candidate.windowId === "string" &&
    typeof candidate.effectId === "string" &&
    candidate.continuation !== undefined
    ? (candidate as ReactionWindow)
    : null;
}

/** Opens the serialized TP03 gate before an already-planned damage batch. */
export function beginDamageResponse(
  state: Readonly<MatchState>,
  sourceEffectId: EffectId,
  sourcePlayerId: PlayerId | null,
  damageItems: readonly AppliedDamage[],
  openedAt: number,
): MatchState {
  const eligiblePlayerIds = damageResponders(state, damageItems);
  if (eligiblePlayerIds.length === 0) {
    return applyPlannedDamage(state, sourceEffectId, damageItems, openedAt);
  }
  const damageEffect: EffectFrame = {
    effectId: `${sourceEffectId}:damage-batch`,
    parentEffectId: null,
    kind: "damage-batch",
    sourcePlayerId,
    targetIds: [...new Set(damageItems.map((item) => item.targetPlayerId))],
    step: "awaiting-reactions",
    status: "waiting",
    payload: { sourceEffectId, damageItems },
  };
  const withDamage: MatchState = {
    ...state,
    effectStack: [...state.effectStack, damageEffect],
  };
  return {
    ...withDamage,
    reactionWindow: makeWindow({
      state: withDamage,
      effect: damageEffect,
      windowId: `${sourceEffectId}:damage-window`,
      parentWindow: null,
      afterPlayerId: sourcePlayerId ?? eligiblePlayerIds.at(-1)!,
      openedAt,
      eligiblePlayerIds,
    }),
  };
}

export function reduceReactionEvent(
  state: Readonly<MatchState>,
  event: Readonly<DomainEvent>,
): MatchState {
  if (
    event.matchId !== state.matchId ||
    event.sequence !== state.eventSequence + 1 ||
    event.rulesetVersion !== state.rulesetVersion
  ) {
    throw new Error("Reaction event does not extend the current match head.");
  }
  if (
    state.phase !== "playing" ||
    (state.turn?.phase !== "action" &&
      !(
        state.turn?.phase === "encounter" && state.encounterState.npc !== null
      ) &&
      state.turn?.phase !== "reward" &&
      state.turn?.phase !== "turn-end")
  ) {
    throw new Error("Reaction events require an interactive turn phase.");
  }
  const matchVersion = numberPayload(event, "matchVersion");
  const expectedMatchVersion =
    event.causationEventId === null ? state.version + 1 : state.version;
  if (matchVersion !== expectedMatchVersion) {
    throw new Error("Reaction event has an invalid match version.");
  }

  let next: MatchState;
  if (event.type === "effect.started") {
    const playerId = stringPayload(event, "playerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const targetPlayerIds = Array.isArray(event.payload.targetPlayerIds)
      ? (stringsPayload(event, "targetPlayerIds") as readonly PlayerId[])
      : [stringPayload(event, "targetPlayerId")];
    const effectId = stringPayload(event, "effectId");
    const windowId = stringPayload(event, "windowId");
    const openedAt = numberPayload(event, "openedAt");
    const player = state.players[playerId];
    const targets = targetPlayerIds.map(
      (targetPlayerId) => state.players[targetPlayerId],
    );
    const action = cardDefinition(cardInstanceId).coreAction;
    const validTeamTargets =
      action?.type !== "heal-team-one" ||
      sameValues(
        targetPlayerIds,
        Object.values(state.players)
          .filter(
            (candidate) => candidate.alive && candidate.team === player?.team,
          )
          .sort((left, right) => left.seat - right.seat)
          .map((candidate) => candidate.id),
      );
    if (
      state.reactionWindow !== null ||
      state.activePlayerId !== playerId ||
      player === undefined ||
      targetPlayerIds.length === 0 ||
      targets.some((target) => target?.alive !== true) ||
      !player.hand.includes(cardInstanceId) ||
      ![
        "steal-one",
        "discard-one",
        "inspect-encounter",
        "draw-two",
        "damage-two",
        "heal-two",
        "heal-team-one",
      ].includes(action?.type ?? "") ||
      !validTeamTargets ||
      (action?.type === "inspect-encounter" &&
        (state.encounterDeck.length === 0 ||
          !sameValues(targetPlayerIds, [playerId]))) ||
      (action?.type === "steal-one" &&
        (targetPlayerIds.length !== 1 ||
          targetPlayerIds[0] === playerId ||
          targets[0]?.hand.length === 0)) ||
      (action?.type === "discard-one" &&
        (targetPlayerIds.length !== 1 ||
          (targets[0]?.hand.length === 0 &&
            targets[0]?.equipment.weapon === null &&
            targets[0]?.equipment.armor === null))) ||
      effectById(state, effectId) !== undefined
    ) {
      throw new Error("Original effect event is not applicable.");
    }
    const effect: EffectFrame = {
      effectId,
      parentEffectId: null,
      kind: `card:${cardDefinition(cardInstanceId).id}`,
      sourcePlayerId: playerId,
      targetIds: targetPlayerIds,
      step: "awaiting-reactions",
      status: "waiting",
      payload: { cardInstanceId },
    };
    const withoutCard = player.hand.filter((card) => card !== cardInstanceId);
    const intermediate: MatchState = {
      ...state,
      players: {
        ...state.players,
        [playerId]: { ...player, hand: withoutCard },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      effectStack: [...state.effectStack, effect],
    };
    next = {
      ...intermediate,
      reactionWindow: makeWindow({
        state: intermediate,
        effect,
        windowId,
        parentWindow: null,
        afterPlayerId: playerId,
        openedAt,
      }),
    };
  } else if (event.type === "effect.skill-card-converted") {
    const playerId = stringPayload(event, "playerId");
    const cardInstanceIds = stringsPayload(
      event,
      "cardInstanceIds",
    ) as readonly CardInstanceId[];
    const skillId = stringPayload(event, "skillId");
    const convertedCardId =
      typeof event.payload.convertedCardId === "string"
        ? event.payload.convertedCardId
        : skillId === "xyy.skill.jn40301"
          ? "xyy.card.tp02"
          : stringPayload(event, "convertedCardId");
    const targetPlayerIds = stringsPayload(
      event,
      "targetPlayerIds",
    ) as readonly PlayerId[];
    const effectId = stringPayload(event, "effectId");
    const windowId = stringPayload(event, "windowId");
    const openedAt = numberPayload(event, "openedAt");
    const player = state.players[playerId];
    const target = state.players[targetPlayerIds[0] ?? ""];
    const paidCards = new Set(cardInstanceIds);
    const remainingHand =
      player === undefined
        ? []
        : player.hand.filter((card) => !paidCards.has(card));
    const targetHasCardsAfterPayment =
      target === undefined
        ? false
        : target.id === playerId
          ? remainingHand.length > 0 ||
            target.equipment.weapon !== null ||
            target.equipment.armor !== null
          : playerHasAnyCards(target);
    const validJn40301 =
      player?.heroId !== null &&
      player?.heroId !== undefined &&
      skillId === "xyy.skill.jn40301" &&
      convertedCardId === "xyy.card.tp02" &&
      heroHasSkill(player.heroId, "xyy.skill.jn40301") &&
      cardInstanceIds.length === 2 &&
      new Set(cardInstanceIds).size === 2 &&
      cardInstanceIds.every((card) => player.hand.includes(card)) &&
      targetPlayerIds.length === 1 &&
      targetPlayerIds[0] === playerId;
    const validJn50201 =
      player?.heroId !== null &&
      player?.heroId !== undefined &&
      skillId === "xyy.skill.jn50201" &&
      (convertedCardId === "xyy.card.jp01" ||
        convertedCardId === "xyy.card.jp06") &&
      heroHasSkill(player.heroId, "xyy.skill.jn50201") &&
      !(state.turn?.usedSkillIds ?? []).includes("xyy.skill.jn50201") &&
      cardInstanceIds.length === 1 &&
      new Set(cardInstanceIds).size === 1 &&
      cardInstanceIds.every((card) => player.hand.includes(card)) &&
      Object.values(state.players).some(
        (candidate) =>
          candidate.id !== playerId && playerHasAnyCards(candidate),
      ) &&
      targetPlayerIds.length === 1 &&
      target?.alive === true &&
      (convertedCardId === "xyy.card.jp01"
        ? target.id !== playerId && target.hand.length > 0
        : targetHasCardsAfterPayment);
    if (
      state.reactionWindow !== null ||
      state.activePlayerId !== playerId ||
      state.turn?.phase !== "action" ||
      player === undefined ||
      (!validJn40301 && !validJn50201) ||
      effectById(state, effectId) !== undefined
    ) {
      throw new Error("Skill-converted card effect is not applicable.");
    }
    const effect: EffectFrame = {
      effectId,
      parentEffectId: null,
      kind: `card:${convertedCardId}`,
      sourcePlayerId: playerId,
      targetIds: targetPlayerIds,
      step: "awaiting-reactions",
      status: "waiting",
      payload: { cardInstanceIds, skillId, convertedCardId },
    };
    const intermediate: MatchState = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          hand: player.hand.filter((card) => !paidCards.has(card)),
        },
      },
      discardPile: [...state.discardPile, ...cardInstanceIds],
      effectStack: [...state.effectStack, effect],
      turn:
        skillId === "xyy.skill.jn50201" && state.turn !== null
          ? {
              ...state.turn,
              usedSkillIds: [
                ...(state.turn.usedSkillIds ?? []),
                "xyy.skill.jn50201",
              ],
            }
          : state.turn,
    };
    next = {
      ...intermediate,
      reactionWindow: makeWindow({
        state: intermediate,
        effect,
        windowId,
        parentWindow: null,
        afterPlayerId: playerId,
        openedAt,
      }),
    };
  } else if (event.type === "reaction.card-played") {
    const playerId = stringPayload(event, "playerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const targetEffectId = stringPayload(event, "targetEffectId");
    const effectId = stringPayload(event, "effectId");
    const windowId = stringPayload(event, "windowId");
    const openedAt = numberPayload(event, "openedAt");
    const window = state.reactionWindow;
    const player = state.players[playerId];
    const targetEffect = effectById(state, targetEffectId);
    const action = cardDefinition(cardInstanceId).coreAction;
    const cancelsCurrentEffect =
      action?.type === "cancel-effect" &&
      targetEffect !== undefined &&
      targetEffect.kind !== "damage-batch";
    const preventsCurrentDamage =
      action?.type === "prevent-damage" &&
      targetEffect?.kind === "damage-batch" &&
      damageItemsForEffect(targetEffect).some((item) =>
        tp03Preventable(item, playerId),
      );
    if (
      window === null ||
      window.status !== "open" ||
      window.effectId !== targetEffectId ||
      window.priorityOrder[window.priorityIndex] !== playerId ||
      player === undefined ||
      !player.hand.includes(cardInstanceId) ||
      (!cancelsCurrentEffect && !preventsCurrentDamage) ||
      targetEffect === undefined ||
      targetEffect.status !== "waiting" ||
      effectById(state, effectId) !== undefined
    ) {
      throw new Error("Reaction card event is not applicable.");
    }
    const effect: EffectFrame = {
      effectId,
      parentEffectId: targetEffectId,
      kind: preventsCurrentDamage ? "card:xyy.card.tp03" : "cancel-effect",
      sourcePlayerId: playerId,
      targetIds: [targetEffectId],
      step: "awaiting-reactions",
      status: "waiting",
      payload: { cardInstanceId },
    };
    const intermediate: MatchState = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          hand: player.hand.filter((card) => card !== cardInstanceId),
        },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      effectStack: [
        ...updateEffects(state, { [targetEffectId]: "pending" }),
        effect,
      ],
    };
    next = {
      ...intermediate,
      reactionWindow: makeWindow({
        state: intermediate,
        effect,
        windowId,
        parentWindow: window,
        afterPlayerId: playerId,
        openedAt,
      }),
    };
  } else if (
    event.type === "reaction.card-converted" ||
    event.type === "reaction.skill-card-converted"
  ) {
    const equipmentConversion = event.type === "reaction.card-converted";
    const playerId = stringPayload(event, "playerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const equipmentCardInstanceId = equipmentConversion
      ? (stringPayload(event, "equipmentCardInstanceId") as CardInstanceId)
      : null;
    const skillId = equipmentConversion
      ? null
      : stringPayload(event, "skillId");
    const targetEffectId = stringPayload(event, "targetEffectId");
    const effectId = stringPayload(event, "effectId");
    const windowId = stringPayload(event, "windowId");
    const openedAt = numberPayload(event, "openedAt");
    const window = state.reactionWindow;
    const player = state.players[playerId];
    const targetEffect = effectById(state, targetEffectId);
    const preventsCurrentDamage =
      targetEffect?.kind === "damage-batch" &&
      damageItemsForEffect(targetEffect).some((item) =>
        tp03Preventable(item, playerId),
      );
    const validConversionSource = equipmentConversion
      ? player?.equipment.armor === equipmentCardInstanceId &&
        equipmentCardInstanceId !== null &&
        cardDefinition(equipmentCardInstanceId).id === "xyy.card.fj02" &&
        preventsCurrentDamage
      : skillId === "xyy.skill.jn20202" &&
        player?.heroId !== null &&
        player?.heroId !== undefined &&
        heroHasSkill(player.heroId, "xyy.skill.jn20202") &&
        cardIdOf(cardInstanceId).startsWith("xyy.card.tp") &&
        targetEffect?.kind !== "damage-batch";
    if (
      window === null ||
      window.status !== "open" ||
      window.effectId !== targetEffectId ||
      window.priorityOrder[window.priorityIndex] !== playerId ||
      player === undefined ||
      !player.hand.includes(cardInstanceId) ||
      !validConversionSource ||
      targetEffect?.status !== "waiting" ||
      effectById(state, effectId) !== undefined
    ) {
      throw new Error("Converted reaction card event is not applicable.");
    }
    const effect: EffectFrame = {
      effectId,
      parentEffectId: targetEffectId,
      kind: equipmentConversion ? "card:xyy.card.tp03" : "cancel-effect",
      sourcePlayerId: playerId,
      targetIds: [targetEffectId],
      step: "awaiting-reactions",
      status: "waiting",
      payload: equipmentConversion
        ? { cardInstanceId, equipmentCardInstanceId }
        : { cardInstanceId, skillId },
    };
    const intermediate: MatchState = {
      ...state,
      players: {
        ...state.players,
        [playerId]: {
          ...player,
          hand: player.hand.filter((card) => card !== cardInstanceId),
        },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      effectStack: [
        ...updateEffects(state, { [targetEffectId]: "pending" }),
        effect,
      ],
    };
    next = {
      ...intermediate,
      reactionWindow: makeWindow({
        state: intermediate,
        effect,
        windowId,
        parentWindow: window,
        afterPlayerId: playerId,
        openedAt,
      }),
    };
  } else if (event.type === "reaction.passed") {
    const playerId = stringPayload(event, "playerId");
    const windowId = stringPayload(event, "windowId");
    const openedAt = numberPayload(event, "openedAt");
    const window = state.reactionWindow;
    if (
      window === null ||
      window.status !== "open" ||
      window.windowId !== windowId ||
      window.priorityOrder[window.priorityIndex] !== playerId
    ) {
      throw new Error("Reaction pass event is not applicable.");
    }
    const passedPlayerIds = [...window.passedPlayerIds, playerId];
    const closed = passedPlayerIds.length === window.priorityOrder.length;
    next = {
      ...state,
      reactionWindow: {
        ...window,
        priorityIndex: closed ? window.priorityIndex : window.priorityIndex + 1,
        passedPlayerIds,
        status: closed ? "closed" : "open",
        openedAt,
        deadlineAt: openedAt + REACTION_DEADLINE_MS,
      },
    };
  } else if (event.type === "reaction.equipment-activated") {
    const playerId = stringPayload(event, "playerId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const targetEffectId = stringPayload(event, "targetEffectId");
    const openedAt = numberPayload(event, "openedAt");
    const preventedItemIds = stringsPayload(event, "preventedItemIds");
    const window = state.reactionWindow;
    const player = state.players[playerId];
    const targetEffect = effectById(state, targetEffectId);
    const before =
      targetEffect?.kind === "damage-batch"
        ? damageItemsForEffect(targetEffect)
        : [];
    const prevented = before.filter((item) => fj05Preventable(item, playerId));
    if (
      window === null ||
      window.status !== "open" ||
      window.effectId !== targetEffectId ||
      window.priorityOrder[window.priorityIndex] !== playerId ||
      player === undefined ||
      !player.alive ||
      player.equipment.armor !== cardInstanceId ||
      cardDefinition(cardInstanceId).id !== "xyy.card.fj05" ||
      targetEffect?.status !== "waiting" ||
      prevented.length === 0 ||
      !sameValues(
        preventedItemIds,
        prevented.map((item) => item.itemId),
      )
    ) {
      throw new Error("Damage equipment event is not applicable.");
    }
    const expectedCures = planCureBatch(state, [
      {
        itemId: `${event.eventId}:cure:0`,
        sourcePlayerId: playerId,
        targetPlayerId: playerId,
        amount: 1,
        element: "neutral",
      },
    ]);
    if (
      JSON.stringify(event.payload.healingItems) !==
      JSON.stringify(expectedCures)
    ) {
      throw new Error("Damage equipment cure disagrees with its plan.");
    }
    const players = playersAfterCures(state, expectedCures);
    const passedPlayerIds = window.passedPlayerIds.includes(playerId)
      ? window.passedPlayerIds
      : [...window.passedPlayerIds, playerId];
    const closed = passedPlayerIds.length === window.priorityOrder.length;
    const remaining = before.filter(
      (item) => !preventedItemIds.includes(item.itemId),
    );
    next = {
      ...state,
      players: {
        ...players,
        [playerId]: {
          ...players[playerId]!,
          equipment: { ...player.equipment, armor: null },
        },
      },
      discardPile: [...state.discardPile, cardInstanceId],
      effectStack: state.effectStack.map((effect) =>
        effect.effectId === targetEffectId
          ? {
              ...effect,
              payload: { ...effect.payload, damageItems: remaining },
            }
          : effect,
      ),
      reactionWindow: {
        ...window,
        priorityIndex: closed ? window.priorityIndex : window.priorityIndex + 1,
        passedPlayerIds,
        status: closed ? "closed" : "open",
        openedAt,
        deadlineAt: openedAt + REACTION_DEADLINE_MS,
      },
    };
  } else if (
    event.type === "effect.encounter-inspected" ||
    event.type === "effect.encounter-order-resolved"
  ) {
    next = reduceInspectionEvent(state, event);
  } else if (event.type === "effect.choice-opened") {
    const effectId = stringPayload(event, "effectId");
    const choiceId = stringPayload(event, "choiceId");
    const openedAt = numberPayload(event, "openedAt");
    const optionIds = stringsPayload(event, "optionIds");
    const effect = effectById(state, effectId);
    const window = state.reactionWindow;
    const source = state.players[effect?.sourcePlayerId ?? ""];
    const target = state.players[effect?.targetIds[0] ?? ""];
    const expectedOptions =
      effect === undefined ? [] : choiceOptionsForEffect(state, effect);
    const supported =
      effect?.kind === "card:xyy.card.jp01" ||
      effect?.kind === "card:xyy.card.jp06";
    if (
      state.pendingChoice !== null ||
      window === null ||
      window.status !== "closed" ||
      window.effectId !== effectId ||
      !supported ||
      effect.status !== "waiting" ||
      source === undefined ||
      !source.alive ||
      target === undefined ||
      !target.alive ||
      (effect.kind === "card:xyy.card.jp01" && target.id === source.id) ||
      expectedOptions.length === 0 ||
      !sameValues(optionIds, expectedOptions)
    ) {
      throw new Error("Card-zone choice event is not applicable.");
    }
    const choice: PendingChoice = {
      choiceId,
      playerIds: [source.id],
      prompt: `${effect.kind === "card:xyy.card.jp01" ? "steal-one" : "discard-one"}:${target.id}`,
      minSelections: 1,
      maxSelections: 1,
      optionIds,
      optional: false,
      status: "open",
      openedAt,
      deadlineAt: openedAt + REACTION_DEADLINE_MS,
      fallback: "deterministic-random",
      continuation: {
        continuationId: `${choiceId}:continuation`,
        effectId,
        step: "after-card-zone-choice",
        locals: { targetPlayerId: target.id },
        resumeWith:
          effect.kind === "card:xyy.card.jp01"
            ? "resolve-steal-one"
            : "resolve-discard-one",
      },
    };
    next = {
      ...state,
      effectStack: state.effectStack.map((candidate) =>
        candidate.effectId === effectId
          ? { ...candidate, step: "awaiting-choice", status: "resolving" }
          : candidate,
      ),
      reactionWindow: null,
      pendingChoice: choice,
    };
  } else if (event.type === "effect.fizzled") {
    const effectId = stringPayload(event, "effectId");
    const effect = effectById(state, effectId);
    const window = state.reactionWindow;
    const target = state.players[effect?.targetIds[0] ?? ""];
    if (
      window === null ||
      window.status !== "closed" ||
      window.effectId !== effectId ||
      (effect?.kind !== "card:xyy.card.jp01" &&
        effect?.kind !== "card:xyy.card.jp06") ||
      effect.status !== "waiting" ||
      target === undefined ||
      choiceOptionsForEffect(state, effect).length !== 0
    ) {
      throw new Error("Card-zone fizzle event is not applicable.");
    }
    next = {
      ...state,
      effectStack: pruneTerminalTail(
        updateEffects(state, { [effectId]: "fizzled" }),
      ),
      reactionWindow: null,
    };
  } else if (event.type === "effect.choice-resolved") {
    const effectId = stringPayload(event, "effectId");
    const choiceId = stringPayload(event, "choiceId");
    const playerId = stringPayload(event, "playerId");
    const selectedOptionId = stringPayload(event, "selectedOptionId");
    const cardInstanceId = stringPayload(
      event,
      "cardInstanceId",
    ) as CardInstanceId;
    const effect = effectById(state, effectId);
    const choice = state.pendingChoice;
    const source = state.players[playerId];
    const target = state.players[effect?.targetIds[0] ?? ""];
    const selectedIndex = choice?.optionIds.indexOf(selectedOptionId) ?? -1;
    const selected =
      effect === undefined
        ? undefined
        : cardForChoiceOption(state, effect, selectedOptionId);
    const timeout = event.payload.timeout === true;
    const planned =
      timeout && choice !== null
        ? nextInt(state.rng, choice.optionIds.length)
        : null;
    if (
      state.reactionWindow !== null ||
      choice === null ||
      choice.status !== "open" ||
      choice.choiceId !== choiceId ||
      !choice.playerIds.includes(playerId) ||
      (effect?.kind !== "card:xyy.card.jp01" &&
        effect?.kind !== "card:xyy.card.jp06" &&
        effect?.kind !== "hero-skill:xyy.skill.jn50202") ||
      effect.status !== "resolving" ||
      effect.sourcePlayerId !== playerId ||
      source === undefined ||
      target === undefined ||
      selectedIndex < 0 ||
      selected?.cardInstanceId !== cardInstanceId ||
      numberPayload(event, "rngCursor") !==
        (planned?.rng.cursor ?? state.rng.cursor) ||
      (timeout && choice.optionIds[planned!.value] !== selectedOptionId)
    ) {
      throw new Error("Card-zone choice resolution is not applicable.");
    }
    const players = { ...state.players };
    let discardPile = state.discardPile;
    if (effect.kind === "card:xyy.card.jp01") {
      players[source.id] = {
        ...source,
        hand: [...source.hand, cardInstanceId],
      };
      players[target.id] = {
        ...target,
        hand: target.hand.filter((card) => card !== cardInstanceId),
      };
    } else if (effect.kind === "card:xyy.card.jp06") {
      players[target.id] =
        selected!.zone === "hand"
          ? {
              ...target,
              hand: target.hand.filter((card) => card !== cardInstanceId),
            }
          : withWeaponSkillEquipment(target, {
              ...target.equipment,
              [selected!.zone]: null,
            });
      discardPile = [...state.discardPile, cardInstanceId];
    } else {
      players[source.id] = {
        ...source,
        hand: source.hand.filter((card) => card !== cardInstanceId),
      };
      discardPile = [...state.discardPile, cardInstanceId];
    }
    next = {
      ...state,
      players,
      discardPile,
      rng: planned?.rng ?? state.rng,
      effectStack: pruneTerminalTail(
        updateEffects(state, { [effectId]: "resolved" }),
      ),
      pendingChoice: null,
    };
  } else if (event.type === "effect.resolved") {
    const effectId = stringPayload(event, "effectId");
    const resolvedAt = numberPayload(event, "resolvedAt");
    const window = state.reactionWindow;
    const effect = effectById(state, effectId);
    if (
      window === null ||
      window.status !== "closed" ||
      window.effectId !== effectId ||
      effect === undefined ||
      effect.status !== "waiting"
    ) {
      throw new Error("Effect resolution event is not applicable.");
    }
    if (effect.kind === "cancel-effect") {
      const targetEffectId = effect.targetIds[0];
      if (stringPayload(event, "targetEffectId") !== targetEffectId) {
        throw new Error(
          "Cancellation resolution target does not match effect.",
        );
      }
      const target =
        targetEffectId === undefined
          ? undefined
          : effectById(state, targetEffectId);
      if (target === undefined || target.status !== "pending") {
        throw new Error("Cancellation target is not pending.");
      }
      let restoredWindow: ReactionWindow | null = null;
      const statuses: Record<EffectId, EffectFrame["status"]> = {
        [effect.effectId]: "resolved",
        [target.effectId]: "cancelled",
      };
      if (target.kind === "card:xyy.card.tp03") {
        const targetWindow = parentWindow(
          window.continuation.locals.parentWindow,
        );
        const damageWindow = parentWindow(
          targetWindow?.continuation.locals.parentWindow,
        );
        const damageEffect =
          damageWindow === null
            ? undefined
            : effectById(state, damageWindow.effectId);
        if (
          damageWindow === null ||
          damageEffect?.kind !== "damage-batch" ||
          target.sourcePlayerId === null
        ) {
          throw new Error("Cancelled TP03 damage continuation is missing.");
        }
        statuses[damageEffect.effectId] = "waiting";
        restoredWindow = advanceInterruptedWindow(
          damageWindow,
          target.sourcePlayerId,
          resolvedAt,
        );
      } else if (target.kind === "cancel-effect") {
        const targetWindow = parentWindow(
          window.continuation.locals.parentWindow,
        );
        const originalWindow = parentWindow(
          targetWindow?.continuation.locals.parentWindow,
        );
        const originalEffect =
          originalWindow === null
            ? undefined
            : effectById(state, originalWindow.effectId);
        if (
          originalWindow === null ||
          originalEffect === undefined ||
          effect.sourcePlayerId === null
        ) {
          throw new Error("Counter-cancellation continuation is missing.");
        }
        statuses[originalEffect.effectId] = "waiting";
        restoredWindow = makeWindow({
          state,
          effect: { ...originalEffect, status: "waiting" },
          windowId: originalWindow.windowId,
          parentWindow: parentWindow(
            originalWindow.continuation.locals.parentWindow,
          ),
          afterPlayerId: effect.sourcePlayerId,
          openedAt: resolvedAt,
        });
      }
      next = {
        ...state,
        effectStack: pruneTerminalTail(updateEffects(state, statuses)),
        reactionWindow: restoredWindow,
      };
    } else if (effect.kind === "card:xyy.card.tp03") {
      const damageWindow = parentWindow(
        window.continuation.locals.parentWindow,
      );
      const damageEffect =
        damageWindow === null
          ? undefined
          : effectById(state, damageWindow.effectId);
      const sourcePlayerId = effect.sourcePlayerId;
      if (
        damageWindow === null ||
        damageEffect?.kind !== "damage-batch" ||
        damageEffect.status !== "pending" ||
        sourcePlayerId === null
      ) {
        throw new Error("Resolved TP03 damage continuation is missing.");
      }
      const before = damageItemsForEffect(damageEffect);
      const prevented = before.filter((item) =>
        tp03Preventable(item, sourcePlayerId),
      );
      const preventedItemIds = stringsPayload(event, "preventedItemIds");
      if (
        prevented.length === 0 ||
        !sameValues(
          preventedItemIds,
          prevented.map((item) => item.itemId),
        )
      ) {
        throw new Error(
          "Resolved TP03 prevention disagrees with damage batch.",
        );
      }
      const remaining = before.filter(
        (item) => !preventedItemIds.includes(item.itemId),
      );
      const effects = state.effectStack.map((candidate) =>
        candidate.effectId === damageEffect.effectId
          ? {
              ...candidate,
              status: "waiting" as const,
              step: "awaiting-reactions",
              payload: { ...candidate.payload, damageItems: remaining },
            }
          : candidate.effectId === effect.effectId
            ? { ...candidate, status: "resolved" as const, step: "resolved" }
            : candidate,
      );
      next = {
        ...state,
        effectStack: pruneTerminalTail(effects),
        reactionWindow: advanceInterruptedWindow(
          damageWindow,
          sourcePlayerId,
          resolvedAt,
        ),
      };
    } else if (effect.kind === "card:xyy.card.jp04") {
      const targetPlayerId = effect.targetIds[0];
      const target =
        targetPlayerId === undefined
          ? undefined
          : state.players[targetPlayerId];
      if (target === undefined || !target.alive) {
        throw new Error("Resolved draw-two target is no longer legal.");
      }
      const expected = planDraw(state, 2);
      const cards = event.payload.cardInstanceIds;
      if (
        !Array.isArray(cards) ||
        cards.some((card) => typeof card !== "string") ||
        !sameValues(cards as string[], expected.cards) ||
        numberPayload(event, "rngCursor") !== expected.rng.cursor
      ) {
        throw new Error("Resolved draw-two disagrees with deterministic draw.");
      }
      next = {
        ...state,
        players: {
          ...state.players,
          [targetPlayerId!]: {
            ...target,
            hand: [...target.hand, ...expected.cards],
          },
        },
        drawPile: expected.drawPile,
        discardPile: expected.discardPile,
        rng: expected.rng,
        effectStack: pruneTerminalTail(
          updateEffects(state, { [effectId]: "resolved" }),
        ),
        reactionWindow: null,
      };
    } else if (effect.kind === "card:xyy.card.jp05") {
      const targetPlayerId = effect.targetIds[0];
      const target =
        targetPlayerId === undefined
          ? undefined
          : state.players[targetPlayerId];
      if (target === undefined || !target.alive) {
        throw new Error("Resolved damage target is no longer legal.");
      }
      const intent: DamageIntent = {
        itemId: `${effectId}:damage:0`,
        sourcePlayerId: effect.sourcePlayerId,
        targetPlayerId: target.id,
        amount: 2,
        element: "thunder",
        hpEvoMask: ["from-jp"],
      };
      const expected = planDamageBatch(state, [intent]);
      if (
        JSON.stringify(event.payload.damageItems) !== JSON.stringify(expected)
      ) {
        throw new Error("Resolved damage disagrees with deterministic plan.");
      }
      const resolved: MatchState = {
        ...state,
        effectStack: pruneTerminalTail(
          updateEffects(state, { [effectId]: "resolved" }),
        ),
        reactionWindow: null,
      };
      next = beginDamageResponse(
        resolved,
        effectId,
        effect.sourcePlayerId,
        expected,
        resolvedAt,
      );
    } else if (effect.kind === "damage-batch") {
      const expected = damageItemsForEffect(effect);
      if (
        JSON.stringify(event.payload.damageItems) !== JSON.stringify(expected)
      ) {
        throw new Error("Resolved damage batch disagrees with planned items.");
      }
      const resolved: MatchState = {
        ...state,
        effectStack: pruneTerminalTail(
          updateEffects(state, { [effectId]: "resolved" }),
        ),
        reactionWindow: null,
      };
      next = applyPlannedDamage(
        resolved,
        damageSourceEffectId(effect),
        expected,
        resolvedAt,
      );
    } else if (effect.kind === "card:xyy.card.tp02") {
      const targetPlayerId = effect.targetIds[0];
      const target =
        targetPlayerId === undefined
          ? undefined
          : state.players[targetPlayerId];
      if (
        target === undefined ||
        !target.alive ||
        target.id !== effect.sourcePlayerId
      ) {
        throw new Error("Resolved heal-two disagrees with current HP.");
      }
      const expected = planCureBatch(state, [
        {
          itemId: `${effectId}:cure:0`,
          sourcePlayerId: effect.sourcePlayerId,
          targetPlayerId: target.id,
          amount: 2,
          element: "neutral",
        },
      ]);
      if (
        JSON.stringify(event.payload.healingItems) !== JSON.stringify(expected)
      ) {
        throw new Error("Resolved heal-two disagrees with deterministic plan.");
      }
      next = {
        ...state,
        players: playersAfterCures(state, expected),
        effectStack: pruneTerminalTail(
          updateEffects(state, { [effectId]: "resolved" }),
        ),
        reactionWindow: null,
      };
    } else if (effect.kind === "card:xyy.card.jp03") {
      const source = state.players[effect.sourcePlayerId ?? ""];
      if (
        source === undefined ||
        effect.targetIds.some((targetPlayerId) => {
          const target = state.players[targetPlayerId];
          return (
            target === undefined || !target.alive || target.team !== source.team
          );
        })
      ) {
        throw new Error("Resolved team healing has an invalid target.");
      }
      const expected = planCureBatch(
        state,
        effect.targetIds.map((targetPlayerId, index) => ({
          itemId: `${effectId}:cure:${index}`,
          sourcePlayerId: effect.sourcePlayerId,
          targetPlayerId,
          amount: 1,
          element: "water",
          hpEvoMask: ["from-jp"],
        })),
      );
      if (
        JSON.stringify(event.payload.healingItems) !== JSON.stringify(expected)
      ) {
        throw new Error("Resolved team healing disagrees with current HP.");
      }
      next = {
        ...state,
        players: playersAfterCures(state, expected),
        effectStack: pruneTerminalTail(
          updateEffects(state, { [effectId]: "resolved" }),
        ),
        reactionWindow: null,
      };
    } else {
      throw new Error(`Unsupported resolvable effect ${effect.kind}.`);
    }
  } else {
    throw new Error(`Unsupported reaction event ${event.type}.`);
  }
  return {
    ...next,
    version: matchVersion,
    eventSequence: event.sequence,
  };
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
    this.state = reduceReactionEvent(this.state, event);
  }

  resolveClosedWindows(): void {
    let guard = 0;
    while (this.state.reactionWindow?.status === "closed") {
      guard += 1;
      if (guard > this.state.effectStack.length + 1) {
        throw new Error("Closed reaction windows did not converge.");
      }
      const effectId = this.state.reactionWindow.effectId;
      const effect = effectById(this.state, effectId);
      if (effect === undefined)
        throw new Error("Closed window effect is missing.");
      if (effect.kind === "card:xyy.card.jp04") {
        const planned = planDraw(this.state, 2);
        this.append("effect.resolved", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          cardInstanceIds: planned.cards,
          rngCursor: planned.rng.cursor,
        });
      } else if (effect.kind === "card:xyy.card.jp02") {
        this.append("effect.encounter-inspected", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          cardIds: this.state.encounterDeck.slice(0, 2),
        });
      } else if (
        effect.kind === "card:xyy.card.jp01" ||
        effect.kind === "card:xyy.card.jp06"
      ) {
        const optionIds = choiceOptionsForEffect(this.state, effect);
        if (optionIds.length === 0) {
          this.append("effect.fizzled", {
            effectId,
            resolvedAt: this.serverReceivedAt,
            reason: "target-has-no-selectable-card-after-responses",
          });
        } else {
          this.append("effect.choice-opened", {
            effectId,
            choiceId: `${effectId}:choice:card-zone`,
            openedAt: this.serverReceivedAt,
            optionIds,
          });
        }
      } else if (effect.kind === "card:xyy.card.jp05") {
        const targetPlayerId = effect.targetIds[0]!;
        const planned = planDamageBatch(this.state, [
          {
            itemId: `${effectId}:damage:0`,
            sourcePlayerId: effect.sourcePlayerId,
            targetPlayerId,
            amount: 2,
            element: "thunder",
            hpEvoMask: ["from-jp"],
          },
        ]);
        this.append("effect.resolved", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          damageItems: planned,
        });
      } else if (effect.kind === "card:xyy.card.tp03") {
        const target = effectById(this.state, effect.parentEffectId ?? "");
        if (target?.kind !== "damage-batch" || effect.sourcePlayerId === null) {
          throw new Error("TP03 target damage batch is missing.");
        }
        this.append("effect.resolved", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          preventedItemIds: damageItemsForEffect(target)
            .filter((item) => tp03Preventable(item, effect.sourcePlayerId!))
            .map((item) => item.itemId),
        });
      } else if (effect.kind === "damage-batch") {
        this.append("effect.resolved", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          damageItems: damageItemsForEffect(effect),
        });
      } else if (effect.kind === "card:xyy.card.tp02") {
        const targetPlayerId = effect.targetIds[0]!;
        this.append("effect.resolved", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          healingItems: planCureBatch(this.state, [
            {
              itemId: `${effectId}:cure:0`,
              sourcePlayerId: effect.sourcePlayerId,
              targetPlayerId,
              amount: 2,
              element: "neutral",
            },
          ]),
        });
      } else if (effect.kind === "card:xyy.card.jp03") {
        this.append("effect.resolved", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          healingItems: planCureBatch(
            this.state,
            effect.targetIds.map((targetPlayerId, index) => ({
              itemId: `${effectId}:cure:${index}`,
              sourcePlayerId: effect.sourcePlayerId,
              targetPlayerId,
              amount: 1,
              element: "water",
              hpEvoMask: ["from-jp"],
            })),
          ),
        });
      } else {
        this.append("effect.resolved", {
          effectId,
          resolvedAt: this.serverReceivedAt,
          targetEffectId: effect.targetIds[0],
        });
      }
    }
  }
}

function validServerTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function beginCancellableCardEffect(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
  cardInstanceId: CardInstanceId,
  targetPlayerIds: PlayerId | readonly PlayerId[],
): ApplyCommandResult {
  if (!validServerTime(serverReceivedAt)) {
    return {
      accepted: false,
      reason: "invalid",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    envelope.commandId,
    input.version + 1,
    serverReceivedAt,
  );
  builder.append("effect.started", {
    playerId: envelope.playerId,
    cardInstanceId,
    targetPlayerIds: Array.isArray(targetPlayerIds)
      ? targetPlayerIds
      : [targetPlayerIds],
    effectId: `${input.matchId}:effect:${envelope.commandId}`,
    windowId: `${input.matchId}:window:${envelope.commandId}`,
    openedAt: serverReceivedAt,
  });
  builder.resolveClosedWindows();
  return { accepted: true, state: builder.state, events: builder.events };
}

export function beginSkillConvertedCardEffect(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
  cardInstanceIds: readonly CardInstanceId[],
  skillId: "xyy.skill.jn40301" | "xyy.skill.jn50201",
  convertedCardId: "xyy.card.tp02" | "xyy.card.jp01" | "xyy.card.jp06",
  targetPlayerId: PlayerId,
): ApplyCommandResult {
  if (!validServerTime(serverReceivedAt)) {
    return {
      accepted: false,
      reason: "invalid",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    envelope.commandId,
    input.version + 1,
    serverReceivedAt,
  );
  builder.append("effect.skill-card-converted", {
    playerId: envelope.playerId,
    cardInstanceIds,
    skillId,
    convertedCardId,
    targetPlayerIds: [targetPlayerId],
    effectId: `${input.matchId}:effect:${envelope.commandId}`,
    windowId: `${input.matchId}:window:${envelope.commandId}`,
    openedAt: serverReceivedAt,
  });
  builder.resolveClosedWindows();
  return { accepted: true, state: builder.state, events: builder.events };
}

function resolvePendingCardChoice(
  input: Readonly<MatchState>,
  commandId: CommandId,
  playerId: PlayerId,
  selectedOptionId: string,
  serverReceivedAt: number,
  timeout: boolean,
): ApplyCommandResult {
  const choice = input.pendingChoice;
  const effect =
    choice === null
      ? undefined
      : effectById(input, choice.continuation.effectId);
  const selected =
    effect === undefined
      ? undefined
      : cardForChoiceOption(input, effect, selectedOptionId);
  if (
    choice === null ||
    choice.status !== "open" ||
    !choice.playerIds.includes(playerId) ||
    (effect?.kind !== "card:xyy.card.jp01" &&
      effect?.kind !== "card:xyy.card.jp06" &&
      effect?.kind !== "hero-skill:xyy.skill.jn50202") ||
    selected === undefined
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  const planned = timeout ? nextInt(input.rng, choice.optionIds.length) : null;
  if (timeout && choice.optionIds[planned!.value] !== selectedOptionId) {
    return {
      accepted: false,
      reason: "invalid",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    commandId,
    input.version + 1,
    serverReceivedAt,
  );
  builder.append("effect.choice-resolved", {
    effectId: effect.effectId,
    choiceId: choice.choiceId,
    playerId,
    selectedOptionId,
    cardInstanceId: selected.cardInstanceId,
    timeout,
    rngCursor: planned?.rng.cursor ?? input.rng.cursor,
    resolvedAt: serverReceivedAt,
  });
  return { accepted: true, state: builder.state, events: builder.events };
}

function resolveEncounterOrder(
  input: Readonly<MatchState>,
  commandId: CommandId,
  playerId: PlayerId,
  selectedOptionId: string,
  resolvedAt: number,
  timeout: boolean,
): ApplyCommandResult {
  const choice = input.pendingChoice;
  if (
    choice === null ||
    !choice.playerIds.includes(playerId) ||
    (selectedOptionId !== "keep-order" &&
      selectedOptionId !== "swap-top-two") ||
    resolvedAt < choice.openedAt
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  const builder = new EventBuilder(
    input,
    commandId,
    input.version + 1,
    resolvedAt,
  );
  builder.append("effect.encounter-order-resolved", {
    effectId: choice.continuation.effectId,
    choiceId: choice.choiceId,
    playerId,
    selectedOptionId,
    resolvedAt,
    timeout,
  });
  return { accepted: true, state: builder.state, events: builder.events };
}

export function applyPendingChoiceCommand(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
): ApplyCommandResult {
  const choice = input.pendingChoice;
  const command = envelope.command;
  if (
    command.type !== "submit-choice" ||
    choice === null ||
    choice.status !== "open" ||
    command.choiceId !== choice.choiceId ||
    command.selections.length !== 1 ||
    !choice.optionIds.includes(command.selections[0]!)
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
  if (choice.continuation.resumeWith === "resolve-encounter-order") {
    return resolveEncounterOrder(
      input,
      envelope.commandId,
      envelope.playerId,
      command.selections[0]!,
      serverReceivedAt,
      false,
    );
  }
  return resolvePendingCardChoice(
    input,
    envelope.commandId,
    envelope.playerId,
    command.selections[0]!,
    serverReceivedAt,
    false,
  );
}

export function applyPendingChoiceTimeout(
  input: Readonly<MatchState>,
  command: Readonly<Extract<EngineCommand, { origin: "system-timeout" }>>,
  playerId: PlayerId,
): ApplyCommandResult {
  const choice = input.pendingChoice;
  if (
    choice === null ||
    choice.status !== "open" ||
    (choice.fallback !== "deterministic-random" &&
      choice.continuation.resumeWith !== "resolve-encounter-order") ||
    command.deadlineAt < choice.openedAt ||
    command.deadlineAt > choice.deadlineAt ||
    !choice.playerIds.includes(playerId) ||
    choice.optionIds.length === 0
  ) {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  if (choice.continuation.resumeWith === "resolve-encounter-order") {
    return resolveEncounterOrder(
      input,
      command.commandId,
      playerId,
      "keep-order",
      command.deadlineAt,
      true,
    );
  }
  const planned = nextInt(input.rng, choice.optionIds.length);
  return resolvePendingCardChoice(
    input,
    command.commandId,
    playerId,
    choice.optionIds[planned.value]!,
    command.deadlineAt,
    true,
  );
}

export function applyReactionCommand(
  input: Readonly<MatchState>,
  envelope: Readonly<CommandEnvelope>,
  serverReceivedAt: number,
): ApplyCommandResult {
  const window = input.reactionWindow;
  if (window === null || window.status !== "open") {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  if (!validServerTime(serverReceivedAt)) {
    return {
      accepted: false,
      reason: "invalid",
      currentVersion: input.version,
    };
  }
  if (serverReceivedAt > window.deadlineAt) {
    return {
      accepted: false,
      reason: "expired-window",
      currentVersion: input.version,
    };
  }
  const priorityPlayerId = window.priorityOrder[window.priorityIndex];
  if (priorityPlayerId !== envelope.playerId) {
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
  if (command.type === "pass-reaction") {
    if (command.windowId !== window.windowId) {
      return {
        accepted: false,
        reason: "expired-window",
        currentVersion: input.version,
      };
    }
    builder.append("reaction.passed", {
      playerId: envelope.playerId,
      windowId: window.windowId,
      openedAt: serverReceivedAt,
    });
    builder.resolveClosedWindows();
  } else if (command.type === "activate-damage-equipment") {
    if (command.targetEffectId !== window.effectId) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const cardInstanceId = command.cardInstanceId as CardInstanceId;
    const player = input.players[envelope.playerId]!;
    const targetEffect = effectById(input, window.effectId);
    const prevented =
      targetEffect?.kind === "damage-batch"
        ? damageItemsForEffect(targetEffect).filter((item) =>
            fj05Preventable(item, envelope.playerId),
          )
        : [];
    if (
      player.equipment.armor !== cardInstanceId ||
      cardDefinition(cardInstanceId).id !== "xyy.card.fj05" ||
      prevented.length === 0
    ) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const nextEventId = `${input.matchId}:event:${input.eventSequence + 1}`;
    builder.append("reaction.equipment-activated", {
      playerId: envelope.playerId,
      cardInstanceId,
      targetEffectId: window.effectId,
      preventedItemIds: prevented.map((item) => item.itemId),
      healingItems: planCureBatch(input, [
        {
          itemId: `${nextEventId}:cure:0`,
          sourcePlayerId: envelope.playerId,
          targetPlayerId: envelope.playerId,
          amount: 1,
          element: "neutral",
        },
      ]),
      openedAt: serverReceivedAt,
    });
    builder.resolveClosedWindows();
  } else if (command.type === "play-skill-converted-reaction-card") {
    if (command.targetEffectId !== window.effectId) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const cardInstanceId = command.cardInstanceId as CardInstanceId;
    const player = input.players[envelope.playerId]!;
    const targetEffect = effectById(input, window.effectId);
    let specialCard = false;
    try {
      specialCard = cardIdOf(cardInstanceId).startsWith("xyy.card.tp");
    } catch {
      specialCard = false;
    }
    if (
      command.skillId !== "xyy.skill.jn20202" ||
      player.heroId === null ||
      !heroHasSkill(player.heroId, "xyy.skill.jn20202") ||
      !player.hand.includes(cardInstanceId) ||
      !specialCard ||
      targetEffect === undefined ||
      targetEffect.kind === "damage-batch"
    ) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    builder.append("reaction.skill-card-converted", {
      playerId: envelope.playerId,
      cardInstanceId,
      skillId: "xyy.skill.jn20202",
      targetEffectId: window.effectId,
      effectId: `${input.matchId}:effect:${envelope.commandId}`,
      windowId: `${input.matchId}:window:${envelope.commandId}`,
      openedAt: serverReceivedAt,
    });
    builder.resolveClosedWindows();
  } else if (command.type === "play-converted-reaction-card") {
    if (command.targetEffectId !== window.effectId) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const cardInstanceId = command.cardInstanceId as CardInstanceId;
    const equipmentCardInstanceId =
      command.equipmentCardInstanceId as CardInstanceId;
    const player = input.players[envelope.playerId]!;
    const targetEffect = effectById(input, window.effectId);
    if (
      !player.hand.includes(cardInstanceId) ||
      player.equipment.armor !== equipmentCardInstanceId ||
      cardDefinition(equipmentCardInstanceId).id !== "xyy.card.fj02" ||
      targetEffect?.kind !== "damage-batch" ||
      !damageItemsForEffect(targetEffect).some((item) =>
        tp03Preventable(item, envelope.playerId),
      )
    ) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    builder.append("reaction.card-converted", {
      playerId: envelope.playerId,
      cardInstanceId,
      equipmentCardInstanceId,
      targetEffectId: window.effectId,
      effectId: `${input.matchId}:effect:${envelope.commandId}`,
      windowId: `${input.matchId}:window:${envelope.commandId}`,
      openedAt: serverReceivedAt,
    });
    builder.resolveClosedWindows();
  } else if (command.type === "play-reaction-card") {
    if (command.targetEffectId !== window.effectId) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    const cardInstanceId = command.cardInstanceId as CardInstanceId;
    const player = input.players[envelope.playerId]!;
    let definition;
    try {
      definition = cardDefinition(cardInstanceId);
    } catch {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    if (
      !player.hand.includes(cardInstanceId) ||
      !(
        (definition.coreAction?.type === "cancel-effect" &&
          effectById(input, window.effectId)?.kind !== "damage-batch") ||
        (definition.coreAction?.type === "prevent-damage" &&
          effectById(input, window.effectId)?.kind === "damage-batch")
      )
    ) {
      return {
        accepted: false,
        reason: "forbidden",
        currentVersion: input.version,
      };
    }
    builder.append("reaction.card-played", {
      playerId: envelope.playerId,
      cardInstanceId,
      targetEffectId: window.effectId,
      effectId: `${input.matchId}:effect:${envelope.commandId}`,
      windowId: `${input.matchId}:window:${envelope.commandId}`,
      openedAt: serverReceivedAt,
    });
    builder.resolveClosedWindows();
  } else {
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: input.version,
    };
  }
  return { accepted: true, state: builder.state, events: builder.events };
}
