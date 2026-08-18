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
const turn = read("packages/engine/src/turn.ts");
const replay = read("packages/engine/src/turn.replay.test.ts");
const damage = read("packages/engine/src/damage-dying.ts");
const damageUnit = read("packages/engine/src/damage-dying.test.ts");
const damageReplay = read("packages/engine/src/damage-dying.replay.test.ts");
const protocol = read("packages/protocol/src/index.ts");
const view = read("packages/engine/src/index.ts");
const reaction = read("packages/engine/src/reaction.ts");
const reactionUnit = read("packages/engine/src/reaction.test.ts");
const reactionReplay = read("packages/engine/src/reaction.replay.test.ts");
const network = read("tests/integration/setup-lifecycle.integration.test.ts");
const damageNetwork = read(
  "tests/integration/damage-dying-lifecycle.integration.test.ts",
);
const reactionNetwork = read(
  "tests/integration/reaction-lifecycle.integration.test.ts",
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
const refusalPlan = plan.items.find((item) => item.id === "xyy.skill.jn20202");
const refusalHeroPlan = plan.items.find((item) => item.id === "xyy.hero.xj202");
const cookingPlan = plan.items.find((item) => item.id === "xyy.skill.jn40301");
const cookingHeroPlan = plan.items.find((item) => item.id === "xyy.hero.x3w03");
const healingSkillPlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn20302",
);
const healingHeroPlan = plan.items.find((item) => item.id === "xyy.hero.xj203");
const selfHealingPlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn40401",
);
const selfHealingHeroPlan = plan.items.find(
  (item) => item.id === "xyy.hero.x3w04",
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
assert(refusalPlan?.state === "verified", "JN20202 must be verified in plan.");
assert(refusalHeroPlan?.state === "partial", "XJ202 must remain partial.");
assert(
  refusalHeroPlan?.boundary.includes("JN20202") &&
    refusalHeroPlan?.boundary.includes("JN20201"),
  "XJ202 boundary must name completed and pending skills.",
);
assert(cookingPlan?.state === "verified", "JN40301 must be verified in plan.");
assert(cookingHeroPlan?.state === "partial", "X3W03 must remain partial.");
assert(
  cookingHeroPlan?.boundary.includes("JN40301") &&
    cookingHeroPlan?.boundary.includes("JN40302"),
  "X3W03 boundary must name completed and pending skills.",
);
assert(
  healingSkillPlan?.state === "verified",
  "JN20302 must be verified in plan.",
);
assert(healingHeroPlan?.state === "partial", "XJ203 must remain partial.");
assert(
  healingHeroPlan?.boundary.includes("JN20302") &&
    healingHeroPlan?.boundary.includes("JN20301"),
  "XJ203 boundary must name completed and pending skills.",
);
assert(
  selfHealingPlan?.state === "verified",
  "JN40401 must be verified in plan.",
);
assert(selfHealingHeroPlan?.state === "partial", "X3W04 must remain partial.");
assert(
  selfHealingHeroPlan?.boundary.includes("JN40401") &&
    selfHealingHeroPlan?.boundary.includes("JN40402") &&
    selfHealingHeroPlan?.boundary.includes("JN40403"),
  "X3W04 boundary must name completed and pending skills.",
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
  [protocol, 'readonly type: "play-skill-converted-reaction-card"'],
  [view, 'skillId: "xyy.skill.jn20202" as const'],
  [reaction, 'builder.append("reaction.skill-card-converted"'],
  [reactionUnit, "uses JN20202 to pay a special card"],
  [reactionReplay, "replays a JN20202 special-card conversion"],
  [reactionNetwork, 'skillId: "xyy.skill.jn20202"'],
  [protocol, 'readonly type: "play-skill-converted-card"'],
  [view, "requiredCardCount: 2 as const"],
  [turn, "beginSkillConvertedCardEffect"],
  [reaction, 'builder.append("effect.skill-card-converted"'],
  [turnUnit, "uses JN40301 to pay two hand cards"],
  [reactionReplay, "replays a JN40301 two-card TP02 conversion"],
  [damage, 'builder.append("rescue.skill-card-converted"'],
  [damageUnit, "lets JN40301 pay two hand cards as TP02 during rescue"],
  [damageNetwork, '"network-rescue-jn40301"'],
  [protocol, 'readonly type: "activate-hero-skill"'],
  [view, "requiredTargetCount: 1 as const"],
  [turn, 'builder.append("turn.hero-skill-activated"'],
  [turnUnit, "uses JN20302 to discard one technique card"],
  [replay, "replays JN20302 direct healing"],
  [damageNetwork, '"network-jn20302-cure"'],
  [view, 'skillId: "xyy.skill.jn40401" as const'],
  [turn, 'skillId: "xyy.skill.jn40401"'],
  [turn, "const paymentState: MatchState"],
  [turnUnit, "uses JN40401 to discard hand or equipment before curing self"],
  [replay, "replays JN40401 equipment payment before self-healing"],
  [damageNetwork, '"network-jn40401-pay-weapon"'],
]) {
  assert(source.includes(token), `Missing CS02 verification token ${token}.`);
}
for (const path of [
  "docs/content-standard/cs02-hero-skills.md",
  "docs/verification/receipts/cs02-jn50402.md",
  "docs/verification/receipts/cs02-jn50501.md",
  "docs/verification/receipts/cs02-jn20202.md",
  "docs/verification/receipts/cs02-jn40301.md",
  "docs/verification/receipts/cs02-jn20302.md",
  "docs/verification/receipts/cs02-jn40401.md",
]) {
  assert(existsSync(resolve(root, path)), `Missing ${path}.`);
}
assert(
  Object.keys(contract.acceptanceMap).length === 46,
  "Expected 46 CS02 acceptance items.",
);

console.log(
  `hero-skills verified: ${scopedHeroes.length} heroes, ${allEdges.length} ownership edges, JN50402/JN50501/JN20202/JN40301/JN20302/JN40401 complete`,
);
