import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const contract = JSON.parse(read("contracts/equipment-effects.contract.json"));
const plan = JSON.parse(read("content/standard-plan.json"));
const setup = read("packages/engine/src/setup-content.ts");
const turn = read("packages/engine/src/turn.ts");
const view = read("packages/engine/src/index.ts");
const unit = read("packages/engine/src/turn.test.ts");
const replay = read("packages/engine/src/turn.replay.test.ts");
const network = read(
  "tests/integration/reaction-lifecycle.integration.test.ts",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  Object.keys(contract.items).length === 10,
  "Expected ten CS01D equipment cards.",
);
assert(
  Object.keys(contract.acceptanceMap).length === 14,
  "Expected 14 CS01D acceptance items.",
);
for (const id of Object.keys(contract.items)) {
  const item = plan.items.find((candidate) => candidate.id === id);
  assert(item !== undefined, `Missing planned item ${id}.`);
  assert(item.slice === "CS01D-EQUIPMENT-EFFECTS", `Wrong slice for ${id}.`);
  assert(item.state === "partial", `${id} must remain partial.`);
}
for (const token of [
  '{ readonly type: "pawn-draw-two" }',
  'id: "xyy.card.wq04"',
  'alternateActions: [{ type: "pawn-draw-two" }]',
]) {
  assert(setup.includes(token), `Missing WQ04 definition ${token}.`);
}
for (const token of [
  'sourceZone === "weapon"',
  'pawnAction.type === "pawn-draw-one" ? 1 : 2',
  'builder.append("turn.card-pawned"',
]) {
  assert(turn.includes(token), `Missing WQ04 turn boundary ${token}.`);
}
assert(
  view.includes('action.type === "pawn-draw-two"'),
  "Player view must offer WQ04 pawn from hand/equipment.",
);
for (const token of ["wq04-pawn-hand", "wq04-pawn-equipped"]) {
  assert(unit.includes(token), `Missing WQ04 unit scenario ${token}.`);
}
assert(
  replay.includes("replays WQ04 pawn from an equipped weapon"),
  "Missing WQ04 JSON replay scenario.",
);
assert(
  network.includes("network-wq04-equipped-pawn"),
  "Missing WQ04 real-network scenario.",
);
for (const file of [
  "docs/content-standard/cs01d-equipment-effects.md",
  "docs/verification/receipts/cs01d-wq04.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing CS01D evidence ${file}.`);
}
for (const command of [
  "equipment:contract",
  "equipment:verify",
  "test:equipment",
]) {
  assert(read("package.json").includes(`"${command}"`), `Missing ${command}.`);
}

console.log(
  "Equipment contract passed: WQ04 pawn verified boundary; ten items remain partial for linked effects.",
);
