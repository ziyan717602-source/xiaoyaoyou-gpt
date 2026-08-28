import type { MatchState } from "../index.js";
import type { EncounterCardId, NpcId } from "../encounter-content.js";
import { encounterDefinition } from "../encounter-definitions.js";
import { npcFixture } from "./npc-fixture.js";

/** Starts just after a real NPC reveal, before any action is selected. Optional
 * tail simulates the remaining main deck, preserving all 46 encounter entities. */
export function npcOptionsFixture(
  npcId: NpcId = "xyy.npc.nc106",
  tail?: readonly EncounterCardId[],
  options: {
    readonly seed?: string;
    readonly base?: MatchState;
    readonly at?: number;
  } = {},
): MatchState {
  const npc = encounterDefinition(npcId);
  if (npc.kind !== "npc") throw new Error("NPC fixture requires an NPC");
  const state = npcFixture(npc.actionIds[0]!, options.seed ?? "npc-options", {
    ...options,
    npcId,
  });
  const flow = state.encounterState.resolution!;
  const unresolved: MatchState = {
    ...state,
    encounterState: {
      ...state.encounterState,
      resolution: {
        ...flow,
        stage: "npc-options",
        pendingEffect: null,
        updatedAt: state.turn!.openedAt,
      },
    },
  };
  if (tail === undefined) return unresolved;
  if (tail.includes(npcId) || new Set(tail).size !== tail.length)
    throw new Error("Duplicate fixture encounter");
  const rest = [...state.encounterDeck, ...state.reserveNpcDeck].filter(
    (id) => !tail.includes(id),
  );
  const reserve = rest
    .filter((id) => id.startsWith("xyy.npc."))
    .slice(0, 16) as NpcId[];
  return {
    ...unresolved,
    encounterDeck: tail,
    reserveNpcDeck: reserve,
    encounterDiscard: rest.filter((id) => !reserve.includes(id as NpcId)),
  };
}
