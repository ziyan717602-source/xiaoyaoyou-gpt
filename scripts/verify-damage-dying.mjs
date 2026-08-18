import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const contract = json("contracts/damage-dying.contract.json");
const damage = read("packages/engine/src/damage-dying.ts");
const reaction = read("packages/engine/src/reaction.ts");
const view = read("packages/engine/src/index.ts");
const protocol = read("packages/protocol/src/index.ts");
const rootPackage = json("package.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(contract.schemaVersion === 1, "Unknown M05 contract schema.");
assert(contract.scope === "M05-DAMAGE-DYING", "M05 scope drifted.");
assert(contract.damage.card === "xyy.card.jp05", "Damage card drifted.");
assert(contract.damage.amount === 2, "JP05 damage amount drifted.");
assert(contract.rescue.card === "xyy.card.tp02", "Rescue card drifted.");
assert(contract.rescue.heal === 2, "TP02 heal amount drifted.");
assert(contract.rescue.deadlineMs === 15_000, "Rescue deadline drifted.");
assert(contract.persistence.matchSchema === 4, "M05 match schema drifted.");
assert(
  Object.keys(contract.acceptanceMap).length === 14,
  "M05 acceptance map must contain fourteen items.",
);

for (const token of [
  "RESCUE_DEADLINE_MS = 15_000",
  "planDamageBatch",
  "beginDyingBatch",
  "applyPlannedDamage",
  "applyDyingCommand",
  "reduceDyingEvent",
  '"rescue.passed"',
  '"rescue.card-played"',
  '"death.player-died"',
  '"death.after-effects-completed"',
  'reason: "death-cycle"',
]) {
  assert(damage.includes(token), `Missing M05 engine boundary ${token}.`);
}
for (const token of [
  'effect.kind === "card:xyy.card.jp05"',
  "planDamageBatch",
  "applyPlannedDamage",
]) {
  assert(reaction.includes(token), `Missing JP05 reaction boundary ${token}.`);
}
for (const token of [
  "MATCH_SCHEMA_VERSION",
  "DyingBatch",
  "rescueActions",
  'type: "play-rescue-card"',
  'type: "pass-rescue"',
  "dyingBatch: state.dyingBatch",
]) {
  assert(view.includes(token), `Missing M05 player-view boundary ${token}.`);
}
for (const command of contract.commands) {
  assert(
    protocol.includes(`type: "${command}"`),
    `Missing protocol command ${command}.`,
  );
}
for (const file of [
  "packages/engine/src/damage-dying.test.ts",
  "packages/engine/src/damage-dying.replay.test.ts",
  "packages/engine/src/testing/damage-dying-engine.bot.test.ts",
  "tests/integration/damage-dying-lifecycle.integration.test.ts",
  "docs/damage-dying/m05-damage-dying.md",
  "docs/verification/receipts/m05-damage-dying.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing M05 evidence ${file}.`);
}
for (const command of ["damage:contract", "damage:verify", "test:damage"]) {
  assert(
    typeof rootPackage.scripts[command] === "string",
    `Missing ${command}.`,
  );
}

console.log(
  `Damage/dying contract passed: ${Object.keys(contract.acceptanceMap).length} acceptance items, ${contract.damage.amount} damage, ${contract.rescue.heal} heal, schema v${contract.persistence.matchSchema}.`,
);
