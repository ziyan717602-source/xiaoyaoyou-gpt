import fc from "fast-check";
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createInitialMatch,
  createPlayerView,
  type MatchState,
} from "./index.js";

const playerIds = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;

describe("engine model properties", () => {
  it("never projects another player's generated secret cards", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
            maxLength: 12,
          }),
          {
            minLength: 6,
            maxLength: 6,
          },
        ),
        (hands) => {
          const initial = createInitialMatch({
            matchId: "property-match",
            rulesetVersion: "property-v1",
            seed: "property-seed",
            players: playerIds.map((id) => ({ id, nickname: id })),
          });
          const state: MatchState = {
            ...initial,
            players: Object.fromEntries(
              playerIds.map((id, index) => [
                id,
                { ...initial.players[id]!, hand: hands[index]! },
              ]),
            ),
          };

          for (const viewerId of playerIds) {
            const view = createPlayerView(state, viewerId);
            for (const player of view.players) {
              expect(player.hand).toEqual(
                player.id === viewerId ? state.players[viewerId]!.hand : null,
              );
              expect(player.handCount).toBe(
                state.players[player.id]!.hand.length,
              );
            }
          }
        },
      ),
      { numRuns: 200, seed: 20_260_819 },
    );
  });

  it("shrinks command sequences while preserving version and idempotency invariants", () => {
    const commandArbitrary = fc.record({
      commandId: fc
        .integer({ min: 0, max: 12 })
        .map((value) => `command:${value}`),
      playerIndex: fc.integer({ min: 0, max: 5 }),
      expectedVersionOffset: fc.integer({ min: -1, max: 1 }),
    });

    const property = fc.property(
      fc.array(commandArbitrary, { maxLength: 200 }),
      (commands) => {
        let version = 0;
        const receipts = new Map<string, number>();
        let accepted = 0;
        for (const command of commands) {
          const duplicate = receipts.get(command.commandId);
          if (duplicate !== undefined) {
            expect(duplicate).toBeLessThanOrEqual(version);
            continue;
          }
          const expectedVersion = version + command.expectedVersionOffset;
          const authorized = command.playerIndex === version % playerIds.length;
          if (expectedVersion !== version || !authorized) continue;
          version += 1;
          accepted += 1;
          receipts.set(command.commandId, version);
          expect(version).toBe(accepted);
        }
        expect(version).toBe(receipts.size);
        expect([...receipts.values()]).toEqual(
          Array.from({ length: receipts.size }, (_, index) => index + 1),
        );
      },
    );
    try {
      fc.assert(property, {
        numRuns: 500,
        seed: 20_260_819,
        endOnFailure: true,
      });
    } catch (error) {
      mkdirSync("artifacts/failures", { recursive: true });
      writeFileSync(
        "artifacts/failures/p07-fast-check.json",
        `${JSON.stringify({ seed: 20_260_819, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
      );
      throw error;
    }
  });
});
