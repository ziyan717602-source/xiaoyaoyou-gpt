import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const contract = json("contracts/reaction-core.contract.json");
const reaction = read("packages/engine/src/reaction.ts");
const view = read("packages/engine/src/index.ts");
const protocol = read("packages/protocol/src/index.ts");
const matchService = read("apps/server/src/match-service.ts");
const rootPackage = json("package.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(contract.schemaVersion === 1, "Unknown M04 contract schema.");
assert(contract.scope === "M04-REACTION-CORE", "M04 scope drifted.");
assert(contract.window.deadlineMs === 15_000, "Reaction deadline drifted.");
assert(
  contract.window.deadlineSource === "authoritative-server-received-time",
  "Reaction deadline authority drifted.",
);
assert(contract.bingxin.card === "xyy.card.tp01", "Bingxin card drifted.");
assert(
  contract.m04CancellableAction.card === "xyy.card.jp04",
  "M04 cancellable action drifted.",
);
assert(
  Object.keys(contract.acceptanceMap).length === 12,
  "M04 acceptance map must contain twelve items.",
);

for (const token of [
  "REACTION_DEADLINE_MS = 15_000",
  '"effect.started"',
  '"reaction.card-played"',
  '"reaction.passed"',
  '"effect.resolved"',
  "beginCancellableCardEffect",
  "applyReactionCommand",
  "pruneTerminalTail",
  "parentWindow",
  ': "cancel-effect"',
]) {
  assert(reaction.includes(token), `Missing M04 engine boundary ${token}.`);
}
for (const token of [
  "reactionActions",
  "ReactionWindowView",
  "priorityPlayerId",
  'type: "play-reaction-card"',
  'type: "pass-reaction"',
]) {
  assert(view.includes(token), `Missing M04 player-view boundary ${token}.`);
}
for (const command of contract.commands) {
  assert(
    protocol.includes(`type: "${command}"`),
    `Missing protocol command ${command}.`,
  );
}
assert(
  matchService.includes("serverReceivedAt: this.#now()"),
  "MatchService must stamp authoritative server receive time.",
);
for (const file of [
  "packages/engine/src/reaction.test.ts",
  "packages/engine/src/reaction.replay.test.ts",
  "packages/engine/src/testing/turn-engine.bot.test.ts",
  "tests/integration/reaction-lifecycle.integration.test.ts",
  "docs/reaction-core/m04-reaction-core.md",
  "docs/verification/receipts/m04-reaction-core.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing M04 evidence ${file}.`);
}
for (const command of [
  "reaction:contract",
  "reaction:verify",
  "test:reaction",
]) {
  assert(
    typeof rootPackage.scripts[command] === "string",
    `Missing ${command}.`,
  );
}

console.log(
  `Reaction-core contract passed: ${Object.keys(contract.acceptanceMap).length} acceptance items, ${contract.window.deadlineMs} ms deadline, ${contract.commands.length} commands.`,
);
