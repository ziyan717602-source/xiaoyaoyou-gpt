import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  validateClientMessage,
  validateServerMessage,
} from "./index.js";

describe("protocol runtime schema", () => {
  it("accepts an authentication envelope and rejects unknown fields", () => {
    const valid = {
      type: "authenticate",
      protocolVersion: PROTOCOL_VERSION,
      matchId: "match-1",
      playerId: "player-1",
      reconnectToken: "t".repeat(32),
      clientInstanceId: "browser-1",
    };
    expect(validateClientMessage(valid).ok).toBe(true);
    expect(validateClientMessage({ ...valid, leaked: true }).ok).toBe(false);
  });

  it("bounds messages and validates command discriminators", () => {
    expect(
      validateClientMessage({
        type: "command",
        envelope: {
          protocolVersion: PROTOCOL_VERSION,
          commandId: "command-1",
          matchId: "match-1",
          playerId: "player-1",
          clientSequence: 1,
          expectedVersion: 0,
          clientIssuedAt: 1,
          command: {
            type: "submit-choice",
            choiceId: "choice-1",
            selections: ["option-1"],
          },
        },
      }).ok,
    ).toBe(true);
    for (const command of [
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp04@7",
        targetPlayerIds: ["player-2"],
      },
      {
        type: "play-card",
        cardInstanceId: "xyy.card.jp03@5",
        targetPlayerIds: [],
        mode: "pawn",
      },
      { type: "end-action" },
      {
        type: "play-reaction-card",
        cardInstanceId: "xyy.card.tp01@33",
        targetEffectId: "effect-1",
      },
      {
        type: "play-converted-reaction-card",
        cardInstanceId: "xyy.card.jp01@1",
        equipmentCardInstanceId: "xyy.card.fj02@53",
        targetEffectId: "effect-1",
      },
      {
        type: "play-skill-converted-reaction-card",
        cardInstanceId: "xyy.card.tp02@36",
        skillId: "xyy.skill.jn20202",
        targetEffectId: "effect-1",
      },
      {
        type: "activate-damage-equipment",
        cardInstanceId: "xyy.card.fj05@56",
        targetEffectId: "effect-1",
      },
      {
        type: "play-rescue-card",
        cardInstanceId: "xyy.card.tp02@36",
        targetPlayerId: "player-2",
      },
      {
        type: "activate-rescue-equipment",
        cardInstanceId: "xyy.card.fj01@52",
        targetPlayerId: "player-1",
      },
      { type: "pass-rescue", choiceId: "choice-1" },
      {
        type: "discard-cards",
        cardInstanceIds: ["xyy.card.jp01@1"],
      },
    ]) {
      expect(
        validateClientMessage({
          type: "command",
          envelope: {
            protocolVersion: PROTOCOL_VERSION,
            commandId: `command-${command.type}`,
            matchId: "match-1",
            playerId: "player-1",
            clientSequence: 1,
            expectedVersion: 0,
            clientIssuedAt: 1,
            command,
          },
        }).ok,
      ).toBe(true);
    }
    expect(
      validateClientMessage({ type: "ping", nonce: "x".repeat(129) }).ok,
    ).toBe(false);
  });

  it("validates server envelopes with closed object shapes", () => {
    const hello = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      connectionId: "connection-1",
      heartbeatMs: 25_000,
      authenticationDeadlineMs: 5_000,
    };
    expect(validateServerMessage(hello).ok).toBe(true);
    expect(validateServerMessage({ ...hello, reconnectToken: "leak" }).ok).toBe(
      false,
    );
  });
});
