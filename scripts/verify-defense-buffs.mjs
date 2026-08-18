import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const contract = JSON.parse(read("contracts/defense-buffs.contract.json"));
const plan = JSON.parse(read("content/standard-plan.json"));
const setup = read("packages/engine/src/setup-content.ts");
const damage = read("packages/engine/src/damage-dying.ts");
const reaction = read("packages/engine/src/reaction.ts");
const view = read("packages/engine/src/index.ts");
const unit = read("packages/engine/src/damage-dying.test.ts");
const replay = read("packages/engine/src/damage-dying.replay.test.ts");
const network = read(
  "tests/integration/reaction-lifecycle.integration.test.ts",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  Object.keys(contract.items).length === 6,
  "Expected six CS01C defense/buff cards.",
);
assert(
  Object.keys(contract.acceptanceMap).length === 12,
  "Expected 12 CS01C acceptance items.",
);
for (const id of Object.keys(contract.items)) {
  const item = plan.items.find((candidate) => candidate.id === id);
  assert(item !== undefined, `Missing planned item ${id}.`);
  assert(item.slice === "CS01C-DEFENSE-AND-BUFFS", `Wrong slice for ${id}.`);
  assert(
    item.state === (id === "xyy.card.tp03" ? "partial" : "unstarted"),
    `${id} has an invalid content state.`,
  );
}
for (const token of [
  '{ readonly type: "prevent-damage" }',
  'id: "xyy.card.tp03"',
  'coreAction: { type: "prevent-damage" }',
]) {
  assert(setup.includes(token), `Missing TP03 definition ${token}.`);
}
for (const token of [
  'readonly hpEvoMask?: "normal" | "tux-inavo"',
  'hpEvoMask: intent.hpEvoMask ?? "normal"',
]) {
  assert(damage.includes(token), `Missing damage-mask boundary ${token}.`);
}
for (const token of [
  'kind: "damage-batch"',
  "beginDamageResponse",
  'effect.kind === "card:xyy.card.tp03"',
  'target.kind === "card:xyy.card.tp03"',
  "advanceInterruptedWindow",
  "preventedItemIds",
]) {
  assert(reaction.includes(token), `Missing TP03 stack boundary ${token}.`);
}
assert(
  view.includes('targetEffect?.kind === "damage-batch"'),
  "Player projection must scope TP03 to damage windows.",
);
for (const token of [
  "tp03-protect-card",
  "tp03-bingxin",
  "tp03-damage-timeout",
  "inclination-damage",
  "multi-normal-two",
]) {
  assert(unit.includes(token), `Missing TP03 unit scenario ${token}.`);
}
assert(
  replay.includes("resumes TP03 prevention identically"),
  "Missing TP03 JSON restart scenario.",
);
for (const token of [
  "network-tp03-jp05",
  "network-tp03-prevent",
  "network-tp03-child-pass",
]) {
  assert(network.includes(token), `Missing TP03 network scenario ${token}.`);
}
for (const file of [
  "docs/content-standard/cs01c-defense-buffs.md",
  "docs/verification/receipts/cs01c-tp03.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing CS01C evidence ${file}.`);
}
for (const command of [
  "defense-buffs:contract",
  "defense-buffs:verify",
  "test:defense-buffs",
]) {
  assert(read("package.json").includes(`"${command}"`), `Missing ${command}.`);
}

console.log(
  "Defense/buff contract passed: TP03 ordinary damage boundary partial; five cross-slice cards remain unstarted.",
);
