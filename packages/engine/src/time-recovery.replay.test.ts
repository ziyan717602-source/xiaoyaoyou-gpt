import { describe, expect, it } from "vitest";
import {
  applyCommand,
  collectSystemDeadlines,
  createSetupMatch,
  migrateMatchState,
  reduceEvent,
  type MatchState,
} from "./index.js";

const players = Array.from({ length: 6 }, (_, index) => ({
  id: `recovery-player-${index + 1}`,
  nickname: `恢复玩家${index + 1}`,
}));

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("M06 restart and replay", () => {
  it("restores an absolute setup deadline and replays one timeout result byte-equivalently", () => {
    const initial = createSetupMatch({
      matchId: "m06-restart",
      rulesetVersion: "standard-fengmingyushi@1",
      seed: "m06-restart-seed",
      openedAt: 10_000,
      players,
    });
    const restored = migrateMatchState(roundTrip(initial));
    expect(restored.setup?.deadlineAt).toBe(25_000);
    const target = collectSystemDeadlines(restored).find(
      (candidate) => candidate.origin === "system-timeout",
    )!;
    const command = {
      origin: "system-timeout" as const,
      commandId: target.id,
      matchId: restored.matchId,
      expectedVersion: restored.version,
      targetId: target.targetId,
      deadlineAt: target.deadlineAt,
    };
    const uninterrupted = applyCommand(initial, command);
    const afterRestart = applyCommand(restored, command);
    expect(afterRestart).toEqual(uninterrupted);
    if (!afterRestart.accepted) throw new Error(afterRestart.reason);

    let replayed: MatchState = roundTrip(initial);
    for (const event of roundTrip(afterRestart.events)) {
      replayed = reduceEvent(replayed, event);
    }
    expect(replayed).toEqual(afterRestart.state);
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(afterRestart.state));
  });
});
