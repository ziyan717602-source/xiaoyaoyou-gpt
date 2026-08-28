import type { ClientCommand, PlayerId } from "@xiaoyaoyou/protocol";
import {
  applyCommand,
  createSetupMatch,
  SETUP_CARD_INSTANCES,
  type EngineCommand,
  type MatchState,
} from "../index.js";

export function inspectionCommand(
  state: MatchState,
  playerId: PlayerId,
  command: ClientCommand,
  now = 1_000,
): EngineCommand {
  return {
    origin: "player",
    serverReceivedAt: now,
    envelope: {
      protocolVersion: 1,
      matchId: state.matchId,
      playerId,
      commandId: `inspection:${state.version}:${playerId}:${command.type}`,
      clientSequence: state.version,
      expectedVersion: state.version,
      clientIssuedAt: 0,
      command,
    },
  };
}

export function acceptInspection(state: MatchState, command: EngineCommand) {
  const result = applyCommand(state, command);
  if (!result.accepted) throw new Error(`Inspection command: ${result.reason}`);
  return result;
}

export function inspectionFixture(seed = "jp02-inspection"): MatchState {
  let state = createSetupMatch({
    matchId: "jp02-match",
    rulesetVersion: "standard-fengmingyushi@1",
    seed,
    players: Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      nickname: `P${i}`,
    })),
  });
  for (const playerId of state.turnOrder) {
    state = acceptInspection(
      state,
      inspectionCommand(
        state,
        playerId,
        {
          type: "choose-hero",
          heroId: state.setup!.offers[playerId]!.candidateHeroIds[0]!,
        },
        0,
      ),
    ).state;
  }
  const actor = state.activePlayerId!;
  const others = Object.keys(state.players).filter((id) => id !== actor);
  const hands = {
    [actor]: ["xyy.card.jp02@3", "xyy.card.jp02@4"],
    [others[0]!]: ["xyy.card.tp01@33"],
    [others[1]!]: ["xyy.card.tp01@34"],
  };
  const claimed = new Set(Object.values(hands).flat());
  return {
    ...state,
    players: Object.fromEntries(
      Object.values(state.players).map((p) => [
        p.id,
        {
          ...p,
          hand: hands[p.id] ?? [],
        },
      ]),
    ),
    drawPile: SETUP_CARD_INSTANCES.filter((id) => !claimed.has(id)),
    discardPile: [],
  } as MatchState;
}

export function startInspection(state: MatchState): MatchState {
  return acceptInspection(
    state,
    inspectionCommand(state, state.activePlayerId!, {
      type: "play-card",
      cardInstanceId: "xyy.card.jp02@3",
      targetPlayerIds: [state.activePlayerId!],
    }),
  ).state;
}

export function passInspectionReactions(state: MatchState): MatchState {
  let guard = 0;
  while (state.reactionWindow !== null) {
    if (++guard > 30) throw new Error("Inspection reactions did not terminate");
    const w = state.reactionWindow;
    state = acceptInspection(
      state,
      inspectionCommand(state, w.priorityOrder[w.priorityIndex]!, {
        type: "pass-reaction",
        windowId: w.windowId,
      }),
    ).state;
  }
  return state;
}
