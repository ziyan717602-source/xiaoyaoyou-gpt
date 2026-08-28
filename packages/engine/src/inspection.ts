import type { DomainEvent } from "./architecture.js";
import type { MatchState } from "./index.js";
import { ACTION_DEADLINE_MS } from "./time-recovery.js";

export const INSPECTION_OPTIONS = ["keep-order", "swap-top-two"] as const;

/** Invoked by the reaction reducer after it validates the event head/version. */
export function reduceInspectionEvent(
  state: Readonly<MatchState>,
  event: Readonly<DomainEvent>,
): MatchState {
  const { effectId, resolvedAt } = event.payload;
  const effect = state.effectStack.find((e) => e.effectId === effectId);
  if (
    effect?.kind !== "card:xyy.card.jp02" ||
    effect.sourcePlayerId === null ||
    typeof resolvedAt !== "number" ||
    !Number.isSafeInteger(resolvedAt) ||
    resolvedAt < 0
  ) {
    throw new Error("Encounter inspection effect is invalid.");
  }
  const owner = effect.sourcePlayerId;
  const withoutEffect = state.effectStack.filter(
    (e) => e.effectId !== effectId,
  );
  if (event.type === "effect.encounter-inspected") {
    const window = state.reactionWindow;
    const cards = event.payload.cardIds;
    const top = state.encounterDeck.slice(0, 2);
    if (
      effect.status !== "waiting" ||
      effect.parentEffectId !== null ||
      state.pendingChoice !== null ||
      window === null ||
      window.effectId !== effectId ||
      window.status !== "closed" ||
      !Array.isArray(cards) ||
      cards.length !== top.length ||
      cards.some((id, i) => id !== top[i])
    ) {
      throw new Error(
        "Encounter inspection does not match the closed response and deck.",
      );
    }
    const choiceId = `${effectId}:choice:encounter-order`;
    return {
      ...state,
      // A zero-card resolution fizzles; it must not manufacture private knowledge.
      encounterInspections:
        top.length === 0
          ? state.encounterInspections
          : {
              ...state.encounterInspections,
              [owner]: {
                effectId: effect.effectId,
                inspectedAt: resolvedAt,
                cardIds: top,
              },
            },
      reactionWindow: null,
      effectStack:
        top.length < 2
          ? withoutEffect
          : state.effectStack.map((e) =>
              e.effectId === effectId
                ? {
                    ...e,
                    step: "awaiting-encounter-order",
                    status: "resolving",
                  }
                : e,
            ),
      pendingChoice:
        top.length < 2
          ? null
          : {
              choiceId,
              playerIds: [owner],
              prompt: "inspect-encounter",
              minSelections: 1,
              maxSelections: 1,
              optionIds: INSPECTION_OPTIONS,
              optional: true,
              status: "open",
              fallback: "pass",
              openedAt: resolvedAt,
              deadlineAt: resolvedAt + ACTION_DEADLINE_MS,
              continuation: {
                continuationId: `${choiceId}:continuation`,
                effectId: effect.effectId,
                step: "after-encounter-inspection",
                locals: {},
                resumeWith: "resolve-encounter-order",
              },
            },
    };
  }
  const { choiceId, playerId, selectedOptionId, timeout } = event.payload;
  const choice = state.pendingChoice;
  const inspection = state.encounterInspections[owner];
  if (
    event.type !== "effect.encounter-order-resolved" ||
    effect.status !== "resolving" ||
    state.reactionWindow !== null ||
    choice === null ||
    choice.status !== "open" ||
    choice.choiceId !== choiceId ||
    choice.continuation.effectId !== effectId ||
    choice.continuation.resumeWith !== "resolve-encounter-order" ||
    playerId !== owner ||
    !choice.playerIds.includes(owner) ||
    (selectedOptionId !== "keep-order" &&
      selectedOptionId !== "swap-top-two") ||
    typeof timeout !== "boolean" ||
    (timeout && selectedOptionId !== "keep-order") ||
    resolvedAt < choice.openedAt ||
    resolvedAt > choice.deadlineAt ||
    inspection?.effectId !== effectId ||
    inspection.cardIds.length !== 2 ||
    inspection.cardIds.some((id, i) => state.encounterDeck[i] !== id)
  ) {
    throw new Error("Encounter order resolution is invalid.");
  }
  return {
    ...state,
    encounterDeck:
      selectedOptionId === "keep-order"
        ? state.encounterDeck
        : [
            state.encounterDeck[1]!,
            state.encounterDeck[0]!,
            ...state.encounterDeck.slice(2),
          ],
    effectStack: withoutEffect,
    pendingChoice: null,
  };
}
