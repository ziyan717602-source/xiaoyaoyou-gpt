import type {
  CommandEnvelope,
  CommandId,
  PlayerId,
} from "@xiaoyaoyou/protocol";
import type {
  ApplyCommandResult,
  DomainEvent,
  EngineCommand,
} from "./architecture.js";
import type { MatchState, PendingChoice } from "./index.js";
import type { MonsterId, NpcId } from "./encounter-content.js";
import {
  encounterDefinition,
  type NpcActionId,
} from "./encounter-definitions.js";
import {
  assertEncounterOwnership,
  finishNpcAction,
  type EncounterResolution,
} from "./encounter-resolution.js";
import { planDraw } from "./card-zones.js";
import { planCureBatch, playersAfterCures } from "./healing.js";
import { planDamageBatch } from "./damage-dying.js";
import { beginDamageResponse } from "./reaction.js";
import { nextInt } from "./random.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";
import type { CardInstanceId } from "./setup-content.js";
import type { HeroId } from "./setup-content.js";
import type { EncounterCardId } from "./encounter-content.js";
import {
  isHeroJoinable,
  reloadHero,
  validateHeroRoster,
} from "./hero-roster.js";
import {
  exchangePet,
  petWeaponDisableReasons,
  type WeaponDisableReasons,
} from "./pet-effects.js";

interface NpcExecution {
  readonly effectId: string;
  readonly actionId: NpcActionId;
  readonly stage: "target" | "donor" | "recipient" | "card" | "pet" | "damage";
  readonly targets: readonly PlayerId[];
}
export interface EncounterRuntimeState {
  readonly heroDiscards: readonly HeroId[];
  readonly bannedHeroes: readonly HeroId[];
  readonly resolution: EncounterResolution | null;
  readonly pets: Readonly<Partial<Record<PlayerId, readonly MonsterId[]>>>;
  readonly companions: Readonly<Partial<Record<PlayerId, readonly NpcId[]>>>;
  readonly npc: NpcExecution | null;
  readonly weaponDisabledReasons: WeaponDisableReasons;
}
export function emptyEncounterRuntime(): EncounterRuntimeState {
  return {
    heroDiscards: [],
    bannedHeroes: [],
    resolution: null,
    pets: {},
    companions: {},
    npc: null,
    weaponDisabledReasons: {},
  };
}
const IMPLEMENTED_ACTIONS: readonly NpcActionId[] = [
  "xyy.npc-action.nj01",
  "xyy.npc-action.nj02",
  "xyy.npc-action.nj03",
  "xyy.npc-action.nj04",
  "xyy.npc-action.nj05",
  "xyy.npc-action.nj06",
  "xyy.npc-action.nj07",
  "xyy.npc-action.nj08",
  "xyy.npc-action.nj09",
];

/** Snapshot validation does not invent missing entities, selections or deadlines. */
export function validateEncounterRuntime(state: MatchState): void {
  const runtime = state.encounterState;
  if (
    runtime === null ||
    typeof runtime !== "object" ||
    Array.isArray(runtime) ||
    runtime.pets === null ||
    typeof runtime.pets !== "object" ||
    Array.isArray(runtime.pets) ||
    runtime.companions === null ||
    typeof runtime.companions !== "object" ||
    Array.isArray(runtime.companions) ||
    !("npc" in runtime) ||
    !("resolution" in runtime)
  )
    throw new Error("Invalid encounter runtime.");
  validateHeroRoster(state);
  for (const [owner, cards] of [
    ...Object.entries(runtime.pets),
    ...Object.entries(runtime.companions),
  ]) {
    if (state.players[owner] === undefined || !Array.isArray(cards))
      throw new Error("Invalid encounter owner.");
  }
  const reasons = runtime.weaponDisabledReasons;
  const expectedReasons = petWeaponDisableReasons(state, runtime.pets);
  if (
    reasons === null ||
    typeof reasons !== "object" ||
    Array.isArray(reasons) ||
    Object.keys(reasons).length !== Object.keys(expectedReasons).length ||
    Object.entries(expectedReasons).some(
      ([id, expected]) =>
        JSON.stringify(reasons[id]) !== JSON.stringify(expected),
    )
  )
    throw new Error("Invalid persisted weapon disable reasons.");
  const flow = runtime.resolution;
  if (
    flow !== null &&
    (typeof flow !== "object" ||
      typeof flow.flowId !== "string" ||
      state.players[flow.activePlayerId] === undefined ||
      !Number.isSafeInteger(flow.updatedAt) ||
      flow.updatedAt < 0 ||
      ![
        "monster-effects",
        "npc-options",
        "npc-choice",
        "npc-effect",
        "pet-choice",
        "completed",
        "deck-exhausted",
      ].includes(flow.stage))
  )
    throw new Error("Invalid encounter resolution.");
  if (flow?.stage === "npc-effect") {
    const effect = flow.pendingEffect;
    const definition =
      flow.heldCardId == null ? null : encounterDefinition(flow.heldCardId);
    if (
      effect == null ||
      typeof effect.effectId !== "string" ||
      effect.effectId.length === 0 ||
      effect.npcId !== flow.heldCardId ||
      definition?.kind !== "npc" ||
      !definition.actionIds.includes(effect.actionId) ||
      flow.npcDecision !== null ||
      flow.petDecision !== null
    )
      throw new Error("Invalid held NPC continuation.");
  }
  assertEncounterOwnership(flow, {
    ...state,
    pets: runtime.pets,
    companions: runtime.companions,
  });
  const occupied = new Set([
    ...state.encounterDeck,
    ...state.encounterDiscard,
    ...Object.values(runtime.pets).flat(),
    ...Object.values(runtime.companions).flat(),
    ...(flow?.heldCardId == null ? [] : [flow.heldCardId]),
  ]);
  for (const card of [...state.reserveNpcDeck, ...state.reserveNpcDiscard]) {
    if (encounterDefinition(card).kind !== "npc" || occupied.has(card))
      throw new Error("Duplicate reserved encounter entity.");
    occupied.add(card);
  }
  if (runtime.npc !== null) {
    const npc = runtime.npc;
    if (
      typeof npc !== "object" ||
      !IMPLEMENTED_ACTIONS.includes(npc.actionId) ||
      flow?.stage !== "npc-effect" ||
      flow.pendingEffect?.effectId !== npc.effectId ||
      flow.pendingEffect.actionId !== npc.actionId ||
      !Array.isArray(npc.targets) ||
      npc.targets.some((id) => state.players[id] === undefined) ||
      !["target", "donor", "recipient", "card", "pet", "damage"].includes(
        npc.stage,
      )
    )
      throw new Error("Invalid NPC execution.");
    const transfer =
      npc.actionId === "xyy.npc-action.nj01" ||
      npc.actionId === "xyy.npc-action.nj06" ||
      npc.actionId === "xyy.npc-action.nj07";
    const expectedTargets =
      npc.stage === "card" || npc.stage === "pet"
        ? 2
        : npc.stage === "recipient" || npc.stage === "damage"
          ? 1
          : 0;
    if (
      npc.targets.length !== expectedTargets ||
      (npc.stage === "damage"
        ? !["xyy.npc-action.nj03", "xyy.npc-action.nj05"].includes(npc.actionId)
        : transfer
          ? ![
              "donor",
              "recipient",
              ...(npc.actionId === "xyy.npc-action.nj01"
                ? []
                : [npc.actionId === "xyy.npc-action.nj07" ? "pet" : "card"]),
            ].includes(npc.stage)
          : npc.stage !== "target")
    )
      throw new Error("Invalid NPC execution step.");
    if (
      npc.actionId === "xyy.npc-action.nj01" &&
      !legalNpcActions(state, flow!.activePlayerId, flow!.heldCardId!).includes(
        npc.actionId,
      )
    )
      throw new Error("NPC role is no longer joinable.");
    if (
      transfer &&
      npc.targets.length > 0 &&
      (!selectionOptions(state, {
        ...npc,
        stage: "donor",
        targets: [],
      }).includes(npc.targets[0]!) ||
        (npc.targets.length === 2 &&
          !selectionOptions(state, { ...npc, stage: "recipient" }).includes(
            npc.targets[1]!,
          )))
    )
      throw new Error("Invalid NPC transfer participants.");
    const choice = state.pendingChoice;
    if (npc.stage === "damage") {
      if (choice?.continuation.resumeWith === "resolve-npc-choice")
        throw new Error("NPC damage cannot retain a target choice.");
    } else {
      const owner =
        npc.stage === "card" ? npc.targets[0] : flow!.activePlayerId;
      const options = selectionOptions(state, npc);
      if (
        choice == null ||
        choice.choiceId !== `${npc.effectId}:choice:${npc.stage}` ||
        choice.playerIds.length !== 1 ||
        choice.playerIds[0] !== owner ||
        choice.status !== "open" ||
        choice.minSelections !== 1 ||
        choice.maxSelections !== 1 ||
        choice.optional !== false ||
        choice.fallback !== "deterministic-random" ||
        !Number.isSafeInteger(choice.openedAt) ||
        choice.openedAt < flow!.updatedAt ||
        !Number.isSafeInteger(choice.deadlineAt) ||
        choice.deadlineAt !== choice.openedAt + ACTION_DEADLINE_MS ||
        choice.continuation.effectId !== npc.effectId ||
        choice.continuation.step !== npc.stage ||
        choice.continuation.resumeWith !== "resolve-npc-choice" ||
        options.length === 0 ||
        JSON.stringify(choice.optionIds) !== JSON.stringify(options)
      )
        throw new Error("Invalid NPC choice continuation.");
    }
  } else if (
    state.pendingChoice?.continuation.resumeWith === "resolve-npc-choice"
  ) {
    throw new Error("NPC choice lacks an execution cursor.");
  }
}
function orderedLiving(state: MatchState): readonly PlayerId[] {
  return Object.values(state.players)
    .filter((p) => p.alive)
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.id);
}
function quiet(state: MatchState): boolean {
  return (
    state.pendingChoice === null &&
    state.reactionWindow === null &&
    state.dyingBatch === null &&
    state.effectStack.length === 0
  );
}
function selectionOptions(
  state: MatchState,
  execution: NpcExecution,
): readonly string[] {
  const living = orderedLiving(state);
  if (execution.actionId === "xyy.npc-action.nj01") {
    const actor = state.encounterState.resolution!.activePlayerId;
    return Object.values(state.players)
      .filter(
        (p) =>
          p.team === state.players[actor]!.team &&
          (execution.stage === "recipient" || (p.alive && p.hand.length > 0)),
      )
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.id);
  }
  if (execution.stage === "target")
    return execution.actionId === "xyy.npc-action.nj08"
      ? living.filter((id) => state.players[id]!.hand.length > 0)
      : living;
  if (execution.stage === "donor")
    return living.filter(
      (id) =>
        (execution.actionId === "xyy.npc-action.nj07"
          ? (state.encounterState.pets[id]?.length ?? 0) > 0
          : state.players[id]!.hand.length > 0) &&
        living.some(
          (other) =>
            other !== id &&
            state.players[other]!.team === state.players[id]!.team,
        ),
    );
  const donor = execution.targets[0]!;
  if (execution.stage === "recipient")
    return living.filter(
      (id) =>
        id !== donor && state.players[id]!.team === state.players[donor]!.team,
    );
  if (execution.stage === "card")
    return state.players[donor]?.alive === true
      ? state.players[donor]!.hand
      : [];
  if (execution.stage === "pet")
    return state.players[donor]?.alive === true
      ? [...(state.encounterState.pets[donor] ?? [])].sort()
      : [];
  return [];
}

/** NC303 Valid handlers. No hidden card identity is consulted. */
export function legalNpcActions(
  state: MatchState,
  actor: PlayerId,
  cardId: EncounterCardId,
): readonly NpcActionId[] {
  const npc = encounterDefinition(cardId),
    player = state.players[actor];
  if (npc.kind !== "npc" || player?.alive !== true || player.team === null)
    return [];
  const living = Object.values(state.players).filter((p) => p.alive);
  return npc.actionIds.filter((action) => {
    if (action === "xyy.npc-action.nj01")
      return (
        isHeroJoinable(state, npc.heroId) &&
        living.some((p) => p.team === player.team && p.hand.length > 0)
      );
    if (action === "xyy.npc-action.nj06" || action === "xyy.npc-action.nj07")
      return living.some(
        (p) =>
          (action === "xyy.npc-action.nj06"
            ? p.hand.length > 0
            : (state.encounterState.pets[p.id]?.length ?? 0) > 0) &&
          living.some((other) => other.id !== p.id && other.team === p.team),
      );
    if (action === "xyy.npc-action.nj08")
      return living.some((p) => p.hand.length > 0);
    return true;
  });
}
function withChoice(
  state: MatchState,
  execution: NpcExecution,
  at: number,
): MatchState {
  const options = selectionOptions(state, execution);
  if (options.length === 0) throw new Error("NPC action has no legal target.");
  const owner =
    execution.stage === "card"
      ? execution.targets[0]!
      : state.encounterState.resolution!.activePlayerId;
  const choiceId = `${execution.effectId}:choice:${execution.stage}`;
  const choice: PendingChoice = {
    choiceId,
    playerIds: [owner],
    prompt: `npc:${execution.actionId}:${execution.stage}`,
    minSelections: 1,
    maxSelections: 1,
    optionIds: options,
    optional: false,
    fallback: "deterministic-random",
    status: "open",
    openedAt: at,
    deadlineAt: at + ACTION_DEADLINE_MS,
    continuation: {
      continuationId: `${choiceId}:continuation`,
      effectId: execution.effectId,
      step: execution.stage,
      locals: {},
      resumeWith: "resolve-npc-choice",
    },
  };
  return {
    ...state,
    encounterState: { ...state.encounterState, npc: execution },
    pendingChoice: choice,
  };
}
function finish(state: MatchState, at: number): MatchState {
  const runtime = state.encounterState;
  const flow = runtime.resolution!;
  const result = finishNpcAction(
    { ...flow, updatedAt: at },
    { ...state, pets: runtime.pets, companions: runtime.companions },
    flow.pendingEffect!.effectId,
  );
  return {
    ...state,
    encounterDeck: result.zones.encounterDeck,
    encounterDiscard: result.zones.encounterDiscard,
    encounterState: {
      ...runtime,
      resolution:
        state.phase === "finished"
          ? { ...result.flow, rewardDrawCount: 0, scoreTiming: "none" }
          : result.flow,
      pets: result.zones.pets,
      companions: result.zones.companions,
      npc: null,
    },
  };
}
type NpcOperation =
  | { readonly type: "start" }
  | { readonly type: "continue" }
  | {
      readonly type: "choice";
      readonly actor: PlayerId;
      readonly choiceId: string;
      readonly selection: string;
      readonly timeout: boolean;
    };

function transition(
  input: MatchState,
  operation: NpcOperation,
  at: number,
): { state: MatchState; report: Readonly<Record<string, unknown>> } {
  if (
    !Number.isSafeInteger(at) ||
    at < 0 ||
    !Number.isSafeInteger(at + ACTION_DEADLINE_MS)
  )
    throw new Error("Invalid NPC time.");
  validateEncounterRuntime(input);
  const flow = input.encounterState.resolution;
  const effect = flow?.pendingEffect;
  if (
    flow?.stage !== "npc-effect" ||
    effect == null ||
    flow.heldCardId !== effect.npcId ||
    (input.phase !== "finished" &&
      input.activePlayerId !== flow.activePlayerId) ||
    at < flow.updatedAt ||
    (input.phase !== "playing" &&
      !(operation.type === "continue" && input.phase === "finished")) ||
    (input.phase === "playing" && input.turn?.phase !== "encounter")
  )
    throw new Error("NPC effect is not ready.");
  if (!IMPLEMENTED_ACTIONS.includes(effect.actionId))
    throw new Error(`NPC handler not implemented: ${effect.actionId}`);
  let state = input;
  const report: Record<string, unknown> = {
    effectId: effect.effectId,
    actionId: effect.actionId,
  };
  const draw = (target: PlayerId) => {
    if (state.players[target]?.alive !== true) {
      report.drawnCardIds = [];
      return;
    }
    const plan = planDraw(state, 1);
    state = {
      ...state,
      drawPile: plan.drawPile,
      discardPile: plan.discardPile,
      rng: plan.rng,
      players: {
        ...state.players,
        [target]: {
          ...state.players[target]!,
          hand: [...state.players[target]!.hand, ...plan.cards],
        },
      },
    };
    report.drawnCardIds = plan.cards;
    report.drawPlayerId = target;
  };
  if (operation.type === "start") {
    if (
      state.encounterState.npc !== null ||
      !quiet(state) ||
      state.players[flow.activePlayerId]?.alive !== true
    )
      throw new Error("NPC action already started or interrupted.");
    const definition = encounterDefinition(effect.npcId);
    if (
      definition.kind !== "npc" ||
      !definition.actionIds.includes(effect.actionId) ||
      !legalNpcActions(state, flow.activePlayerId, effect.npcId).includes(
        effect.actionId,
      )
    )
      throw new Error("Foreign NPC action.");
    if (effect.actionId === "xyy.npc-action.nj04") {
      draw(flow.activePlayerId);
      state = finish(state, at);
    } else if (effect.actionId === "xyy.npc-action.nj09")
      state = finish(state, at);
    else
      state = withChoice(
        state,
        {
          effectId: effect.effectId,
          actionId: effect.actionId,
          stage: [
            "xyy.npc-action.nj01",
            "xyy.npc-action.nj06",
            "xyy.npc-action.nj07",
          ].includes(effect.actionId)
            ? "donor"
            : "target",
          targets: [],
        },
        at,
      );
  } else if (operation.type === "continue") {
    const execution = state.encounterState.npc;
    if (
      execution?.stage !== "damage" ||
      (!quiet(state) && state.phase !== "finished")
    )
      throw new Error("NPC child effects still pending.");
    if (
      state.phase !== "finished" &&
      execution.actionId === "xyy.npc-action.nj03"
    )
      draw(execution.targets[0]!);
    state = finish(state, at);
  } else {
    const execution = state.encounterState.npc;
    const choice = state.pendingChoice;
    if (
      execution === null ||
      execution.stage === "damage" ||
      choice?.continuation.resumeWith !== "resolve-npc-choice" ||
      choice.choiceId !== operation.choiceId ||
      choice.continuation.effectId !== execution.effectId ||
      choice.status !== "open" ||
      choice.playerIds[0] !== operation.actor ||
      at < choice.openedAt ||
      at > choice.deadlineAt ||
      !choice.optionIds.includes(operation.selection) ||
      !selectionOptions(state, execution).includes(operation.selection)
    )
      throw new Error("Invalid NPC choice.");
    if (operation.timeout) {
      const due =
        state.connections[operation.actor]?.status === "auto"
          ? choice.openedAt
          : choice.deadlineAt;
      if (at < due) throw new Error("NPC timeout is not due.");
      const options = [...choice.optionIds].sort();
      const drawn = nextInt(state.rng, options.length);
      if (options[drawn.value] !== operation.selection)
        throw new Error("NPC timeout selection does not match RNG.");
      state = { ...state, rng: drawn.rng };
    }
    state = { ...state, pendingChoice: null };
    const selected = operation.selection;
    if (execution.stage === "donor")
      state = withChoice(
        state,
        { ...execution, stage: "recipient", targets: [selected] },
        at,
      );
    else if (
      execution.stage === "recipient" &&
      execution.actionId === "xyy.npc-action.nj01"
    ) {
      const donor = execution.targets[0]!,
        cards = state.players[donor]!.hand;
      const definition = encounterDefinition(effect.npcId);
      if (
        definition.kind !== "npc" ||
        !legalNpcActions(state, flow.activePlayerId, effect.npcId).includes(
          execution.actionId,
        )
      )
        throw new Error("Illegal NPC role join.");
      const oldHero = state.players[selected]!.heroId;
      state = reloadHero(
        {
          ...state,
          players: {
            ...state.players,
            [donor]: { ...state.players[donor]!, hand: [] },
          },
          discardPile: [...state.discardPile, ...cards],
        },
        selected,
        definition.heroId,
        cards.length * 2,
      );
      report.heroJoin = {
        donor,
        recipient: selected,
        discardedCardIds: cards,
        oldHeroId: oldHero,
        heroId: definition.heroId,
        hp: state.players[selected]!.hp,
      };
      state = finish(state, at);
    } else if (execution.stage === "recipient")
      state = withChoice(
        state,
        {
          ...execution,
          stage: execution.actionId === "xyy.npc-action.nj07" ? "pet" : "card",
          targets: [...execution.targets, selected],
        },
        at,
      );
    else if (execution.stage === "pet") {
      const [donor, recipient] = execution.targets as readonly [
        PlayerId,
        PlayerId,
      ];
      state = exchangePet(state, donor, recipient, selected as MonsterId);
      report.petTransfer = {
        donor,
        recipient,
        selected,
        petsAfter: state.encounterState.pets,
      };
      state = finish(state, at);
    } else if (execution.stage === "card") {
      const [donor, recipient] = execution.targets as readonly [
        PlayerId,
        PlayerId,
      ];
      if (
        state.players[recipient]?.alive !== true ||
        state.players[recipient]!.team !== state.players[donor]!.team ||
        donor === recipient
      )
        throw new Error("NPC transfer recipient is invalid.");
      const card = selected as CardInstanceId;
      state = {
        ...state,
        players: {
          ...state.players,
          [donor]: {
            ...state.players[donor]!,
            hand: state.players[donor]!.hand.filter((id) => id !== card),
          },
          [recipient]: {
            ...state.players[recipient]!,
            hand: [...state.players[recipient]!.hand, card],
          },
        },
      };
      report.transferredCardId = card;
      report.donorPlayerId = donor;
      report.recipientPlayerId = recipient;
      state = finish(state, at);
    } else if (execution.actionId === "xyy.npc-action.nj02") {
      const cures = planCureBatch(state, [
        {
          itemId: `${execution.effectId}:cure`,
          sourcePlayerId: null,
          targetPlayerId: selected,
          amount: 1,
          element: "neutral",
          hpEvoMask: ["from-nmb"],
        },
      ]);
      state = { ...state, players: playersAfterCures(state, cures) };
      report.cures = cures;
      state = finish(state, at);
    } else if (execution.actionId === "xyy.npc-action.nj08") {
      const target = state.players[selected]!;
      const options = [...target.hand].sort();
      const drawn = nextInt(state.rng, options.length),
        card = options[drawn.value]!;
      state = {
        ...state,
        rng: drawn.rng,
        players: {
          ...state.players,
          [selected]: {
            ...target,
            hand: target.hand.filter((id) => id !== card),
          },
        },
        discardPile: [...state.discardPile, card],
      };
      report.discardedCardId = card;
      report.targetPlayerId = selected;
      state = finish(state, at);
    } else if (
      execution.actionId === "xyy.npc-action.nj03" ||
      execution.actionId === "xyy.npc-action.nj05"
    ) {
      const damage = planDamageBatch(state, [
        {
          itemId: `${execution.effectId}:damage`,
          sourcePlayerId: null,
          targetPlayerId:
            execution.actionId === "xyy.npc-action.nj03"
              ? flow.activePlayerId
              : selected,
          amount: 1,
          element: "neutral",
          hpEvoMask: ["from-nmb"],
        },
      ]);
      state = {
        ...state,
        encounterState: {
          ...state.encounterState,
          npc: { ...execution, stage: "damage", targets: [selected] },
        },
      };
      state = beginDamageResponse(state, execution.effectId, null, damage, at);
      report.damage = damage;
      if (quiet(state)) {
        if (execution.actionId === "xyy.npc-action.nj03") draw(selected);
        state = finish(state, at);
      }
    } else throw new Error("Unsupported NPC execution step.");
  }
  report.rngCursorStart = input.rng.cursor;
  report.rngCursorEnd = state.rng.cursor;
  validateEncounterRuntime(state);
  return { state, report };
}

export function reduceNpcEvent(
  state: MatchState,
  event: DomainEvent,
): MatchState {
  const { operation, resolvedAt, matchVersion, report } = event.payload;
  if (
    event.type !== "npc.operation" ||
    event.matchId !== state.matchId ||
    event.rulesetVersion !== state.rulesetVersion ||
    event.sequence !== state.eventSequence + 1 ||
    matchVersion !==
      (event.causationEventId === null ? state.version + 1 : state.version) ||
    typeof resolvedAt !== "number" ||
    operation === null ||
    typeof operation !== "object"
  )
    throw new Error("Invalid NPC event head.");
  const op = operation as NpcOperation;
  if (op.type !== "start" && op.type !== "continue" && op.type !== "choice")
    throw new Error("Invalid NPC operation.");
  if (
    op.type === "choice" &&
    (typeof op.actor !== "string" ||
      typeof op.choiceId !== "string" ||
      typeof op.selection !== "string" ||
      typeof op.timeout !== "boolean")
  )
    throw new Error("Invalid NPC choice event.");
  const expected = transition(state, op, resolvedAt);
  if (JSON.stringify(expected.report) !== JSON.stringify(report))
    throw new Error("NPC event report disagrees with deterministic execution.");
  return {
    ...expected.state,
    version: matchVersion as number,
    eventSequence: event.sequence,
  };
}
function execute(
  state: MatchState,
  operation: NpcOperation,
  commandId: CommandId,
  at: number,
  causationEventId: string | null = null,
): Extract<ApplyCommandResult, { accepted: true }> {
  const expected = transition(state, operation, at);
  const event: DomainEvent = {
    type: "npc.operation",
    eventId: `${state.matchId}:event:${state.eventSequence + 1}`,
    sequence: state.eventSequence + 1,
    matchId: state.matchId,
    rulesetVersion: state.rulesetVersion,
    causationCommandId: commandId,
    causationEventId,
    payload: {
      operation,
      resolvedAt: at,
      matchVersion: state.version + (causationEventId === null ? 1 : 0),
      report: expected.report,
    },
  };
  return {
    accepted: true,
    state: reduceNpcEvent(state, event),
    events: [event],
  };
}
/** Internal encounter continuation entry. It consumes a previously selected,
 * held NPC; clients cannot select a card, fabricate a flow or invoke this entry. */
export function beginNpcAction(
  state: MatchState,
  commandId: CommandId,
  at: number,
) {
  return execute(state, { type: "start" }, commandId, at);
}
export function applyNpcChoiceCommand(
  state: MatchState,
  envelope: CommandEnvelope,
  at: number,
): ApplyCommandResult {
  const command = envelope.command;
  const choice = state.pendingChoice;
  const reject = (
    reason: "forbidden" | "invalid" | "expired-window",
  ): ApplyCommandResult => ({
    accepted: false,
    reason,
    currentVersion: state.version,
  });
  if (
    command.type !== "submit-choice" ||
    choice?.continuation.resumeWith !== "resolve-npc-choice" ||
    choice.playerIds[0] !== envelope.playerId ||
    command.choiceId !== choice.choiceId
  )
    return reject("forbidden");
  if (at > choice.deadlineAt) return reject("expired-window");
  if (
    !Number.isSafeInteger(at) ||
    at < choice.openedAt ||
    command.selections.length !== 1 ||
    !choice.optionIds.includes(command.selections[0]!)
  )
    return reject("invalid");
  return execute(
    state,
    {
      type: "choice",
      actor: envelope.playerId,
      choiceId: choice.choiceId,
      selection: command.selections[0]!,
      timeout: false,
    },
    envelope.commandId,
    at,
  );
}
export function applyNpcChoiceTimeout(
  state: MatchState,
  command: Extract<EngineCommand, { origin: "system-timeout" }>,
  playerId: PlayerId,
): ApplyCommandResult {
  const choice = state.pendingChoice;
  if (
    choice?.continuation.resumeWith !== "resolve-npc-choice" ||
    choice.playerIds[0] !== playerId
  )
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: state.version,
    };
  const options = [...choice.optionIds].sort();
  const random = nextInt(state.rng, options.length);
  return execute(
    state,
    {
      type: "choice",
      actor: playerId,
      choiceId: choice.choiceId,
      selection: options[random.value]!,
      timeout: true,
    },
    command.commandId,
    command.deadlineAt,
  );
}
export function continueNpcAfterDamage(
  state: MatchState,
  commandId: CommandId,
  at: number,
  causationEventId: string | null,
): { state: MatchState; events: readonly DomainEvent[] } {
  if (
    state.encounterState.npc?.stage !== "damage" ||
    (state.phase !== "finished" && !quiet(state))
  )
    return { state, events: [] };
  return execute(state, { type: "continue" }, commandId, at, causationEventId);
}
