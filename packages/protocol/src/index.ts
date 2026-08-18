export const PROTOCOL_VERSION = 1 as const;

export type MatchId = string;
export type PlayerId = string;
export type CommandId = string;
export type EffectId = string;
export type WindowId = string;
export type ChoiceId = string;
export type EventId = string;
export type ContinuationId = string;

export type ClientCommand =
  | {
      readonly type: "submit-choice";
      readonly choiceId: ChoiceId;
      readonly selections: readonly string[];
    }
  | {
      readonly type: "pass-reaction";
      readonly windowId: WindowId;
    };

export interface CommandEnvelope {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly commandId: CommandId;
  readonly matchId: MatchId;
  readonly playerId: PlayerId;
  readonly clientSequence: number;
  readonly expectedVersion: number;
  /** Client-reported audit metadata. Never authoritative for ordering or deadlines. */
  readonly clientIssuedAt: number;
  readonly command: ClientCommand;
}

export type ServerMessage =
  | {
      readonly type: "hello";
      readonly protocolVersion: typeof PROTOCOL_VERSION;
    }
  | {
      readonly type: "command-rejected";
      readonly commandId: CommandId;
      readonly reason:
        | "invalid"
        | "forbidden"
        | "stale-version"
        | "expired-window"
        | "stale-sequence"
        | "not-available"
        | "match-finished";
      readonly currentVersion: number;
    }
  | {
      readonly type: "player-view";
      readonly matchId: MatchId;
      readonly version: number;
      readonly view: unknown;
    };
