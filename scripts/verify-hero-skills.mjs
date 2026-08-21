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
const heroStats = read("packages/engine/src/hero-stats.ts");
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
const giftSwordPlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn50401",
);
const heroPlan = plan.items.find((item) => item.id === "xyy.hero.xj404");
const immunityPlan = plan.items.find((item) => item.id === "xyy.skill.jn50501");
const immunityHeroPlan = plan.items.find(
  (item) => item.id === "xyy.hero.xj405",
);
const refusalPlan = plan.items.find((item) => item.id === "xyy.skill.jn20202");
const refusalHeroPlan = plan.items.find((item) => item.id === "xyy.hero.xj202");
const cookingPlan = plan.items.find((item) => item.id === "xyy.skill.jn40301");
const cookingHeroPlan = plan.items.find((item) => item.id === "xyy.hero.x3w03");
const brothersPlan = plan.items.find((item) => item.id === "xyy.skill.jn40302");
const giftHandPlan = plan.items.find((item) => item.id === "xyy.skill.jn10501");
const venomPlan = plan.items.find((item) => item.id === "xyy.skill.jn10502");
const giftHandHeroPlan = plan.items.find(
  (item) => item.id === "xyy.hero.xj105",
);
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
const explorationPlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn50201",
);
const redistributionPlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn50202",
);
const graveRobbingPlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn50203",
);
const explorationHeroPlan = plan.items.find(
  (item) => item.id === "xyy.hero.xj402",
);
const flowerDestroyingPlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn20601",
);
const flowerDestroyingHeroPlan = plan.items.find(
  (item) => item.id === "xyy.hero.xj206",
);
const lifeSacrificePlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn20602",
);
const transformedHeroPlan = plan.items.find(
  (item) => item.id === "xyy.hero.xj207",
);
const turnStartDrawPlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn20701",
);
const turnEndDamagePlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn20702",
);
const pursuitPlan = plan.items.find((item) => item.id === "xyy.skill.jn30201");
const pursuitHeroPlan = plan.items.find((item) => item.id === "xyy.hero.xj302");
const swordFingerPlan = plan.items.find(
  (item) => item.id === "xyy.skill.jn10401",
);
const swordFingerHeroPlan = plan.items.find(
  (item) => item.id === "xyy.hero.xj104",
);
const swordHitPlan = plan.items.find((item) => item.id === "xyy.skill.jn10601");
const swordHitHeroPlan = plan.items.find(
  (item) => item.id === "xyy.hero.xj106",
);
assert(skillPlan?.state === "verified", "JN50402 must be verified in plan.");
assert(
  giftSwordPlan?.state === "verified",
  "JN50401 must be verified in plan.",
);
assert(heroPlan?.state === "verified", "XJ404 must be verified.");
assert(
  heroPlan?.boundary.includes("JN50402") &&
    heroPlan?.boundary.includes("JN50401"),
  "XJ404 boundary must name both completed skills.",
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
assert(brothersPlan?.state === "verified", "JN40302 must be verified in plan.");
assert(cookingHeroPlan?.state === "verified", "X3W03 must be verified.");
assert(
  cookingHeroPlan?.boundary.includes("JN40301") &&
    cookingHeroPlan?.boundary.includes("JN40302"),
  "X3W03 boundary must name both completed skills.",
);
assert(giftHandPlan?.state === "verified", "JN10501 must be verified in plan.");
assert(venomPlan?.state === "verified", "JN10502 must be verified in plan.");
assert(giftHandHeroPlan?.state === "verified", "XJ105 must be verified.");
assert(
  giftHandHeroPlan?.boundary.includes("JN10501") &&
    giftHandHeroPlan?.boundary.includes("JN10502"),
  "XJ105 boundary must name both completed skills.",
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
assert(
  explorationPlan?.state === "verified",
  "JN50201 must be verified in plan.",
);
assert(
  redistributionPlan?.state === "verified",
  "JN50202 must be verified in plan.",
);
assert(
  graveRobbingPlan?.state === "verified",
  "JN50203 must be verified in plan.",
);
assert(explorationHeroPlan?.state === "verified", "XJ402 must be verified.");
assert(
  explorationHeroPlan?.boundary.includes("JN50201") &&
    explorationHeroPlan?.boundary.includes("JN50202") &&
    explorationHeroPlan?.boundary.includes("JN50203"),
  "XJ402 boundary must name all three completed skills.",
);
assert(
  flowerDestroyingPlan?.state === "verified",
  "JN20601 must be verified in plan.",
);
assert(
  flowerDestroyingHeroPlan?.state === "partial",
  "XJ206 must remain partial.",
);
assert(
  flowerDestroyingHeroPlan?.boundary.includes("JN20601") &&
    flowerDestroyingHeroPlan?.boundary.includes("JN20602") &&
    flowerDestroyingHeroPlan?.boundary.includes("CS03"),
  "XJ206 boundary must name completed skill and pending transformation.",
);
assert(
  lifeSacrificePlan?.state === "partial",
  "JN20602 must remain partial until pet state exists.",
);
assert(
  lifeSacrificePlan?.boundary.includes("XJ207") &&
    lifeSacrificePlan?.boundary.includes("pet"),
  "JN20602 boundary must name transformed identity and pending pets.",
);
assert(transformedHeroPlan?.state === "partial", "XJ207 must remain partial.");
assert(
  turnStartDrawPlan?.state === "verified",
  "JN20701 must be verified in plan.",
);
assert(
  turnEndDamagePlan?.state === "verified",
  "JN20702 must be verified in plan.",
);
assert(
  transformedHeroPlan?.boundary.includes("nonselectable") &&
    transformedHeroPlan?.boundary.includes("JN20701") &&
    transformedHeroPlan?.boundary.includes("JN20702") &&
    transformedHeroPlan?.boundary.includes("pet"),
  "XJ207 boundary must name both verified native skills and pending pets.",
);
assert(pursuitPlan?.state === "verified", "JN30201 must be verified in plan.");
assert(pursuitHeroPlan?.state === "partial", "XJ302 must remain partial.");
assert(
  pursuitHeroPlan?.boundary.includes("JN30201") &&
    pursuitHeroPlan?.boundary.includes("JN30202") &&
    pursuitHeroPlan?.boundary.includes("JN30203") &&
    pursuitHeroPlan?.boundary.includes("CS03"),
  "XJ302 boundary must name verified pursuit and pending battle skills.",
);
assert(swordFingerPlan?.state === "verified", "JN10401 must be verified.");
assert(swordFingerHeroPlan?.state === "partial", "XJ104 must remain partial.");
assert(
  swordFingerHeroPlan?.boundary.includes("JN10401") &&
    swordFingerHeroPlan?.boundary.includes("JN10402") &&
    swordFingerHeroPlan?.boundary.includes("CS03"),
  "XJ104 boundary must name completed strength skill and pending battle skill.",
);
assert(swordHitPlan?.state === "verified", "JN10601 must be verified.");
assert(swordHitHeroPlan?.state === "partial", "XJ106 must remain partial.");
assert(
  swordHitHeroPlan?.boundary.includes("JN10601") &&
    swordHitHeroPlan?.boundary.includes("JN10602") &&
    swordHitHeroPlan?.boundary.includes("CS03"),
  "XJ106 boundary must name completed dexterity skill and pending battle skill.",
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
  [protocol, "readonly convertedCardId?: string"],
  [view, 'skillId: "xyy.skill.jn50201" as const'],
  [view, "jn50201TurnActions"],
  [turn, 'command.skillId === "xyy.skill.jn50201"'],
  [reaction, 'convertedCardId === "xyy.card.jp01"'],
  [reaction, "usedSkillIds: ["],
  [turnUnit, "uses JN50201 once per action phase"],
  [replay, "replays JN50201 through its response window"],
  [reactionNetwork, '"network-jn50201-convert-jp06"'],
  [view, 'skillId: "xyy.skill.jn50202" as const'],
  [turn, 'skillId === "xyy.skill.jn50202"'],
  [turn, 'prompt: "jn50202-discard-one"'],
  [reaction, 'effect.kind === "hero-skill:xyy.skill.jn50202"'],
  [turnUnit, "uses JN50202 once to draw before a mandatory private discard"],
  [turnUnit, "times out JN50202 mandatory discard"],
  [replay, "replays JN50202 draw and seeded mandatory discard"],
  [reactionNetwork, '"network-jn50202-activate"'],
  [view, 'skillId: "xyy.skill.jn50401" as const'],
  [turn, 'skillId === "xyy.skill.jn50401"'],
  [turn, "usedSkillTargetIds"],
  [turnUnit, "uses JN50401 to transfer equipment"],
  [turnUnit, "lets JN50401 refill from the equipment it replaced"],
  [replay, "replays JN50401 equipment transfer"],
  [damageNetwork, '"jn50401-first-transfer"'],
  [damageNetwork, '"jn50401-second-transfer"'],
  [protocol, 'readonly type: "distribute-death-loot"'],
  [view, 'type: "finish-death-loot"'],
  [damage, 'prompt: "jn50203-distribute-loot"'],
  [damage, 'this.append("death.loot-opened"'],
  [damageUnit, "uses JN50203 once per death batch"],
  [
    damageUnit,
    "skips JN50203 when the death batch has already decided the winner",
  ],
  [damageReplay, "replays JN50203 loot distribution"],
  [damageNetwork, '"jn50203-distribute-one"'],
  [damageNetwork, '"jn50203-self-damage-pass"'],
  [protocol, 'readonly type: "distribute-brother-hand"'],
  [view, 'skillId: "xyy.skill.jn40302" as const'],
  [view, 'type: "finish-brother-hand"'],
  [turn, 'prompt: "jn40302-distribute-hand"'],
  [turn, 'builder.append("turn.brother-hand-distributed"'],
  [turnUnit, "uses JN40302 once to collect teammate hands"],
  [replay, "replays JN40302 collection"],
  [damageNetwork, '"jn40302-distribute-two"'],
  [damageNetwork, '"jn40302-repeat"'],
  [view, 'skillId: "xyy.skill.jn10501" as const'],
  [view, "minCardCount: 1 as const"],
  [turn, 'skillId === "xyy.skill.jn10501"'],
  [turnUnit, "uses JN10501 repeatedly"],
  [replay, "replays repeated JN10501 private teammate hand transfers"],
  [damageNetwork, "persists repeated JN10501 teammate transfers"],
  [damageNetwork, '"jn10501-give-last"'],
  [turn, 'heroHasSkill(rewardPlayer.heroId, "xyy.skill.jn10502")'],
  [turn, 'kind: "jn10502-damage"'],
  [turnUnit, "triggers JN10502 before the ordinary reward draw"],
  [turnUnit, "lets TP03 prevent only its owner's JN10502 damage"],
  [turnUnit, "resumes JN10502 reward once after a JSON restart during dying"],
  [replay, "replays JN10502 through a restarted damage window"],
  [damageNetwork, "restarts JN10502 mid-response"],
  [damageNetwork, '"jn10502-end-action"'],
  [view, 'skillId: "xyy.skill.jn20601" as const'],
  [view, 'heroDefinition(candidate.heroId).gender === "F"'],
  [turn, 'command.skillId === "xyy.skill.jn20601"'],
  [turnUnit, "uses JN20601 to damage self"],
  [replay, "replays JN20601 target memory"],
  [damageNetwork, "restarts JN20601 mid-response"],
  [damageNetwork, '"jn20601-repeat"'],
  [damage, 'event.type === "death.hero-transformed"'],
  [damage, 'heroHasSkill(player.heroId, "xyy.skill.jn20602")'],
  [damageUnit, "uses JN20602 to transform before death"],
  [damageUnit, "rescue before JN20602 can transform"],
  [damageUnit, "JN20602 transformation decide a simultaneous"],
  [damageReplay, "replays JN20602 death transformation"],
  [damageNetwork, "restarts JN20602 mid-rescue"],
  [damageNetwork, "jn20602-rescue-pass-${pass}"],
  [turn, 'reason === "hero-skill:xyy.skill.jn20701"'],
  [turn, 'heroHasSkill(nextPlayer.heroId, "xyy.skill.jn20701")'],
  [turnUnit, "triggers JN20701 at XJ207 turn-start before event and action"],
  [replay, "replays JN20701 automatic turn-start draw before entering action"],
  [damageNetwork, "persists JN20701 private turn-start draw"],
  [turn, 'heroHasSkill(player.heroId, "xyy.skill.jn20702")'],
  [turn, 'kind: "jn20702-damage"'],
  [turn, "continueTurnAfterJN20702"],
  [reaction, 'state.turn?.phase !== "turn-end"'],
  [damage, 'state.turn?.phase !== "turn-end"'],
  [turnUnit, "triggers JN20702 after discard"],
  [turnUnit, "rejects forged JN20702 damage sources and targets"],
  [turnUnit, "settles JN20702 owner death before advancing"],
  [replay, "replays JN20702 turn-end self-damage"],
  [damageNetwork, "restarts JN20702 turn-end response"],
  [damage, 'heroHasSkill(player.heroId, "xyy.skill.jn30201")'],
  [damage, 'prompt: "hero-skill:xyy.skill.jn30201"'],
  [damage, "applyJn30201Timeout"],
  [setupSource, 'eventToReduce.type.startsWith("damage.")'],
  [damageUnit, "opens owner-private JN30201 pursuit before dying"],
  [damageUnit, "does not offer JN30201 for owner-only or CHAIN_INVAO"],
  [damageUnit, "includes the JN30201 owner when the same original batch"],
  [damageReplay, "replays JN30201 payment and nested damage"],
  [damageNetwork, "restarts JN30201 at private payment"],
  [heroStats, 'heroHasSkill(player.heroId, "xyy.skill.jn10401")'],
  [view, "readonly strength: number"],
  [view, "strength: player.strength"],
  [turn, "withWeaponSkillEquipment"],
  [reaction, "withWeaponSkillEquipment"],
  [damage, "withWeaponSkillEquipment"],
  [turnUnit, "applies JN10401 exactly once"],
  [replay, "replays JN10401 weapon import, replacement, and pawn export"],
  [reactionReplay, "expect(primary.state.players[target]!.strength).toBe(2)"],
  [damageUnit, "strength: 2"],
  [damageNetwork, "player.id === firstTarget ? 3 : player.strength"],
  [heroStats, 'heroHasSkill(player.heroId, "xyy.skill.jn10601")'],
  [heroStats, "dexterity: player.dexterity + dexterityDelta"],
  [turnUnit, "applies JN10601 exactly once"],
  [replay, "replays JN10601 weapon import and pawn export"],
  [damageNetwork, "player.id === secondTarget ? 1 : player.dexterity"],
  [damageNetwork, "dexterity: 2"],
]) {
  assert(source.includes(token), `Missing CS02 verification token ${token}.`);
}
for (const path of [
  "docs/content-standard/cs02-hero-skills.md",
  "docs/verification/receipts/cs02-jn50402.md",
  "docs/verification/receipts/cs02-jn50401.md",
  "docs/verification/receipts/cs02-jn50501.md",
  "docs/verification/receipts/cs02-jn20202.md",
  "docs/verification/receipts/cs02-jn40301.md",
  "docs/verification/receipts/cs02-jn20302.md",
  "docs/verification/receipts/cs02-jn40401.md",
  "docs/verification/receipts/cs02-jn50201.md",
  "docs/verification/receipts/cs02-jn50202.md",
  "docs/verification/receipts/cs02-jn50203.md",
  "docs/verification/receipts/cs02-jn40302.md",
  "docs/verification/receipts/cs02-jn10501.md",
  "docs/verification/receipts/cs02-jn10502.md",
  "docs/verification/receipts/cs02-jn20601.md",
  "docs/verification/receipts/cs02-jn20602-core.md",
  "docs/verification/receipts/cs02-jn20701.md",
  "docs/verification/receipts/cs02-jn20702.md",
  "docs/verification/receipts/cs02-jn30201.md",
  "docs/verification/receipts/cs02-jn10401.md",
  "docs/verification/receipts/cs02-jn10601.md",
]) {
  assert(existsSync(resolve(root, path)), `Missing ${path}.`);
}
assert(
  Object.keys(contract.acceptanceMap).length === 156,
  "Expected 156 CS02 acceptance items.",
);

console.log(
  `hero-skills verified: ${scopedHeroes.length} heroes, ${allEdges.length} ownership edges, JN10401/JN10601/JN50401/JN50402/JN50501/JN20202/JN40301/JN40302/JN10501/JN10502/JN20601/JN20701/JN20702/JN30201/JN20302/JN40401/JN50201/JN50202/JN50203 complete; JN20602 core partial pending CS03 pets`,
);
