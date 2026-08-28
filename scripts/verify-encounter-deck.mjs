import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const contract = JSON.parse(read("contracts/encounter-deck.contract.json"));
const catalog = JSON.parse(read("catalog/catalog.json"));
const plan = JSON.parse(read("content/standard-plan.json"));
const source = read("packages/engine/src/encounter-content.ts");
const state = read("packages/engine/src/index.ts");
const unit = read("packages/engine/src/encounter-deck.test.ts");
const network = read("tests/integration/setup-lifecycle.integration.test.ts");
const decisions = read("docs/rules-semantics/decisions.md");
const gap = read("docs/rules-semantics/cs03-encounter-deck-gap.md");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const scoped = catalog.items.filter((item) =>
  item.packages.includes("standard"),
);
const monsters = scoped.filter((item) => item.kind === "monster");
const npcs = scoped.filter((item) => item.kind === "npc");
const npcActions = scoped.filter((item) => item.kind === "npc-action");

assert(contract.schemaVersion === 1, "Unknown encounter deck contract.");
assert(
  contract.scope === "CONTENT-STANDARD/CS03-BATTLE-DECKS/DECK-SUBSTRATE",
  "Encounter deck scope drifted.",
);
assert(
  monsters.length === contract.catalog.monsters &&
    npcs.length === contract.catalog.npcs &&
    npcActions.length === contract.catalog.npcActions,
  "Encounter catalog counts drifted.",
);
assert(
  contract.partition.mainDeck.monsters === 20 &&
    contract.partition.mainDeck.npcs === 10 &&
    contract.partition.mainDeck.total === 30 &&
    contract.partition.reserveNpcDeck === 16 &&
    contract.partition.allScopedEncounterCardsConserved === 46,
  "Encounter partition drifted.",
);
assert(
  contract.rng.algorithm === "sha256-counter-v1" &&
    contract.rng.deckAlgorithm === "legacy-20-monster-10-npc-reserve-v1" &&
    contract.rng.domainSeparatedFromGameplayRng,
  "Encounter RNG boundary drifted.",
);
assert(
  contract.persistence.matchSchema === 9 &&
    contract.persistence.migratesFrom === 6,
  "Encounter persistence boundary drifted.",
);
assert(
  Object.keys(contract.acceptanceMap).length === 10,
  "Expected ten CS03-01 acceptance items.",
);

for (const token of [
  "export const SETUP_MONSTER_IDS",
  "export const SETUP_NPC_IDS",
  "npcs.values.slice(10)",
  "ENCOUNTER_DECK_ALGORITHM",
  "encounterDeck: encounter.values",
  "reserveNpcDeck: reserve.values",
]) {
  assert(
    source.includes(token),
    "Missing encounter source token " + token + ".",
  );
}
for (const token of [
  "MATCH_SCHEMA_VERSION = 11",
  "upgradeEncounterDecksFromV6",
  "deckCount: state.encounterDeck.length",
]) {
  assert(state.includes(token), "Missing encounter state token " + token + ".");
}
for (const token of [
  "partitions all 20 monsters and 26 NPCs",
  "never exposes unrevealed identities",
  "migrates a v6 snapshot",
]) {
  assert(unit.includes(token), "Missing encounter unit token " + token + ".");
}
assert(
  network.includes("SETUP_MONSTER_IDS") &&
    network.includes("client.latestView.encounter.deckCount === 30"),
  "Six-socket encounter restart/privacy coverage is missing.",
);
assert(
  decisions.includes("SEM-009") &&
    gap.includes("TakeRange(npcLst.ToArray(), 11, npcLst.Count)"),
  "SEM-009 evidence is missing.",
);

const cs03Items = plan.items.filter(
  (item) => item.slice === "CS03-BATTLE-DECKS",
);
assert(cs03Items.length === 55, "Expected 55 CS03 content items.");
assert(
  cs03Items.every((item) => item.state === "unstarted"),
  "Deck substrate must not prematurely verify CS03 content.",
);
for (const path of [
  "docs/content-standard/cs03-encounter-deck.md",
  "docs/verification/receipts/cs03-encounter-deck.md",
]) {
  assert(existsSync(resolve(root, path)), "Missing " + path + ".");
}

console.log(
  "Encounter deck verified: " +
    monsters.length +
    " monsters, 10/" +
    npcs.length +
    " main NPCs, 16 reserve NPCs, schema v" +
    contract.persistence.matchSchema +
    ".",
);
