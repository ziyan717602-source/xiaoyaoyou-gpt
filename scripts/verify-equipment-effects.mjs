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
const healing = read("packages/engine/src/healing.ts");
const hpEvolution = read("packages/engine/src/hp-evolution.ts");
const hpEvolutionUnit = read("packages/engine/src/hp-evolution.test.ts");
const damage = read("packages/engine/src/damage-dying.ts");
const reaction = read("packages/engine/src/reaction.ts");
const protocol = read("packages/protocol/src/index.ts");
const healingUnit = read("packages/engine/src/healing.test.ts");
const reactionUnit = read("packages/engine/src/reaction.test.ts");
const dyingUnit = read("packages/engine/src/damage-dying.test.ts");
const reactionReplay = read("packages/engine/src/reaction.replay.test.ts");
const dyingReplay = read("packages/engine/src/damage-dying.replay.test.ts");
const network = read(
  "tests/integration/reaction-lifecycle.integration.test.ts",
);
const dyingNetwork = read(
  "tests/integration/damage-dying-lifecycle.integration.test.ts",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  Object.keys(contract.items).length === 10,
  "Expected ten CS01D equipment cards.",
);
assert(
  Object.keys(contract.acceptanceMap).length === 18,
  "Expected 18 CS01D acceptance items.",
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
for (const token of [
  "export function planCureBatch",
  'cardDefinition(weapon).id === "xyy.card.wq02"',
  'hasHpEvolutionFlag(hpEvoMask, "termin-at")',
  "appliedModifierCardInstanceIds",
]) {
  assert(healing.includes(token), `Missing WQ02 healing boundary ${token}.`);
}
for (const [source, token] of [
  [healingUnit, "applies WQ02 once"],
  [reactionUnit, 'weapon: "xyy.card.wq02@48"'],
  [dyingUnit, 'weapon: "xyy.card.wq02@48"'],
  [reactionReplay, 'weapon: "xyy.card.wq02@48"'],
  [dyingReplay, 'weapon: "xyy.card.wq02@48"'],
  [network, 'weapon: "xyy.card.wq02@48"'],
  [dyingNetwork, 'weapon: "xyy.card.wq02@48"'],
]) {
  assert(source.includes(token), `Missing WQ02 verification token ${token}.`);
}
for (const token of [
  "export type HpEvolutionFlag",
  "canonicalHpEvolutionMask",
  "isCanonicalHpEvolutionMask",
  "hasHpEvolutionFlag",
]) {
  assert(hpEvolution.includes(token), `Missing HP mask boundary ${token}.`);
}
assert(
  hpEvolutionUnit.includes("rejects duplicate flags and noncanonical"),
  "Missing serialized HP-mask validation scenario.",
);
for (const token of [
  'cardDefinition(armor).id === "xyy.card.fj03"',
  'hasHpEvolutionFlag(hpEvoMask, "termin-at")',
  'hasHpEvolutionFlag(hpEvoMask, "decr-inavo")',
  'cardDefinition(armor).id === "xyy.card.fj04"',
  'hasHpEvolutionFlag(hpEvoMask, "from-jp")',
  'hasHpEvolutionFlag(hpEvoMask, "immune-inavo")',
]) {
  assert(damage.includes(token), `Missing FJ03/FJ04 boundary ${token}.`);
}
for (const [source, token] of [
  [dyingUnit, "applies FJ03 reduction and FJ04 FROM_JP immunity"],
  [dyingReplay, 'armor: "xyy.card.fj03@54"'],
  [dyingNetwork, "network-fj04-jp05-immunity"],
]) {
  assert(
    source.includes(token),
    `Missing FJ03/FJ04 verification token ${token}.`,
  );
}
assert(
  protocol.includes('readonly type: "activate-rescue-equipment"'),
  "Missing FJ01 protocol command.",
);
for (const [source, token] of [
  [view, 'type: "activate-rescue-equipment" as const'],
  [damage, 'event.type === "rescue.equipment-activated"'],
  [dyingUnit, "fj01-activate"],
  [dyingReplay, "resumes FJ01 equipment rescue identically"],
  [dyingNetwork, "network-fj01-activate"],
]) {
  assert(source.includes(token), `Missing FJ01 verification token ${token}.`);
}
assert(
  protocol.includes('readonly type: "activate-damage-equipment"'),
  "Missing FJ05 protocol command.",
);
for (const [source, token] of [
  [view, 'type: "activate-damage-equipment" as const'],
  [reaction, 'event.type === "reaction.equipment-activated"'],
  [dyingUnit, "fj05-activate"],
  [dyingReplay, "resumes FJ05 damage equipment activation"],
  [dyingNetwork, "network-fj05-activate"],
]) {
  assert(source.includes(token), `Missing FJ05 verification token ${token}.`);
}
assert(
  protocol.includes('readonly type: "play-converted-reaction-card"'),
  "Missing FJ02 conversion protocol command.",
);
for (const [source, token] of [
  [view, 'type: "play-converted-reaction-card" as const'],
  [reaction, 'event.type === "reaction.card-converted"'],
  [dyingUnit, "fj02-convert-success"],
  [dyingReplay, "resumes an FJ02-converted TP03 child window"],
  [dyingNetwork, "network-fj02-convert"],
]) {
  assert(source.includes(token), `Missing FJ02 verification token ${token}.`);
}
for (const file of [
  "docs/content-standard/cs01d-equipment-effects.md",
  "docs/verification/receipts/cs01d-fj01.md",
  "docs/verification/receipts/cs01d-fj05.md",
  "docs/verification/receipts/cs01d-fj02.md",
  "docs/verification/receipts/cs01d-fj03-fj04.md",
  "docs/verification/receipts/cs01d-wq02.md",
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
  "Equipment contract passed: WQ02/WQ04/FJ01/FJ02/FJ03/FJ04/FJ05 boundaries verified; ten items remain partial for linked effects.",
);
