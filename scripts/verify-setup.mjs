import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const contract = json("contracts/setup.contract.json");
const catalog = json("catalog/catalog.json");
const content = read("packages/engine/src/setup-content.ts");
const random = read("packages/engine/src/random.ts");
const setup = read("packages/engine/src/setup.ts");
const protocol = read("packages/protocol/src/index.ts");
const roomStore = read("apps/server/src/room-store.ts");
const matchService = read("apps/server/src/match-service.ts");
const rootPackage = json("package.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const catalogHeroes = catalog.items
  .filter((item) => item.kind === "hero")
  .map((item) => item.canonicalId)
  .sort();
const contentHeroes = [
  ...content.matchAll(/id:\s*"(xyy\.hero\.[a-z0-9._-]+)"/gu),
]
  .map((match) => match[1])
  .sort();
assert(
  JSON.stringify(contentHeroes) === JSON.stringify(catalogHeroes),
  "Setup hero content must exactly match the 34 catalog heroes.",
);
const contentCards = [
  ...content.matchAll(/"(xyy\.card\.[a-z0-9._-]+)":\s*\[/gu),
]
  .map((match) => match[1])
  .sort();
const catalogCards = catalog.items
  .filter((item) => item.kind === "card")
  .map((item) => item.canonicalId)
  .sort();
assert(
  JSON.stringify(contentCards) === JSON.stringify(catalogCards),
  "Setup card definitions must exactly match the regular-card catalog.",
);
const physicalCopies = catalog.items
  .filter((item) => item.kind === "card")
  .flatMap((item) => item.legacyIds.physicalCopies)
  .flatMap((copy) => copy.serials);
assert(
  physicalCopies.length === 56,
  "Regular physical deck must contain 56 cards.",
);
assert(
  new Set(physicalCopies).size === 56,
  "Physical card serials must be unique.",
);
assert(contract.heroes.catalogCount === 34, "Hero scope drifted.");
assert(
  contract.heroes.directlySelectableCount === 30,
  "Selectable hero count drifted.",
);
assert(
  contract.cards.remainingDrawPile === 38,
  "Initial deal conservation drifted.",
);
for (const heroId of contract.heroes.nonSelectableForms) {
  const block = content.slice(content.indexOf(`id: "${heroId}"`));
  assert(
    block.slice(0, block.indexOf("},") + 2).includes("selectable: false"),
    `${heroId} must remain a non-directly-selectable form.`,
  );
}
for (const token of [
  "writeUInt32BE(seedBytes.length",
  "writeBigUInt64BE(BigInt(cursor)",
  "candidate < limit",
  "candidate % upperExclusive",
]) {
  assert(random.includes(token), `Missing versioned RNG rule ${token}.`);
}
for (const token of [
  "PLAYER_COUNT = 6",
  "HERO_CHOICES = 3",
  "INITIAL_HAND_SIZE = 3",
  "turnIndex % 2 === 0",
  "setup.hero-rerolled",
  "setup.hero-selected",
  "setup.completed",
]) {
  assert(setup.includes(token), `Missing setup invariant ${token}.`);
}
assert(
  protocol.includes('type: "choose-hero"'),
  "Choose-hero protocol is missing.",
);
assert(protocol.includes('type: "reroll-hero"'), "Reroll protocol is missing.");
assert(
  roomStore.includes("insertPersistedMatch(this.#database"),
  "Room start and match creation must share the room transaction.",
);
for (const token of [
  "new MatchActor",
  "commandHash(command)",
  "commitAccepted",
])
  assert(
    matchService.includes(token),
    `Missing match service control ${token}.`,
  );
for (const file of [
  "packages/engine/src/setup.test.ts",
  "tests/integration/setup-lifecycle.integration.test.ts",
  "docs/setup/m02-seeded-setup.md",
  "docs/verification/receipts/m02-setup-and-teams.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing M02 evidence ${file}.`);
}
for (const command of ["setup:contract", "setup:verify", "test:setup"])
  assert(
    typeof rootPackage.scripts[command] === "string",
    `Missing ${command}.`,
  );

console.log(
  `Setup contract passed: ${Object.keys(contract.acceptanceMap).length} acceptance items, ${contentHeroes.length} heroes, ${physicalCopies.length} cards.`,
);
