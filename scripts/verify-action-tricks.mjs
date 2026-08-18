import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const contract = JSON.parse(read("contracts/action-tricks.contract.json"));
const plan = JSON.parse(read("content/standard-plan.json"));
const setup = read("packages/engine/src/setup-content.ts");
const turn = read("packages/engine/src/turn.ts");
const reaction = read("packages/engine/src/reaction.ts");
const view = read("packages/engine/src/index.ts");
const unitTest = read("packages/engine/src/reaction.test.ts");
const replayTest = read("packages/engine/src/reaction.replay.test.ts");
const networkTest = read(
  "tests/integration/reaction-lifecycle.integration.test.ts",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  Object.keys(contract.items).length === 4,
  "Expected four CS01B action tricks.",
);
assert(
  Object.keys(contract.acceptanceMap).length === 12,
  "Expected 12 CS01B acceptance items.",
);
for (const id of Object.keys(contract.items)) {
  const item = plan.items.find((candidate) => candidate.id === id);
  assert(item !== undefined, `Missing planned item ${id}.`);
  assert(item.slice === "CS01B-ACTION-TRICKS", `Wrong slice for ${id}.`);
  const expected =
    id === "xyy.card.jp03"
      ? "verified"
      : id === "xyy.card.jp01" || id === "xyy.card.jp06"
        ? "partial"
        : "unstarted";
  assert(item.state === expected, `${id} must be ${expected}.`);
}
for (const token of [
  'type: "steal-one"',
  'type: "discard-one"',
  'type: "heal-team-one"',
  'type: "pawn-draw-one"',
  'id: "xyy.card.jp03"',
]) {
  assert(setup.includes(token), `Missing JP03 content token ${token}.`);
}
for (const token of [
  'effect.kind === "card:xyy.card.jp01"',
  '"effect.choice-opened"',
  '"effect.choice-resolved"',
  "opaque-hand-slot-",
  "applyPendingChoiceTimeout",
  'effect.kind === "card:xyy.card.jp06"',
  '"equipment:weapon"',
  '"own-hand:"',
]) {
  assert(reaction.includes(token), `Missing JP01 choice boundary ${token}.`);
}
for (const token of [
  'command.mode === "pawn"',
  'builder.append("turn.card-pawned"',
  'appendDraw(builder, envelope.playerId, 1, "card-effect")',
]) {
  assert(turn.includes(token), `Missing JP03 pawn boundary ${token}.`);
}
for (const token of [
  'action?.type !== "heal-team-one"',
  'effect.kind === "card:xyy.card.jp03"',
  "healingItems",
]) {
  assert(reaction.includes(token), `Missing JP03 effect boundary ${token}.`);
}
assert(
  view.includes('definition.coreAction?.type === "heal-team-one"'),
  "Player view must offer the JP03 primary mode.",
);
for (const token of [
  "jp01-self-target",
  "jp01-bingxin",
  "jp01-choice-timeout",
  "jp06-equipment-play",
  "jp06-hand-select",
  "jp06-self-select",
  "jp03-wrong-team",
  "jp03-bingxin",
  "jp03-pawn",
]) {
  assert(unitTest.includes(token), `Missing JP03 unit scenario ${token}.`);
}
assert(
  replayTest.includes("resumes the mixed-zone JP06 choice identically"),
  "Missing JP06 JSON restart scenario.",
);
assert(
  replayTest.includes("resumes the opaque JP01 hand choice identically"),
  "Missing JP01 JSON restart scenario.",
);
assert(
  replayTest.includes("replays JP03 team healing identically"),
  "Missing JP03 JSON restart scenario.",
);
for (const token of [
  "network-jp01-play",
  "network-jp01-select",
  "network-jp03-team-heal",
  "network-jp03-pawn",
  "network-jp06-equipment-select",
  "network-jp06-hand-select",
]) {
  assert(
    networkTest.includes(token),
    `Missing JP03 network scenario ${token}.`,
  );
}
for (const file of [
  "docs/content-standard/cs01b-action-tricks.md",
  "docs/verification/receipts/cs01b-jp01.md",
  "docs/verification/receipts/cs01b-jp03.md",
  "docs/verification/receipts/cs01b-jp06.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing CS01B evidence ${file}.`);
}

console.log(
  "Action-trick contract passed: JP03 verified, JP01/JP06 partial, JP02 pending CS03.",
);
