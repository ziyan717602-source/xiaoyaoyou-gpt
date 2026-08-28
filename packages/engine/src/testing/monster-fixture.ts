import type { MatchState } from "../index.js";
import type { MonsterId } from "../encounter-content.js";
import type { EncounterParticipant } from "../encounter.js";
import { npcOptionsFixture } from "./npc-options-fixture.js";
import { beginNpcOptions } from "../npc-options.js";
import { acceptNpcCommand } from "./npc-fixture.js";

/** Reach a held real monster by passing a real NPC. Only scenario setup is
 * synthetic; debut and all subsequent commands use production reducers. */
export function monsterFixture(
  monsterId: MonsterId,
  options: {
    base?: MatchState;
    at?: number;
    seed?: string;
    supporter?: EncounterParticipant | null;
    hinder?: EncounterParticipant | null;
  } = {},
): MatchState {
  const input = npcOptionsFixture("xyy.npc.nc106", [monsterId], options);
  const opened = beginNpcOptions(
    input,
    "fixture-npc-open",
    input.turn!.openedAt + 1,
  ).state;
  const state = acceptNpcCommand(
    opened,
    opened.activePlayerId!,
    [],
    input.turn!.openedAt + 2,
  ).state;
  const flow = state.encounterState.resolution!;
  const enemy = state.turnOrder.find(
    (id) =>
      state.players[id]!.team !== state.players[state.activePlayerId!]!.team,
  )!;
  return {
    ...state,
    encounterState: {
      ...state.encounterState,
      resolution: {
        ...flow,
        supporter:
          options.supporter === undefined ? flow.supporter : options.supporter,
        hinder:
          options.hinder === undefined
            ? { kind: "player", playerId: enemy }
            : options.hinder,
      },
    },
  };
}

export function fundMonsterHands(
  state: MatchState,
  counts: readonly number[],
): MatchState {
  let deck = [...state.drawPile];
  const players = { ...state.players };
  for (const [i, id] of state.turnOrder.entries()) {
    const count = counts[i] ?? 0;
    players[id] = { ...players[id]!, hand: deck.slice(0, count) };
    deck = deck.slice(count);
  }
  return { ...state, players, drawPile: deck };
}
