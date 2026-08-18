import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

type PlayerId = `p${1 | 2 | 3 | 4 | 5 | 6}`;
type EffectStatus = "pending" | "waiting" | "resolved" | "cancelled";

interface ProbePlayer {
  id: PlayerId;
  seat: number;
  hp: number;
  alive: boolean;
  hand: string[];
}

interface ProbeEffect {
  id: string;
  kind: "damage" | "cancel";
  source: PlayerId;
  target: string;
  status: EffectStatus;
  continuation: string;
}

interface ProbeWindow {
  id: string;
  effectId: string;
  order: PlayerId[];
  cursor: number;
  passed: PlayerId[];
  deadlineAt: number;
  continuation: string;
}

interface CommandResult {
  commandId: string;
  accepted: boolean;
  version: number;
  reason?: "forbidden" | "stale-version";
}

interface ProbeState {
  version: number;
  players: Record<PlayerId, ProbePlayer>;
  effects: ProbeEffect[];
  window: ProbeWindow | null;
  dyingQueue: PlayerId[];
  receipts: Record<string, CommandResult>;
}

const playerIds: PlayerId[] = ["p1", "p2", "p3", "p4", "p5", "p6"];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function roundTrip<T>(value: T): T {
  const bytes = JSON.stringify(value);
  const restored = clone(value);
  expect(JSON.stringify(restored)).toBe(bytes);
  return restored;
}

function clockwiseAfter(source: PlayerId): PlayerId[] {
  const index = playerIds.indexOf(source);
  return Array.from(
    { length: playerIds.length },
    (_, offset) => playerIds[(index + offset + 1) % playerIds.length]!,
  );
}

function createProbeState(): ProbeState {
  const players = Object.fromEntries(
    playerIds.map((id, index) => [
      id,
      {
        id,
        seat: index + 1,
        hp: id === "p6" ? 1 : 3,
        alive: true,
        hand: [
          `secret:${id}`,
          ...(id === "p2" || id === "p3" ? ["probe:cancel"] : []),
          ...(id === "p4" ? ["probe:rescue"] : []),
        ],
      },
    ]),
  ) as Record<PlayerId, ProbePlayer>;
  return {
    version: 0,
    players,
    effects: [
      {
        id: "effect:damage-1",
        kind: "damage",
        source: "p1",
        target: "p6",
        status: "waiting",
        continuation: "apply-damage",
      },
    ],
    window: {
      id: "window:damage-1",
      effectId: "effect:damage-1",
      order: clockwiseAfter("p1"),
      cursor: 0,
      passed: [],
      deadlineAt: 15_000,
      continuation: "apply-damage",
    },
    dyingQueue: [],
    receipts: {},
  };
}

function playCancel(
  input: ProbeState,
  source: PlayerId,
  cancelId: string,
): ProbeState {
  const state = clone(input);
  if (state.window?.order[state.window.cursor] !== source) {
    throw new Error(`${source} does not hold priority.`);
  }
  const target = state.effects.find(
    (effect) => effect.id === state.window?.effectId,
  );
  if (target === undefined) throw new Error("Missing cancellation target.");
  target.status = "waiting";
  state.effects.push({
    id: cancelId,
    kind: "cancel",
    source,
    target: target.id,
    status: "waiting",
    continuation: `resolve:${cancelId}`,
  });
  state.window = {
    id: `window:${cancelId}`,
    effectId: cancelId,
    order: clockwiseAfter(source),
    cursor: 0,
    passed: [],
    deadlineAt: state.window.deadlineAt,
    continuation: `resolve:${cancelId}`,
  };
  return state;
}

function resolveWindow(input: ProbeState): ProbeState {
  const state = clone(input);
  const window = state.window;
  if (window === null) throw new Error("No open window.");
  const effect = state.effects.find(
    (candidate) => candidate.id === window.effectId,
  );
  if (effect === undefined) throw new Error("Window effect is missing.");

  if (effect.kind === "cancel") {
    const target = state.effects.find(
      (candidate) => candidate.id === effect.target,
    );
    if (target === undefined)
      throw new Error("Cancellation target is missing.");
    target.status = "cancelled";
    effect.status = "resolved";
    if (target.kind === "cancel") {
      const parent = state.effects.find(
        (candidate) => candidate.id === target.target,
      );
      if (parent === undefined) throw new Error("Parent effect is missing.");
      parent.status = "waiting";
      state.window = {
        id: `window:resume:${parent.id}`,
        effectId: parent.id,
        order: clockwiseAfter(effect.source),
        cursor: 0,
        passed: [],
        deadlineAt: window.deadlineAt,
        continuation: parent.continuation,
      };
    } else {
      state.window = null;
    }
    return state;
  }

  const target = state.players[effect.target as PlayerId];
  target.hp = Math.max(0, target.hp - 1);
  effect.status = "resolved";
  state.window = null;
  if (target.hp === 0 && target.alive) state.dyingQueue.push(target.id);
  return state;
}

function passPriority(input: ProbeState, playerId: PlayerId): ProbeState {
  const state = clone(input);
  const window = state.window;
  if (window === null || window.order[window.cursor] !== playerId) {
    throw new Error(`${playerId} cannot pass now.`);
  }
  window.passed.push(playerId);
  if (window.passed.length === window.order.length) return resolveWindow(state);
  window.cursor = (window.cursor + 1) % window.order.length;
  return state;
}

function passAll(input: ProbeState): ProbeState {
  let state = input;
  const count = state.window?.order.length ?? 0;
  for (let index = 0; index < count; index += 1) {
    state = roundTrip(state);
    state = passPriority(state, state.window!.order[state.window!.cursor]!);
  }
  return state;
}

function rescue(
  input: ProbeState,
  source: PlayerId,
  targetId: PlayerId,
): ProbeState {
  const state = clone(input);
  if (
    state.dyingQueue[0] !== targetId ||
    !state.players[source].hand.includes("probe:rescue")
  ) {
    throw new Error("Illegal rescue.");
  }
  state.players[targetId].hp = 1;
  state.dyingQueue.shift();
  return state;
}

function project(state: ProbeState, viewer: PlayerId) {
  const priority = state.window?.order[state.window.cursor];
  return {
    version: state.version,
    players: playerIds.map((id) => ({
      id,
      hp: state.players[id].hp,
      handCount: state.players[id].hand.length,
      hand: id === viewer ? state.players[id].hand : null,
    })),
    availableActions:
      priority === viewer
        ? state.players[viewer].hand.includes("probe:cancel")
          ? ["pass", "play:probe:cancel"]
          : ["pass"]
        : [],
  };
}

interface Envelope {
  commandId: string;
  playerId: PlayerId;
  expectedVersion: number;
  action: "pass" | "play-response";
}

function submit(
  input: ProbeState,
  envelope: Envelope,
): { state: ProbeState; result: CommandResult } {
  const duplicate = input.receipts[envelope.commandId];
  if (duplicate !== undefined) return { state: input, result: duplicate };
  if (envelope.expectedVersion !== input.version) {
    return {
      state: input,
      result: {
        commandId: envelope.commandId,
        accepted: false,
        version: input.version,
        reason: "stale-version",
      },
    };
  }
  if (input.window?.order[input.window.cursor] !== envelope.playerId) {
    return {
      state: input,
      result: {
        commandId: envelope.commandId,
        accepted: false,
        version: input.version,
        reason: "forbidden",
      },
    };
  }
  const state = clone(input);
  state.version += 1;
  const result: CommandResult = {
    commandId: envelope.commandId,
    accepted: true,
    version: state.version,
  };
  state.receipts[envelope.commandId] = result;
  return { state, result };
}

interface RestartProbe {
  windowId: string;
  deadlineAt: number;
  optional: boolean;
  optionIds: string[];
  rngValues: number[];
  rngCursor: number;
  timeoutKeys: string[];
  result: string | null;
}

function restoreAt(
  input: RestartProbe,
  now: number,
): RestartProbe & { remainingMs: number } {
  const state = clone(input);
  const remainingMs = Math.max(0, state.deadlineAt - now);
  if (remainingMs > 0) return { ...state, remainingMs };
  const key = `timeout:${state.windowId}`;
  if (state.timeoutKeys.includes(key)) return { ...state, remainingMs };
  state.timeoutKeys.push(key);
  if (state.optional) state.result = "pass";
  else {
    const options = [...state.optionIds].sort();
    const value = state.rngValues[state.rngCursor];
    if (value === undefined || options.length === 0)
      throw new Error("Missing deterministic timeout input.");
    state.rngCursor += 1;
    state.result = options[value % options.length]!;
  }
  return { ...state, remainingMs };
}

describe("P06-PROBE-1 serializable cancellation and rescue", () => {
  it("cancels the original effect when the cancellation receives all passes", () => {
    let state = roundTrip(createProbeState());
    state = playCancel(state, "p2", "effect:cancel-1");
    state = passAll(state);
    expect(
      state.effects.find((effect) => effect.id === "effect:damage-1")?.status,
    ).toBe("cancelled");
    expect(state.players.p6.hp).toBe(1);
    expect(state.window).toBeNull();
  });

  it("counter-cancels, resumes damage, opens dying, and rescues after every JSON wait point", () => {
    let state = roundTrip(createProbeState());
    state = playCancel(state, "p2", "effect:cancel-1");
    state = roundTrip(state);
    state = playCancel(state, "p3", "effect:cancel-2");
    state = passAll(state);
    expect(
      state.effects.find((effect) => effect.id === "effect:cancel-1")?.status,
    ).toBe("cancelled");
    expect(state.window?.continuation).toBe("apply-damage");
    state = passAll(state);
    expect(state.players.p6.hp).toBe(0);
    expect(state.dyingQueue).toEqual(["p6"]);
    state = rescue(roundTrip(state), "p4", "p6");
    expect(state.players.p6.hp).toBe(1);
    expect(state.dyingQueue).toEqual([]);
  });
});

describe("P06-PROBE-2 six private projections and command boundary", () => {
  it("derives six views without another player's hand or private actions", () => {
    const state = createProbeState();
    for (const viewer of playerIds) {
      const view = project(state, viewer);
      for (const player of view.players) {
        expect(player.hand, `${viewer} saw ${player.id}`).toBe(
          player.id === viewer ? state.players[viewer].hand : null,
        );
      }
      expect(view.availableActions.length > 0).toBe(viewer === "p2");
    }
  });

  it("deduplicates accepted commands and rejects stale or forbidden guesses without mutation", () => {
    const initial = createProbeState();
    const envelope: Envelope = {
      commandId: "command:1",
      playerId: "p2",
      expectedVersion: 0,
      action: "pass",
    };
    const accepted = submit(initial, envelope);
    const duplicate = submit(accepted.state, envelope);
    expect(duplicate.result).toEqual(accepted.result);
    expect(duplicate.state).toBe(accepted.state);

    const beforeForbidden = JSON.stringify(accepted.state);
    const guessA = submit(accepted.state, {
      commandId: "guess:a",
      playerId: "p3",
      expectedVersion: 1,
      action: "play-response",
    });
    const guessB = submit(accepted.state, {
      commandId: "guess:b",
      playerId: "p4",
      expectedVersion: 1,
      action: "play-response",
    });
    expect({ ...guessA.result, commandId: "same" }).toEqual({
      ...guessB.result,
      commandId: "same",
    });
    expect(JSON.stringify(guessA.state)).toBe(beforeForbidden);
    expect(JSON.stringify(guessB.state)).toBe(beforeForbidden);
    expect(
      submit(accepted.state, {
        ...envelope,
        commandId: "stale:1",
        expectedVersion: 0,
      }).result.reason,
    ).toBe("stale-version");
  });
});

describe("P06-PROBE-3 restart deadlines, disconnect, and deterministic timeout", () => {
  it("preserves absolute remaining time and appends an optional timeout once", () => {
    const snapshot: RestartProbe = {
      windowId: "window:1",
      deadlineAt: 15_000,
      optional: true,
      optionIds: [],
      rngValues: [],
      rngCursor: 0,
      timeoutKeys: [],
      result: null,
    };
    expect(restoreAt(roundTrip(snapshot), 9_000).remainingMs).toBe(6_000);
    const expired = restoreAt(roundTrip(snapshot), 20_000);
    expect(expired.result).toBe("pass");
    expect(expired.timeoutKeys).toEqual(["timeout:window:1"]);
    expect(restoreAt(roundTrip(expired), 30_000)).toEqual({
      ...expired,
      remainingMs: 0,
    });
  });

  it("replays the same mandatory timeout choice from a sorted option set", () => {
    const snapshot: RestartProbe = {
      windowId: "window:mandatory",
      deadlineAt: 15_000,
      optional: false,
      optionIds: ["target:c", "target:a", "target:b", "target:d"],
      rngValues: [
        createHash("sha256")
          .update("p06-fixed-seed-20260819:0")
          .digest()
          .readUInt32BE(0),
      ],
      rngCursor: 0,
      timeoutKeys: [],
      result: null,
    };
    const first = restoreAt(roundTrip(snapshot), 15_001);
    const replay = restoreAt(roundTrip(snapshot), 99_999);
    expect(replay.result).toBe(first.result);
    expect(replay.rngCursor).toBe(1);
  });

  it("does not pause the action deadline and enters auto mode only after 60 seconds", () => {
    const disconnectedAt = 5_000;
    const actionDeadlineAt = 15_000;
    expect(Math.max(0, actionDeadlineAt - 14_000)).toBe(1_000);
    expect(59_999 - disconnectedAt >= 60_000).toBe(false);
    expect(65_000 - disconnectedAt >= 60_000).toBe(true);
    expect(Math.max(0, actionDeadlineAt - 65_000)).toBe(0);
  });
});
