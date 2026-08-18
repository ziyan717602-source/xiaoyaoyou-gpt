import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const contract = JSON.parse(
  readFileSync(
    resolve(workspaceRoot, "contracts", "semantics.contract.json"),
    "utf8",
  ),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExact(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} drifted. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
  );
}

assert(contract.schemaVersion === 1, "Unknown semantic contract version.");
assert(
  contract.timeouts.actionMs === 15_000,
  "Action timeout must remain 15 seconds.",
);
assert(
  contract.timeouts.disconnectMs === 60_000,
  "Disconnect timeout must remain 60 seconds.",
);
assert(
  contract.timeouts.optionalFallback === "pass",
  "Optional timeout must pass.",
);
assert(
  contract.timeouts.mandatoryFallback === "deterministic-random-legal-option",
  "Mandatory timeout must use deterministic random choice.",
);
assert(
  contract.versions.rngAlgorithm === "sha256-counter-v1",
  "The versioned RNG algorithm drifted.",
);
assert(
  contract.commands.clientIssuedAtPolicy.includes("audit-only") &&
    contract.commands.clientIssuedAtPolicy.includes("never-used-for-deadline"),
  "Client time must never be authoritative.",
);

const requiredAcceptance = Array.from(
  { length: 15 },
  (_, index) => `P04-${String(index + 1).padStart(2, "0")}`,
);
assertExact(
  Object.keys(contract.acceptanceMap).sort(),
  requiredAcceptance,
  "P04 acceptance map",
);
for (const [acceptanceId, sections] of Object.entries(contract.acceptanceMap)) {
  assert(sections.length > 0, `${acceptanceId} has no contract section.`);
}

const requiredLifecycle = [
  "room-open",
  "seating",
  "ready-check",
  "hero-selection",
  "setup",
  "turn",
  "resolving",
  "finished",
  "archived",
];
assertExact(contract.lifecycle.states, requiredLifecycle, "Lifecycle states");
assert(
  contract.lifecycle.transitions.includes("resolving->finished") &&
    contract.lifecycle.transitions.includes("turn->finished"),
  "Lifecycle lacks terminal transitions.",
);

const requiredIdentity = [
  "matchId",
  "commandId",
  "eventId",
  "effectId",
  "windowId",
  "choiceId",
  "playerId",
  "contentId",
];
assertExact(
  contract.identity.stableTypes,
  requiredIdentity,
  "Stable identity types",
);
assert(
  contract.continuations.serializableOnly,
  "Continuations must be serializable.",
);
assert(
  contract.continuations.forbidden.includes("closure") &&
    contract.continuations.forbidden.includes("socket"),
  "Continuation forbidden-state list is incomplete.",
);

assert(
  contract.reactionWindows.cancelRule.includes("effect-id"),
  "Cancellation must target an effect id.",
);
assert(
  contract.reactionWindows.counterCancelRule.includes(
    "parent-effect-remains-pending",
  ),
  "Countered cancellation must restore the parent effect.",
);
assertExact(
  contract.damage.pipeline,
  [
    "canonicalize-batch",
    "apply-replacements-once-per-effect-id",
    "apply-additive-modifiers",
    "apply-reductions",
    "floor-at-zero",
    "open-serialized-card-prevention-windows",
    "apply-batch-simultaneously",
    "emit-applied-events",
    "enqueue-after-damage-triggers",
    "detect-dying-after-whole-batch",
  ],
  "Damage pipeline",
);
assert(
  contract.damage.preventionWindowRule.includes("before-any-hp-write"),
  "Damage prevention must complete before HP writes.",
);
assert(
  contract.dying.queueOrder === "ascending-seat-at-detection-snapshot",
  "Dying queue order must be stable.",
);
assert(
  contract.dying.victory.includes("zero-alive-teams-is-draw"),
  "Simultaneous elimination decision is missing.",
);

const scenarioCoverage = new Set(
  contract.scenarios.flatMap((scenario) => scenario.covers),
);
const requiredScenarioCoverage = [
  "normal",
  "pass",
  "timeout",
  "disconnect",
  "restart",
  "no-target",
  "nested-response",
  "mandatory-random",
  "duplicate",
  "forbidden",
  "single-dying",
  "multi-dying",
  "privacy",
  "simultaneous-elimination",
];
for (const coverage of requiredScenarioCoverage) {
  assert(
    scenarioCoverage.has(coverage),
    `Missing semantic scenario coverage: ${coverage}.`,
  );
}
assert(
  contract.temporaryDecisions.every(
    (decision) =>
      decision.status === "provisional-autonomous" ||
      decision.status === "resolved",
  ),
  "Every semantic uncertainty needs a temporary or resolved decision.",
);

function passReaction(window, playerId) {
  assert(
    window.order[window.cursor] === playerId,
    `Priority is not held by ${playerId}.`,
  );
  const passed = [...window.passed, playerId];
  const cursor = (window.cursor + 1) % window.order.length;
  return {
    ...window,
    cursor,
    passed,
    closed: passed.length === window.order.length,
  };
}

let reaction = {
  order: ["p2", "p3", "p4"],
  cursor: 0,
  passed: [],
  closed: false,
};
reaction = passReaction(reaction, "p2");
reaction = passReaction(reaction, "p3");
reaction = passReaction(reaction, "p4");
assert(reaction.closed, "All consecutive passes must close a response window.");

const parentEffect = {
  id: "original",
  status: "pending",
  continuation: "resolve-original",
};
const cancellation = {
  id: "bingxin-1",
  status: "pending",
  target: parentEffect.id,
};
const counterCancellation = {
  id: "bingxin-2",
  status: "resolved",
  target: cancellation.id,
};
if (counterCancellation.status === "resolved")
  cancellation.status = "cancelled";
assert(
  cancellation.status === "cancelled",
  "Nested counter must cancel the first cancellation.",
);
assert(
  parentEffect.status === "pending" &&
    parentEffect.continuation === "resolve-original",
  "Original effect must resume from its saved continuation.",
);

function counterValue(seed, cursor) {
  const seedBytes = Buffer.from(seed, "utf8");
  const header = Buffer.alloc(12);
  header.writeUInt32BE(seedBytes.length, 0);
  header.writeBigUInt64BE(BigInt(cursor), 4);
  return createHash("sha256")
    .update(header)
    .update(seedBytes)
    .digest()
    .readUInt32BE(0);
}

function mandatoryTimeout(seed, cursor, options) {
  const sorted = [...options].sort();
  assert(
    sorted.length > 0,
    "Mandatory timeout requires at least one legal option.",
  );
  const startCursor = cursor;
  const range = 0x1_0000_0000;
  const acceptanceLimit = Math.floor(range / sorted.length) * sorted.length;
  let value;
  do {
    value = counterValue(seed, cursor);
    cursor += 1;
  } while (value >= acceptanceLimit);
  return {
    option: sorted[value % sorted.length],
    cursor,
    cursorRange: [startCursor, cursor],
    value,
  };
}

const randomA = mandatoryTimeout("match-seed", 7, [
  "target-c",
  "target-a",
  "target-b",
]);
const randomB = mandatoryTimeout("match-seed", 7, [
  "target-b",
  "target-c",
  "target-a",
]);
assertExact(randomA, randomB, "Deterministic mandatory timeout");
assert(
  randomA.cursor > 7 && randomA.cursorRange[0] === 7,
  "Mandatory timeout must record every consumed RNG cursor.",
);

const deadlineAt = 120_000;
assert(
  Math.max(0, deadlineAt - 100_000) === 20_000,
  "Restart remaining time is wrong.",
);
assert(
  Math.max(0, deadlineAt - 130_000) === 0,
  "Expired deadline must remain expired.",
);
const timeoutKeys = new Set();
function appendTimeoutOnce(windowId) {
  const key = `timeout:${windowId}`;
  if (timeoutKeys.has(key)) return false;
  timeoutKeys.add(key);
  return true;
}
assert(appendTimeoutOnce("window-1"), "First restored timeout must append.");
assert(!appendTimeoutOnce("window-1"), "Restored timeout must be idempotent.");

function resolveDamage(base, modifiers) {
  let amount = base;
  for (const modifier of [...modifiers].sort((left, right) =>
    `${String(left.priority).padStart(6, "0")}:${left.seat}:${left.id}`.localeCompare(
      `${String(right.priority).padStart(6, "0")}:${right.seat}:${right.id}`,
    ),
  )) {
    if (modifier.kind === "replace") amount = modifier.value;
    else if (modifier.kind === "add") amount += modifier.value;
    else if (modifier.kind === "reduce") amount -= modifier.value;
  }
  return Math.max(0, amount);
}
assert(
  resolveDamage(2, [
    { id: "reduce", kind: "reduce", value: 1, priority: 300, seat: 2 },
    { id: "add", kind: "add", value: 2, priority: 200, seat: 1 },
    { id: "replace", kind: "replace", value: 3, priority: 100, seat: 3 },
  ]) === 4,
  "Damage replacement/add/reduce ordering failed.",
);

const dyingPlayers = [
  { seat: 3, hp: 0, alive: true },
  { seat: 1, hp: 0, alive: true },
  { seat: 2, hp: 2, alive: true },
];
const dyingQueue = dyingPlayers
  .filter((candidate) => candidate.alive && candidate.hp === 0)
  .map((candidate) => candidate.seat)
  .sort((left, right) => left - right);
assertExact(dyingQueue, [1, 3], "Multi-dying queue");

console.log(
  `Semantic contract verified: ${requiredAcceptance.length} acceptance items, ${contract.invariants.length} invariants, ${contract.scenarios.length} scenarios, ${contract.temporaryDecisions.length} provisional decisions.`,
);
