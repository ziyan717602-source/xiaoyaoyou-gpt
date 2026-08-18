import type {
  CommandEnvelope,
  CommandId,
  CommandRejectionReason,
  EventId,
  MatchId,
  PlayerId,
} from "@xiaoyaoyou/protocol";
import type {
  MatchState,
  PendingChoice,
  PlayerView,
  ReactionWindow,
} from "./index.js";

export interface DomainEvent {
  readonly eventId: EventId;
  readonly sequence: number;
  readonly matchId: MatchId;
  readonly causationCommandId: CommandId;
  readonly causationEventId: EventId | null;
  readonly rulesetVersion: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type EngineCommand =
  | {
      readonly origin: "player";
      readonly envelope: CommandEnvelope;
      readonly serverReceivedAt: number;
    }
  | {
      readonly origin: "system-timeout";
      readonly commandId: CommandId;
      readonly matchId: MatchId;
      readonly expectedVersion: number;
      readonly deadlineAt: number;
      readonly targetId: string;
    }
  | {
      readonly origin: "system-presence";
      readonly commandId: CommandId;
      readonly matchId: MatchId;
      readonly expectedVersion: number;
      readonly playerId: PlayerId;
      readonly status: "connected" | "disconnected";
      readonly occurredAt: number;
    }
  | {
      readonly origin: "system-auto";
      readonly commandId: CommandId;
      readonly matchId: MatchId;
      readonly expectedVersion: number;
      readonly playerId: PlayerId;
      readonly disconnectedAt: number;
      readonly deadlineAt: number;
    };

export type ApplyCommandResult =
  | {
      readonly accepted: true;
      readonly state: MatchState;
      readonly events: readonly DomainEvent[];
    }
  | {
      readonly accepted: false;
      readonly reason: CommandRejectionReason;
      readonly currentVersion: number;
    };

export type ResumeResult =
  | { readonly status: "resolved"; readonly state: MatchState }
  | {
      readonly status: "pending-choice";
      readonly state: MatchState;
      readonly pendingChoice: PendingChoice;
    }
  | {
      readonly status: "reaction-window";
      readonly state: MatchState;
      readonly reactionWindow: ReactionWindow;
    }
  | { readonly status: "game-over"; readonly state: MatchState };

/** Pure, deterministic production boundary. Implementations cannot read I/O or wall time. */
export interface EngineApi {
  readonly applyCommand: (
    state: Readonly<MatchState>,
    command: Readonly<EngineCommand>,
  ) => ApplyCommandResult;
  readonly resume: (state: Readonly<MatchState>) => ResumeResult;
  readonly projectPlayerView: (
    state: Readonly<MatchState>,
    playerId: PlayerId,
  ) => PlayerView;
  readonly reduceEvent: (
    state: Readonly<MatchState>,
    event: Readonly<DomainEvent>,
  ) => MatchState;
}
