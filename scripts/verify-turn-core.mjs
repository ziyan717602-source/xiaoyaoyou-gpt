import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const contract = json("contracts/turn-core.contract.json");
const engine = read("packages/engine/src/turn.ts");
const cardZones = read("packages/engine/src/card-zones.ts");
const view = read("packages/engine/src/index.ts");
const content = read("packages/engine/src/setup-content.ts");
const protocol = read("packages/protocol/src/index.ts");
const matchService = read("apps/server/src/match-service.ts");
const rootPackage = json("package.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(contract.schemaVersion === 1, "Unknown M03 contract schema.");
assert(contract.players === 6, "M03 must remain exactly six-player.");
assert(
  JSON.stringify(contract.phases) ===
    JSON.stringify([
      "turn-start",
      "event",
      "action",
      "encounter",
      "battle",
      "reward",
      "discard",
      "turn-end",
    ]),
  "M03 phase graph drifted.",
);
assert(contract.cards.physicalInstances === 56, "Card scope drifted.");
assert(contract.turn.handLimit === 3, "Default hand limit drifted.");
assert(contract.turn.noBattleRewardDraw === 1, "No-battle draw drifted.");
assert(contract.replay.matchSchema === 3, "M03 match schema drifted.");
assert(
  Object.keys(contract.acceptanceMap).length === 10,
  "M03 acceptance map must contain ten items.",
);

for (const token of [
  "turn.phase-changed",
  "turn.card-played",
  "turn.cards-drawn",
  "turn.cards-discarded",
  "turn.advanced",
  "match.finished",
  "nextAlivePlayer",
]) {
  assert(engine.includes(token), `Missing M03 engine boundary ${token}.`);
}
assert(
  cardZones.includes("planDraw"),
  "Missing shared deterministic draw planner.",
);
for (const token of [
  "turnActions",
  "cardDefinition",
  "handLimit",
  "equipment",
]) {
  assert(view.includes(token), `Missing player-view boundary ${token}.`);
}
for (const token of [
  'id: "xyy.card.jp04"',
  'type: "draw-two"',
  'slot: "weapon"',
  'slot: "armor"',
]) {
  assert(content.includes(token), `Missing scoped core card rule ${token}.`);
}
for (const command of contract.commands) {
  assert(
    protocol.includes(`type: "${command}"`),
    `Missing protocol command ${command}.`,
  );
}
assert(
  view.includes("migrateMatchState") &&
    matchService.includes("migrateMatchState"),
  "M03 requires an explicit v2-to-v3 recovery migration.",
);
for (const file of [
  "packages/engine/src/turn.test.ts",
  "packages/engine/src/turn.replay.test.ts",
  "packages/engine/src/testing/turn-engine.bot.test.ts",
  "tests/integration/setup-lifecycle.integration.test.ts",
  "docs/turn-core/m03-turn-core.md",
  "docs/verification/receipts/m03-turn-core.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing M03 evidence ${file}.`);
}
for (const command of ["turn:contract", "turn:verify", "test:turn"]) {
  assert(
    typeof rootPackage.scripts[command] === "string",
    `Missing ${command}.`,
  );
}

console.log(
  `Turn-core contract passed: ${Object.keys(contract.acceptanceMap).length} acceptance items, ${contract.phases.length} phases, ${contract.cards.physicalInstances} cards.`,
);
