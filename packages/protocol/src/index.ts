import { Ajv, type ErrorObject, type ValidateFunction } from "ajv/dist/ajv.js";

export const PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const;

export type MatchId = string;
export type RoomId = string;
export type PlayerId = string;
export type CommandId = string;
export type EffectId = string;
export type WindowId = string;
export type ChoiceId = string;
export type EventId = string;
export type ContinuationId = string;
export type ConnectionId = string;

export type RoomStatus = "open" | "started" | "ended";

export interface RoomSeatView {
  readonly seatIndex: number;
  readonly playerId: PlayerId;
  readonly nickname: string;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly host: boolean;
}

export interface RoomView {
  readonly roomId: RoomId;
  readonly inviteCode: string;
  readonly status: RoomStatus;
  readonly version: number;
  readonly matchId: MatchId | null;
  readonly seats: readonly RoomSeatView[];
}

export interface RoomSession {
  readonly room: RoomView;
  readonly playerId: PlayerId;
  readonly seatIndex: number;
  readonly reconnectToken: string;
}

export type ClientCommand =
  | {
      readonly type: "choose-hero";
      readonly heroId: string;
    }
  | { readonly type: "reroll-hero" }
  | {
      readonly type: "play-card";
      readonly cardInstanceId: string;
      readonly targetPlayerIds: readonly PlayerId[];
      readonly mode?: "primary" | "pawn";
    }
  | { readonly type: "end-action" }
  | {
      readonly type: "play-reaction-card";
      readonly cardInstanceId: string;
      readonly targetEffectId: EffectId;
    }
  | {
      readonly type: "play-converted-reaction-card";
      readonly cardInstanceId: string;
      readonly equipmentCardInstanceId: string;
      readonly targetEffectId: EffectId;
    }
  | {
      readonly type: "play-skill-converted-reaction-card";
      readonly cardInstanceId: string;
      readonly skillId: string;
      readonly targetEffectId: EffectId;
    }
  | {
      readonly type: "activate-damage-equipment";
      readonly cardInstanceId: string;
      readonly targetEffectId: EffectId;
    }
  | {
      readonly type: "play-rescue-card";
      readonly cardInstanceId: string;
      readonly targetPlayerId: PlayerId;
    }
  | {
      readonly type: "activate-rescue-equipment";
      readonly cardInstanceId: string;
      readonly targetPlayerId: PlayerId;
    }
  | {
      readonly type: "pass-rescue";
      readonly choiceId: ChoiceId;
    }
  | {
      readonly type: "discard-cards";
      readonly cardInstanceIds: readonly string[];
    }
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

export type CommandRejectionReason =
  | "invalid"
  | "forbidden"
  | "stale-version"
  | "expired-window"
  | "stale-sequence"
  | "not-available"
  | "match-finished";

export type ErrorCategory =
  | "invalid"
  | "unauthenticated"
  | "forbidden"
  | "conflict"
  | "expired"
  | "rate-limited"
  | "unavailable"
  | "internal";

export type ClientMessage =
  | {
      readonly type: "authenticate";
      readonly protocolVersion: number;
      readonly matchId: MatchId;
      readonly playerId: PlayerId;
      readonly reconnectToken: string;
      readonly clientInstanceId: string;
    }
  | { readonly type: "command"; readonly envelope: CommandEnvelope }
  | { readonly type: "ping"; readonly nonce: string };

export type ServerMessage =
  | {
      readonly type: "hello";
      readonly protocolVersion: typeof PROTOCOL_VERSION;
      readonly connectionId: ConnectionId;
      readonly heartbeatMs: number;
      readonly authenticationDeadlineMs: number;
    }
  | {
      readonly type: "authenticated";
      readonly matchId: MatchId;
      readonly playerId: PlayerId;
      readonly connectionId: ConnectionId;
    }
  | {
      readonly type: "command-accepted";
      readonly commandId: CommandId;
      readonly version: number;
      readonly duplicate: boolean;
    }
  | {
      readonly type: "command-rejected";
      readonly commandId: CommandId;
      readonly category: ErrorCategory;
      readonly reason: CommandRejectionReason;
      readonly currentVersion: number;
      readonly retryable: boolean;
    }
  | {
      readonly type: "player-view";
      readonly matchId: MatchId;
      readonly version: number;
      readonly view: unknown;
    }
  | { readonly type: "pong"; readonly nonce: string }
  | { readonly type: "server-draining"; readonly retryAfterMs: number }
  | {
      readonly type: "error";
      readonly category: ErrorCategory;
      readonly code: string;
      readonly retryable: boolean;
    };

const identifierSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
} as const;

export const clientMessageSchema = {
  $id: "xiaoyaoyou.client-message.v1",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "protocolVersion",
        "matchId",
        "playerId",
        "reconnectToken",
        "clientInstanceId",
      ],
      properties: {
        type: { const: "authenticate" },
        protocolVersion: { type: "integer", minimum: 1 },
        matchId: identifierSchema,
        playerId: identifierSchema,
        reconnectToken: { type: "string", minLength: 32, maxLength: 256 },
        clientInstanceId: identifierSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "envelope"],
      properties: {
        type: { const: "command" },
        envelope: {
          type: "object",
          additionalProperties: false,
          required: [
            "protocolVersion",
            "commandId",
            "matchId",
            "playerId",
            "clientSequence",
            "expectedVersion",
            "clientIssuedAt",
            "command",
          ],
          properties: {
            protocolVersion: { const: PROTOCOL_VERSION },
            commandId: identifierSchema,
            matchId: identifierSchema,
            playerId: identifierSchema,
            clientSequence: { type: "integer", minimum: 0 },
            expectedVersion: { type: "integer", minimum: 0 },
            clientIssuedAt: { type: "integer", minimum: 0 },
            command: {
              oneOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "heroId"],
                  properties: {
                    type: { const: "choose-hero" },
                    heroId: identifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type"],
                  properties: { type: { const: "reroll-hero" } },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "cardInstanceId", "targetPlayerIds"],
                  properties: {
                    type: { const: "play-card" },
                    cardInstanceId: identifierSchema,
                    targetPlayerIds: {
                      type: "array",
                      maxItems: 6,
                      items: identifierSchema,
                    },
                    mode: { enum: ["primary", "pawn"] },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type"],
                  properties: { type: { const: "end-action" } },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "cardInstanceId", "targetEffectId"],
                  properties: {
                    type: { const: "play-reaction-card" },
                    cardInstanceId: identifierSchema,
                    targetEffectId: identifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "type",
                    "cardInstanceId",
                    "skillId",
                    "targetEffectId",
                  ],
                  properties: {
                    type: { const: "play-skill-converted-reaction-card" },
                    cardInstanceId: identifierSchema,
                    skillId: identifierSchema,
                    targetEffectId: identifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "type",
                    "cardInstanceId",
                    "equipmentCardInstanceId",
                    "targetEffectId",
                  ],
                  properties: {
                    type: { const: "play-converted-reaction-card" },
                    cardInstanceId: identifierSchema,
                    equipmentCardInstanceId: identifierSchema,
                    targetEffectId: identifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "cardInstanceId", "targetEffectId"],
                  properties: {
                    type: { const: "activate-damage-equipment" },
                    cardInstanceId: identifierSchema,
                    targetEffectId: identifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "cardInstanceId", "targetPlayerId"],
                  properties: {
                    type: { const: "play-rescue-card" },
                    cardInstanceId: identifierSchema,
                    targetPlayerId: identifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "cardInstanceId", "targetPlayerId"],
                  properties: {
                    type: { const: "activate-rescue-equipment" },
                    cardInstanceId: identifierSchema,
                    targetPlayerId: identifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "choiceId"],
                  properties: {
                    type: { const: "pass-rescue" },
                    choiceId: identifierSchema,
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "cardInstanceIds"],
                  properties: {
                    type: { const: "discard-cards" },
                    cardInstanceIds: {
                      type: "array",
                      maxItems: 56,
                      items: identifierSchema,
                    },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "choiceId", "selections"],
                  properties: {
                    type: { const: "submit-choice" },
                    choiceId: identifierSchema,
                    selections: {
                      type: "array",
                      maxItems: 128,
                      items: identifierSchema,
                    },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "windowId"],
                  properties: {
                    type: { const: "pass-reaction" },
                    windowId: identifierSchema,
                  },
                },
              ],
            },
          },
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "nonce"],
      properties: {
        type: { const: "ping" },
        nonce: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
  ],
} as const;

const errorCategorySchema = {
  enum: [
    "invalid",
    "unauthenticated",
    "forbidden",
    "conflict",
    "expired",
    "rate-limited",
    "unavailable",
    "internal",
  ],
} as const;

export const serverMessageSchema = {
  $id: "xiaoyaoyou.server-message.v1",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "protocolVersion",
        "connectionId",
        "heartbeatMs",
        "authenticationDeadlineMs",
      ],
      properties: {
        type: { const: "hello" },
        protocolVersion: { const: PROTOCOL_VERSION },
        connectionId: identifierSchema,
        heartbeatMs: { type: "integer", minimum: 1 },
        authenticationDeadlineMs: { type: "integer", minimum: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "matchId", "playerId", "connectionId"],
      properties: {
        type: { const: "authenticated" },
        matchId: identifierSchema,
        playerId: identifierSchema,
        connectionId: identifierSchema,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "commandId", "version", "duplicate"],
      properties: {
        type: { const: "command-accepted" },
        commandId: identifierSchema,
        version: { type: "integer", minimum: 0 },
        duplicate: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "commandId",
        "category",
        "reason",
        "currentVersion",
        "retryable",
      ],
      properties: {
        type: { const: "command-rejected" },
        commandId: identifierSchema,
        category: errorCategorySchema,
        reason: {
          enum: [
            "invalid",
            "forbidden",
            "stale-version",
            "expired-window",
            "stale-sequence",
            "not-available",
            "match-finished",
          ],
        },
        currentVersion: { type: "integer", minimum: 0 },
        retryable: { type: "boolean" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "matchId", "version", "view"],
      properties: {
        type: { const: "player-view" },
        matchId: identifierSchema,
        version: { type: "integer", minimum: 0 },
        view: {},
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "nonce"],
      properties: {
        type: { const: "pong" },
        nonce: { type: "string", minLength: 1, maxLength: 128 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "retryAfterMs"],
      properties: {
        type: { const: "server-draining" },
        retryAfterMs: { type: "integer", minimum: 0 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "category", "code", "retryable"],
      properties: {
        type: { const: "error" },
        category: errorCategorySchema,
        code: identifierSchema,
        retryable: { type: "boolean" },
      },
    },
  ],
} as const;

export interface ValidationResult<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly errors?: readonly ErrorObject[];
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateClientMessageSchema: ValidateFunction<ClientMessage> =
  ajv.compile<ClientMessage>(clientMessageSchema);
const validateServerMessageSchema: ValidateFunction<ServerMessage> =
  ajv.compile<ServerMessage>(serverMessageSchema);

export function validateClientMessage(
  input: unknown,
): ValidationResult<ClientMessage> {
  if (validateClientMessageSchema(input)) {
    return { ok: true, value: input };
  }
  return { ok: false, errors: validateClientMessageSchema.errors ?? [] };
}

export function validateServerMessage(
  input: unknown,
): ValidationResult<ServerMessage> {
  if (validateServerMessageSchema(input)) {
    return { ok: true, value: input };
  }
  return { ok: false, errors: validateServerMessageSchema.errors ?? [] };
}
