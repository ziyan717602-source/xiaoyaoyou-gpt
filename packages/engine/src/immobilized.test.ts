import { describe, expect, it } from "vitest";
import {
  applyCommand,
  collectSystemDeadlines,
  migrateMatchState,
  reduceEvent,
  type MatchState,
} from "./index.js";
import {
  inspectionFixture,
  inspectionCommand,
} from "./testing/inspection-fixture.js";

function fixture(excess: boolean) {
  let s = inspectionFixture("gs01-immobilized");
  const nextId = s.turnOrder[1]!;
  const cards = excess
    ? s.drawPile.slice(0, s.players[nextId]!.handLimit + 2)
    : [];
  s = {
    ...s,
    drawPile: s.drawPile.filter((c) => !cards.includes(c)),
    players: {
      ...s.players,
      [nextId]: {
        ...s.players[nextId]!,
        immobilized: true,
        hand: [...s.players[nextId]!.hand, ...cards],
      },
    },
  };
  return { s, nextId };
}
function checked(s: MatchState, result: ReturnType<typeof applyCommand>) {
  if (!result.accepted) throw new Error(result.reason);
  expect(result.events.reduce(reduceEvent, s)).toEqual(result.state);
  return migrateMatchState(JSON.parse(JSON.stringify(result.state)));
}
describe("GS01 immobilized turn lifecycle", () => {
  it("rejects a forged skip marker in an ordinary action-phase snapshot", () => {
    const { s } = fixture(false);
    const raw = JSON.parse(JSON.stringify(s));
    raw.turn.skippedByImmobilization = true;
    expect(() => migrateMatchState(raw)).toThrow();
  });
  it("skips event, action, encounter, reward and TM, clears once and advances to the next living seat", () => {
    const { s, nextId } = fixture(false);
    const result = applyCommand(
      s,
      inspectionCommand(s, s.activePlayerId!, { type: "end-action" }, 1000),
    );
    const next = checked(s, result);
    expect(next.activePlayerId).toBe(s.turnOrder[2]);
    expect(next.players[nextId]!.immobilized).toBe(false);
    expect(next.players[nextId]!.hand).toEqual(s.players[nextId]!.hand);
    expect(next.turn!.number).toBe(s.turn!.number + 2);
    if (!result.accepted) throw new Error("unreachable");
    expect(
      result.events.filter(
        (e) =>
          e.type === "turn.hero-skill-triggered" &&
          e.payload.playerId === nextId,
      ),
    ).toHaveLength(0);
  });
  it("retains the skipped turn across JSON until discard-to-limit times out, without drawing a reward", () => {
    const { s, nextId } = fixture(true);
    const next = checked(
      s,
      applyCommand(
        s,
        inspectionCommand(s, s.activePlayerId!, { type: "end-action" }, 1000),
      ),
    );
    expect(next.activePlayerId).toBe(nextId);
    expect(next.turn!.phase).toBe("discard");
    expect(next.players[nextId]!.immobilized).toBe(true);
    expect(next.players[nextId]!.hand).toEqual(s.players[nextId]!.hand);
    const deadline = collectSystemDeadlines(next).find((x) =>
      x.targetId.startsWith("turn:"),
    )!;
    expect(deadline.deadlineAt).toBe(16000);
    const done = checked(
      next,
      applyCommand(next, {
        origin: "system-timeout",
        matchId: next.matchId,
        expectedVersion: next.version,
        commandId: "skip-discard-timeout",
        targetId: deadline.targetId,
        deadlineAt: deadline.deadlineAt,
      }),
    );
    expect(done.activePlayerId).toBe(s.turnOrder[2]);
    expect(done.players[nextId]!.hand).toHaveLength(
      s.players[nextId]!.handLimit,
    );
    expect(done.players[nextId]!.immobilized).toBe(false);
  });
});
