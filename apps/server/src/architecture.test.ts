import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ActorDrainingError,
  DeadlineScheduler,
  MatchActor,
} from "./match-actor.js";
import { SqliteEventStore } from "./persistence.js";

describe("SQLite event store contract", () => {
  it("commits event, receipt, version, and snapshot atomically", () => {
    const store = new SqliteEventStore(":memory:");
    store.createMatch({
      matchId: "m1",
      rulesetVersion: "rules@1",
      persistenceVersion: 1,
      state: { version: 0 },
      now: 1,
    });
    const input = {
      matchId: "m1",
      commandId: "c1",
      playerId: "p1",
      expectedVersion: 0,
      nextVersion: 1,
      rulesetVersion: "rules@1",
      persistenceVersion: 1,
      events: [
        {
          eventId: "e1",
          sequence: 1,
          type: "test:advanced",
          rulesetVersion: "rules@1",
          payload: { value: 1 },
          causationEventId: null,
        },
      ],
      state: { version: 1 },
      result: { version: 1 },
      snapshotReason: null,
      now: 2,
    };
    expect(store.commitAccepted(input).status).toBe("committed");
    expect(store.commitAccepted(input).status).toBe("duplicate");
    const beforeSnapshot = store.recover<{ version: number }>("m1");
    expect(beforeSnapshot.snapshot.state).toEqual({ version: 0 });
    expect(beforeSnapshot.events).toHaveLength(1);
    expect(beforeSnapshot.events[0]?.eventHash).toMatch(/^[a-f0-9]{64}$/);

    expect(
      store.commitAccepted({
        ...input,
        commandId: "c2",
        expectedVersion: 1,
        nextVersion: 2,
        events: [
          {
            eventId: "e2",
            sequence: 2,
            type: "test:waiting",
            rulesetVersion: "rules@1",
            payload: { value: 2 },
            causationEventId: null,
          },
        ],
        state: { version: 2 },
        result: { version: 2 },
        snapshotReason: "wait-point",
        now: 3,
      }).status,
    ).toBe("committed");
    const recovered = store.recover<{ version: number }>("m1");
    expect(recovered.currentVersion).toBe(2);
    expect(recovered.lastEventSequence).toBe(2);
    expect(recovered.snapshot.state).toEqual({ version: 2 });
    expect(recovered.events).toEqual([]);
    store.close();
  });

  it("rolls back a malformed event sequence without leaving a receipt", () => {
    const store = new SqliteEventStore(":memory:");
    store.createMatch({
      matchId: "m2",
      rulesetVersion: "rules@1",
      persistenceVersion: 1,
      state: { version: 0 },
      now: 1,
    });
    expect(() =>
      store.commitAccepted({
        matchId: "m2",
        commandId: "bad",
        playerId: "p1",
        expectedVersion: 0,
        nextVersion: 1,
        rulesetVersion: "rules@1",
        persistenceVersion: 1,
        events: [
          {
            eventId: "e-bad",
            sequence: 2,
            type: "bad",
            rulesetVersion: "rules@1",
            payload: {},
            causationEventId: null,
          },
        ],
        state: { version: 1 },
        result: { version: 1 },
        snapshotReason: null,
        now: 2,
      }),
    ).toThrow("Expected event sequence 1");
    expect(store.getReceipt("m2", "bad")).toBeNull();
    expect(store.recover("m2").currentVersion).toBe(0);
    store.close();
  });

  it("checks the supplied snapshot hash", () => {
    const store = new SqliteEventStore(":memory:");
    store.createMatch({
      matchId: "m3",
      rulesetVersion: "rules@1",
      persistenceVersion: 1,
      state: { version: 0 },
      now: 1,
    });
    expect(() =>
      store.saveSnapshot({
        matchId: "m3",
        matchVersion: 0,
        eventSequence: 0,
        persistenceVersion: 1,
        rulesetVersion: "rules@1",
        state: { version: 0 },
        stateHash: createHash("sha256").update("wrong").digest("hex"),
        eventHash: "0".repeat(64),
        savedAt: 2,
      }),
    ).toThrow("hash");
    expect(() =>
      store.saveSnapshot({
        matchId: "m3",
        matchVersion: 0,
        eventSequence: 0,
        persistenceVersion: 1,
        rulesetVersion: "rules@1",
        state: { version: 0 },
        stateHash: createHash("sha256")
          .update(JSON.stringify({ version: 0 }))
          .digest("hex"),
        eventHash: "1".repeat(64),
        savedAt: 2,
      }),
    ).toThrow("event hash");
    store.close();
  });

  it("refuses unknown match persistence versions without guessing", () => {
    const store = new SqliteEventStore(":memory:", 1);
    expect(() =>
      store.createMatch({
        matchId: "future",
        rulesetVersion: "rules@2",
        persistenceVersion: 2,
        state: { version: 0 },
        now: 1,
      }),
    ).toThrow("Unsupported match persistence version 2");
    store.close();
  });
});

describe("single-lane match actor", () => {
  it("serializes concurrent commands and drains before final snapshot", async () => {
    const order: number[] = [];
    const snapshots: number[] = [];
    const actor = new MatchActor<number, number, number>({
      initialState: 0,
      process: async (state, command) => {
        await Promise.resolve();
        order.push(command);
        return { state: state + command, result: state + command };
      },
      saveFinalSnapshot: async (state) => {
        snapshots.push(state);
      },
    });
    await expect(
      Promise.all([actor.dispatch(1), actor.dispatch(2)]),
    ).resolves.toEqual([1, 3]);
    await actor.stop();
    expect(order).toEqual([1, 2]);
    expect(snapshots).toEqual([3]);
    await expect(actor.dispatch(3)).rejects.toBeInstanceOf(ActorDrainingError);
  });

  it("restores an expired absolute deadline by enqueueing immediately once", async () => {
    vi.useFakeTimers();
    const commands: string[] = [];
    const scheduler = new DeadlineScheduler<string>(
      async (command) => {
        commands.push(command);
      },
      () => 100,
    );
    scheduler.schedule({
      id: "choice-1",
      deadlineAt: 90,
      command: "timeout-1",
    });
    await vi.runAllTimersAsync();
    expect(commands).toEqual(["timeout-1"]);
    scheduler.close();
    vi.useRealTimers();
  });
});
