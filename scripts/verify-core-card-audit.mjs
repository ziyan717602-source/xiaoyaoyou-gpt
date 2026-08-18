import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const contract = JSON.parse(read("contracts/core-card-audit.contract.json"));
const plan = JSON.parse(read("content/standard-plan.json"));
const setup = read("packages/engine/src/setup-content.ts");
const reaction = read("packages/engine/src/reaction.ts");
const dying = read("packages/engine/src/damage-dying.ts");
const view = read("packages/engine/src/index.ts");
const reactionTest = read("packages/engine/src/reaction.test.ts");
const replayTest = read("packages/engine/src/reaction.replay.test.ts");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(Object.keys(contract.items).length === 4, "Expected four core cards.");
assert(
  Object.keys(contract.acceptanceMap).length === 12,
  "Expected 12 CS01A acceptance items.",
);
for (const id of Object.keys(contract.items)) {
  const item = plan.items.find((candidate) => candidate.id === id);
  assert(item !== undefined, `Missing planned item ${id}.`);
  assert(item.slice === "CS01A-CORE-CARD-AUDIT", `Wrong slice for ${id}.`);
  assert(item.state === "partial", `${id} must remain partial.`);
}
for (const token of [
  '{ readonly type: "heal-two" }',
  "rescueAction?: RescueCardAction",
  'coreAction: { type: "heal-two" }',
  'rescueAction: { type: "rescue-two" }',
]) {
  assert(setup.includes(token), `Missing multi-mode card boundary ${token}.`);
}
for (const token of [
  '"heal-two"',
  'effect.kind === "card:xyy.card.tp02"',
  "amount !== 2",
  "Math.min(target.maxHp, target.hp + amount)",
]) {
  assert(reaction.includes(token), `Missing TP02 reaction boundary ${token}.`);
}
assert(
  dying.includes('rescueAction?.type !== "rescue-two"'),
  "Rescue validation must use the separate rescue mode.",
);
assert(
  view.includes('definition.coreAction?.type === "heal-two"'),
  "Player view must offer TP02 normal self-heal.",
);
for (const token of ["tp02-foreign-target", "tp02-full-hp", "tp02-bingxin"]) {
  assert(reactionTest.includes(token), `Missing TP02 unit scenario ${token}.`);
}
assert(
  replayTest.includes("replays TP02 normal healing identically"),
  "Missing TP02 JSON replay scenario.",
);
assert(
  read("tests/integration/reaction-lifecycle.integration.test.ts").includes(
    "network-tp02-heal",
  ),
  "Missing TP02 real-network healing scenario.",
);
for (const file of [
  "docs/content-standard/cs01a-core-cards.md",
  "docs/verification/receipts/cs01a-core-card-audit.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing CS01A evidence ${file}.`);
}
for (const command of [
  "core-cards:contract",
  "core-cards:verify",
  "test:core-cards",
]) {
  assert(
    read("package.json").includes(`\"${command}\"`),
    `Missing ${command}.`,
  );
}

console.log(
  `Core-card audit contract passed: ${Object.keys(contract.acceptanceMap).length} acceptance items, ${Object.keys(contract.items).length} partial catalog items.`,
);
