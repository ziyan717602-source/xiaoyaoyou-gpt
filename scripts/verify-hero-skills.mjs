import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const contract = JSON.parse(read("contracts/hero-skills.contract.json"));
const catalog = JSON.parse(read("catalog/catalog.json"));
const plan = JSON.parse(read("content/standard-plan.json"));
const setupSource = read("packages/engine/src/setup.ts");
const setupUnit = read("packages/engine/src/setup.test.ts");
const turnUnit = read("packages/engine/src/turn.test.ts");
const replay = read("packages/engine/src/turn.replay.test.ts");
const damage = read("packages/engine/src/damage-dying.ts");
const damageUnit = read("packages/engine/src/damage-dying.test.ts");
const damageReplay = read("packages/engine/src/damage-dying.replay.test.ts");
const network = read("tests/integration/setup-lifecycle.integration.test.ts");
const damageNetwork = read(
  "tests/integration/damage-dying-lifecycle.integration.test.ts",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const engine = await import(
  pathToFileURL(resolve(root, "packages/engine/dist/setup-content.js")).href
);
const scopedHeroes = catalog.items
  .filter(
    (item) =>
      item.kind === "hero" &&
      (item.packages.includes("standard") ||
        item.packages.includes("fengmingyushi")),
  )
  .sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));
const standardHeroes = scopedHeroes.filter((item) =>
  item.packages.includes("standard"),
);
const fengmingHeroes = scopedHeroes.filter((item) =>
  item.packages.includes("fengmingyushi"),
);
const allEdges = [];
for (const hero of scopedHeroes) {
  const expected = hero.dependencies.contentIds
    .filter((id) => id.startsWith("xyy.skill."))
    .sort();
  const actual = [...engine.skillIdsForHero(hero.canonicalId)].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${hero.canonicalId} skill ownership differs from catalog.`,
  );
  allEdges.push(...actual.map((skillId) => `${hero.canonicalId}:${skillId}`));
}
assert(
  scopedHeroes.length === contract.ownershipGraph.setupHeroes,
  "Setup hero count drifted.",
);
assert(
  standardHeroes.length === contract.ownershipGraph.standardHeroes,
  "Standard hero count drifted.",
);
assert(
  fengmingHeroes.length === contract.ownershipGraph.fengmingyushiHeroes,
  "Fengmingyushi hero count drifted.",
);
assert(
  allEdges.length === contract.ownershipGraph.ownershipEdges,
  "Owned skill edge count drifted.",
);
assert(new Set(allEdges).size === allEdges.length, "Duplicate ownership edge.");
assert(
  new Set(allEdges.map((edge) => edge.slice(edge.indexOf(":") + 1))).size ===
    contract.ownershipGraph.distinctOwnedSkills,
  "Distinct owned skill count drifted.",
);
assert(
  Object.keys(engine.HERO_SKILL_IDS).length === scopedHeroes.length,
  "Runtime ownership graph has missing or extra heroes.",
);

const scopedSkills = catalog.items.filter(
  (item) =>
    item.kind === "skill" &&
    (item.packages.includes("standard") ||
      item.packages.includes("fengmingyushi")),
);
assert(
  scopedSkills.filter((item) => item.packages.includes("standard")).length ===
    contract.ownershipGraph.standardSkills,
  "Standard skill count drifted.",
);
assert(
  scopedSkills.filter((item) => item.packages.includes("fengmingyushi"))
    .length === contract.ownershipGraph.fengmingyushiSkills,
  "Fengmingyushi skill count drifted.",
);
assert(
  engine.handLimitForHero("xyy.hero.xj404") === 5,
  "JN50402 owner limit must be five.",
);
assert(
  engine.handLimitForHero("xyy.hero.xj401") === 3,
  "Ordinary hero limit must remain three.",
);

const skillPlan = plan.items.find((item) => item.id === "xyy.skill.jn50402");
const heroPlan = plan.items.find((item) => item.id === "xyy.hero.xj404");
const immunityPlan = plan.items.find((item) => item.id === "xyy.skill.jn50501");
const immunityHeroPlan = plan.items.find(
  (item) => item.id === "xyy.hero.xj405",
);
assert(skillPlan?.state === "verified", "JN50402 must be verified in plan.");
assert(heroPlan?.state === "partial", "XJ404 must remain partial.");
assert(
  heroPlan?.boundary.includes("JN50402") &&
    heroPlan?.boundary.includes("JN50401"),
  "XJ404 boundary must name completed and pending skills.",
);
assert(immunityPlan?.state === "verified", "JN50501 must be verified in plan.");
assert(immunityHeroPlan?.state === "partial", "XJ405 must remain partial.");
assert(
  immunityHeroPlan?.boundary.includes("JN50501") &&
    immunityHeroPlan?.boundary.includes("JN50502"),
  "XJ405 boundary must name completed and pending skills.",
);
for (const [source, token] of [
  [setupSource, "handLimit: handLimitForHero(heroId)"],
  [setupUnit, "loads the complete hero-skill graph"],
  [turnUnit, "uses 剑匣 limit five"],
  [replay, "replays 剑匣 discard bypass identically"],
  [network, "network-jn50402-end-action"],
  [damage, 'heroHasSkill(target.heroId, "xyy.skill.jn50501")'],
  [damageUnit, "applies JN50501 water/fire immunity"],
  [damageReplay, "resumes JN50501 IMMUNE_INVAO fire damage"],
  [damageNetwork, "network-jn50501-bypass-fire"],
]) {
  assert(
    source.includes(token),
    `Missing JN50402 verification token ${token}.`,
  );
}
for (const path of [
  "docs/content-standard/cs02-hero-skills.md",
  "docs/verification/receipts/cs02-jn50402.md",
  "docs/verification/receipts/cs02-jn50501.md",
]) {
  assert(existsSync(resolve(root, path)), `Missing ${path}.`);
}
assert(
  Object.keys(contract.acceptanceMap).length === 15,
  "Expected 15 CS02 acceptance items.",
);

console.log(
  `hero-skills verified: ${scopedHeroes.length} heroes, ${allEdges.length} ownership edges, JN50402/JN50501 complete`,
);
