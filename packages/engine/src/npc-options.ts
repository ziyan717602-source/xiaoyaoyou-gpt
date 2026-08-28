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
import {
  beginNpcAction,
  legalNpcActions,
  validateEncounterRuntime,
} from "./npc-effects.js";
import {
  chooseNpcAction,
  openNpcDecision,
  type EncounterResolutionResult,
  type NpcDecision,
} from "./encounter-resolution.js";
import {
  encounterDefinition,
  type NpcActionId,
} from "./encounter-definitions.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";
import { nextInt } from "./random.js";

const RESUME = "resolve-npc-action";
const EVENT = "npc-options.operation";
type Operation =
  | { readonly type: "open" }
  | {
      readonly type: "select";
      readonly actor: PlayerId;
      readonly choiceId: string;
      readonly actionId: NpcActionId | null;
      readonly timeout: boolean;
    };
function pending(window: NpcDecision): PendingChoice {
  return {
    choiceId: window.choiceId,
    playerIds: [window.ownerPlayerId],
    prompt: "npc:choose-action",
    minSelections: window.canPass ? 0 : 1,
    maxSelections: 1,
    optionIds: window.actionIds,
    optional: window.canPass,
    fallback: window.canPass ? "pass" : "deterministic-random",
    status: "open",
    openedAt: window.openedAt,
    deadlineAt: window.deadlineAt,
    continuation: {
      continuationId: `${window.choiceId}:continuation`,
      effectId: window.choiceId,
      step: "npc-action",
      locals: {},
      resumeWith: RESUME,
    },
  };
}
const zones = (state: MatchState) => ({
  ...state,
  pets: state.encounterState.pets,
  companions: state.encounterState.companions,
});
function adopt(state: MatchState, next: EncounterResolutionResult): MatchState {
  return {
    ...state,
    encounterDeck: next.zones.encounterDeck,
    encounterDiscard: next.zones.encounterDiscard,
    encounterState: {
      ...state.encounterState,
      resolution: next.flow,
      pets: next.zones.pets,
      companions: next.zones.companions,
    },
  };
}

/** Bind the persisted generic choice to the real NPC window and fresh Valid
 * predicates. No repair of missing, altered or expired choices on restoration. */
export function validateNpcOptions(state: MatchState): void {
  const flow = state.encounterState.resolution;
  if (flow?.stage !== "npc-choice") {
    if (
      state.pendingChoice?.continuation.resumeWith === RESUME ||
      flow?.npcDecision != null
    )
      throw new Error("Orphan NPC action window.");
    return;
  }
  const window = flow.npcDecision;
  if (
    window === null ||
    typeof window !== "object" ||
    flow.heldCardId === null ||
    encounterDefinition(flow.heldCardId).kind !== "npc" ||
    !Number.isSafeInteger(flow.revealCount) ||
    flow.revealCount < 1 ||
    flow.pendingEffect !== null ||
    flow.petDecision !== null ||
    state.encounterState.npc !== null ||
    state.phase !== "playing" ||
    state.turn?.phase !== "encounter" ||
    state.activePlayerId !== flow.activePlayerId ||
    state.players[flow.activePlayerId]?.alive !== true ||
    state.reactionWindow !== null ||
    state.dyingBatch !== null ||
    state.effectStack.length !== 0 ||
    window.choiceId !== `${flow.flowId}:npc:${flow.revealCount}` ||
    window.ownerPlayerId !== flow.activePlayerId ||
    window.canPass !== state.encounterDeck.length > 0 ||
    !Number.isSafeInteger(window.openedAt) ||
    window.openedAt < 0 ||
    window.openedAt !== flow.updatedAt ||
    !Number.isSafeInteger(window.deadlineAt) ||
    window.deadlineAt !== window.openedAt + ACTION_DEADLINE_MS ||
    !Array.isArray(window.actionIds) ||
    window.actionIds.length === 0 ||
    JSON.stringify(window.actionIds) !==
      JSON.stringify(
        legalNpcActions(state, flow.activePlayerId, flow.heldCardId),
      ) ||
    JSON.stringify(state.pendingChoice) !== JSON.stringify(pending(window))
  )
    throw new Error("Invalid NPC action window.");
}

function advance(input: MatchState, at: number): MatchState {
  let state = input;
  // Every no-option pass consumes one card; no unbounded recursive continuation.
  const limit = input.encounterDeck.length + 1;
  for (
    let i = 0;
    state.encounterState.resolution?.stage === "npc-options";
    i++
  ) {
    if (i >= limit) throw new Error("NPC reveal did not progress.");
    const flow = state.encounterState.resolution;
    const legal = legalNpcActions(state, flow.activePlayerId, flow.heldCardId!);
    state = adopt(state, openNpcDecision(flow, zones(state), legal, at));
  }
  const window = state.encounterState.resolution?.npcDecision;
  return { ...state, pendingChoice: window == null ? null : pending(window) };
}
function transition(input: MatchState, operation: Operation, at: number) {
  validateEncounterRuntime(input);
  validateNpcOptions(input);
  const flow = input.encounterState.resolution;
  if (
    !Number.isSafeInteger(at) ||
    at < 0 ||
    !Number.isSafeInteger(at + ACTION_DEADLINE_MS) ||
    flow == null ||
    at < flow.updatedAt ||
    input.phase !== "playing" ||
    input.turn?.phase !== "encounter" ||
    flow.activePlayerId !== input.activePlayerId ||
    input.players[flow.activePlayerId]?.alive !== true ||
    input.encounterState.npc !== null ||
    input.reactionWindow !== null ||
    input.dyingBatch !== null ||
    input.effectStack.length !== 0
  )
    throw new Error("NPC selection is not ready.");
  let state = input;
  if (operation.type === "open") {
    if (flow.stage !== "npc-options" || input.pendingChoice !== null)
      throw new Error("NPC window already opened.");
    state = advance(state, at);
  } else {
    const window = flow.npcDecision;
    if (
      flow.stage !== "npc-choice" ||
      window === null ||
      operation.actor !== window.ownerPlayerId ||
      operation.choiceId !== window.choiceId ||
      at < window.openedAt ||
      at > window.deadlineAt ||
      (operation.actionId === null
        ? !window.canPass
        : !window.actionIds.includes(operation.actionId))
    )
      throw new Error("Illegal NPC action selection.");
    if (operation.timeout) {
      const due =
        state.connections[operation.actor]?.status === "auto"
          ? window.openedAt
          : window.deadlineAt;
      if (at !== due) throw new Error("NPC action timeout is not due.");
      if (!window.canPass) {
        const random = nextInt(state.rng, window.actionIds.length);
        if ([...window.actionIds].sort()[random.value] !== operation.actionId)
          throw new Error("Incorrect seeded NPC action.");
        state = { ...state, rng: random.rng };
      } else if (operation.actionId !== null)
        throw new Error("Optional NPC timeout must pass.");
    }
    state = adopt(
      { ...state, pendingChoice: null },
      chooseNpcAction(
        flow,
        zones(state),
        operation.actor,
        operation.choiceId,
        operation.actionId,
        at,
      ),
    );
    if (operation.actionId === null) state = advance(state, at);
  }
  validateEncounterRuntime(state);
  validateNpcOptions(state);
  return {
    state,
    report: {
      heldBefore: flow.heldCardId,
      heldAfter: state.encounterState.resolution!.heldCardId,
      stage: state.encounterState.resolution!.stage,
      discarded: state.encounterDiscard.slice(input.encounterDiscard.length),
      revealCount: state.encounterState.resolution!.revealCount,
      rngCursorStart: input.rng.cursor,
      rngCursorEnd: state.rng.cursor,
    },
  };
}

export function reduceNpcOptionsEvent(
  state: MatchState,
  event: DomainEvent,
): MatchState {
  const { operation, resolvedAt, matchVersion, report } = event.payload;
  if (
    event.type !== EVENT ||
    event.matchId !== state.matchId ||
    event.rulesetVersion !== state.rulesetVersion ||
    event.sequence !== state.eventSequence + 1 ||
    matchVersion !==
      state.version + (event.causationEventId === null ? 1 : 0) ||
    typeof resolvedAt !== "number" ||
    operation === null ||
    typeof operation !== "object"
  )
    throw new Error("Invalid NPC options event.");
  const op = operation as Operation;
  if (op.type !== "open" && op.type !== "select")
    throw new Error("Invalid NPC options operation.");
  if (
    op.type === "select" &&
    (typeof op.actor !== "string" ||
      typeof op.choiceId !== "string" ||
      typeof op.timeout !== "boolean" ||
      (op.actionId !== null && typeof op.actionId !== "string"))
  )
    throw new Error("Invalid NPC options selection.");
  const next = transition(state, op, resolvedAt);
  if (JSON.stringify(next.report) !== JSON.stringify(report))
    throw new Error("NPC options report mismatch.");
  return {
    ...next.state,
    version: matchVersion as number,
    eventSequence: event.sequence,
  };
}
function execute(
  input: MatchState,
  operation: Operation,
  commandId: CommandId,
  at: number,
  causationEventId: string | null = null,
): Extract<ApplyCommandResult, { accepted: true }> {
  const planned = transition(input, operation, at);
  const event: DomainEvent = {
    type: EVENT,
    eventId: `${input.matchId}:event:${input.eventSequence + 1}`,
    sequence: input.eventSequence + 1,
    matchId: input.matchId,
    rulesetVersion: input.rulesetVersion,
    causationCommandId: commandId,
    causationEventId,
    payload: {
      operation,
      resolvedAt: at,
      matchVersion: input.version + (causationEventId === null ? 1 : 0),
      report: planned.report,
    },
  };
  const state = reduceNpcOptionsEvent(input, event);
  if (operation.type === "select" && operation.actionId !== null) {
    const effect = beginNpcAction(state, commandId, at, event.eventId);
    return { ...effect, events: [event, ...effect.events] };
  }
  return { accepted: true, state, events: [event] };
}
/** Internal entry after encounter reveal; no client can construct a flow/card. */
export function beginNpcOptions(
  state: MatchState,
  commandId: CommandId,
  at: number,
  causationEventId: string | null = null,
) {
  return execute(state, { type: "open" }, commandId, at, causationEventId);
}
export function applyNpcActionCommand(
  state: MatchState,
  envelope: CommandEnvelope,
  at: number,
): ApplyCommandResult {
  const command = envelope.command,
    choice = state.pendingChoice;
  const reject = (
    reason: "forbidden" | "invalid" | "expired-window",
  ): ApplyCommandResult => ({
    accepted: false,
    reason,
    currentVersion: state.version,
  });
  if (
    command.type !== "submit-choice" ||
    choice?.continuation.resumeWith !== RESUME ||
    choice.playerIds[0] !== envelope.playerId ||
    command.choiceId !== choice.choiceId
  )
    return reject("forbidden");
  if (at > choice.deadlineAt) return reject("expired-window");
  if (
    !Number.isSafeInteger(at) ||
    at < choice.openedAt ||
    command.selections.length < choice.minSelections ||
    command.selections.length > 1 ||
    command.selections.some((id) => !choice.optionIds.includes(id))
  )
    return reject("invalid");
  return execute(
    state,
    {
      type: "select",
      actor: envelope.playerId,
      choiceId: choice.choiceId,
      actionId: (command.selections[0] as NpcActionId | undefined) ?? null,
      timeout: false,
    },
    envelope.commandId,
    at,
  );
}
export function applyNpcActionTimeout(
  state: MatchState,
  command: Extract<EngineCommand, { origin: "system-timeout" }>,
  playerId: PlayerId,
): ApplyCommandResult {
  const choice = state.pendingChoice;
  if (
    choice?.continuation.resumeWith !== RESUME ||
    choice.playerIds[0] !== playerId
  )
    return {
      accepted: false,
      reason: "not-available",
      currentVersion: state.version,
    };
  const selected = choice.optional
    ? null
    : ([...choice.optionIds].sort()[
        nextInt(state.rng, choice.optionIds.length).value
      ]! as NpcActionId);
  return execute(
    state,
    {
      type: "select",
      actor: playerId,
      choiceId: choice.choiceId,
      actionId: selected,
      timeout: true,
    },
    command.commandId,
    command.deadlineAt,
  );
}
