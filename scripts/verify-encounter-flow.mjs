import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) =>
  JSON.parse(readFileSync(resolve(root, path), "utf8"));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const contract = readJson("contracts/encounter-flow.contract.json");
const plan = readJson("content/standard-plan.json");
const source = read("packages/engine/src/encounter.ts");
const tests = read("packages/engine/src/encounter.test.ts");
const turn = read("packages/engine/src/turn.ts");
const docs = read("docs/content-standard/cs03-encounter-flow.md");
const receipt = read("docs/verification/receipts/cs03-encounter-flow.md");

assert(
  contract.timeouts.actionMs === 15000,
  "Encounter action timeout drifted.",
);
assert(
  contract.timeouts.supportFallback === "give-up" &&
    contract.timeouts.hinderFallback === "pass",
  "Encounter timeout fallbacks drifted.",
);
assert(
  Object.keys(contract.acceptanceMap).length === 12,
  "Expected twelve CS03-02 acceptance items.",
);
for (const token of [
  'stage: "awaiting-support"',
  'stage: "awaiting-hinder"',
  'stage: "ready-reveal"',
  'stage: gaveUp ? "completed" : "revealed"',
  "opposingDecisionPlayerId",
  'participant.kind === "player"',
  "ACTION_DEADLINE_MS",
]) {
  assert(source.includes(token), `Missing encounter flow token ${token}.`);
}
for (const token of [
  "only the active player",
  "corresponding live opponent",
  "pet/special options",
  "after 15 seconds",
  "reveals and discards on give-up",
  "rejects stale, dead, foreign-team, and repeated decisions",
]) {
  assert(tests.includes(token), `Missing encounter test token ${token}.`);
}
assert(
  turn.includes('changePhase(builder, "encounter")') &&
    turn.includes('changePhase(builder, "battle")') &&
    turn.includes('changePhase(builder, "reward")'),
  "CS03-02 must not wire an incomplete encounter into the production turn flow.",
);
assert(
  docs.includes("建议不是规则命令") && receipt.includes("6/6 失败"),
  "Encounter authority or red evidence documentation is missing.",
);
const cs03Items = plan.items.filter(
  (item) => item.slice === "CS03-BATTLE-DECKS",
);
assert(cs03Items.length === 55, "Expected 55 CS03 content items.");
assert(
  cs03Items.every((item) => item.state === "unstarted"),
  "Decision substrate must not prematurely verify CS03 content.",
);

console.log(
  `Encounter flow verified: ${Object.keys(contract.acceptanceMap).length} acceptance items, ` +
    `${contract.timeouts.actionMs} ms, ${cs03Items.length} CS03 items remain unstarted.`,
);
