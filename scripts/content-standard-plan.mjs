import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = resolve(root, "contracts/content-standard.contract.json");
const catalogPath = resolve(root, "catalog/catalog.json");
const planPath = resolve(root, "content/standard-plan.json");
const reportPath = resolve(root, "docs/content-standard/plan.md");
const write = process.argv.includes("--write");

const contract = JSON.parse(readFileSync(contractPath, "utf8"));
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const directCardSlices = new Map();
for (const slice of contract.executionQueue) {
  for (const itemId of slice.items ?? [])
    directCardSlices.set(itemId, slice.id);
}

function sliceFor(item) {
  const direct = directCardSlices.get(item.canonicalId);
  if (direct !== undefined) return direct;
  if (item.packages.includes("shared-core")) return "CS00-SHARED-CORE";
  const byKind = contract.executionQueue.find((slice) =>
    (slice.kinds ?? []).includes(item.kind),
  );
  assert(byKind !== undefined, `No content slice for ${item.canonicalId}.`);
  return byKind.id;
}

function baseline(item) {
  if (item.packages.includes("standard") && item.kind === "hero") {
    return {
      state: "partial",
      boundary: contract.baselinePartial.allStandardHeroes.boundary,
      evidence: contract.baselinePartial.allStandardHeroes.evidence,
    };
  }
  const card = contract.baselinePartial.cards[item.canonicalId];
  if (card !== undefined) {
    return { state: "partial", ...card };
  }
  return { state: "unstarted", boundary: null, evidence: [] };
}

const selected = catalog.items
  .filter(
    (item) =>
      item.packages.includes("standard") ||
      item.packages.includes("shared-core"),
  )
  .sort((left, right) => left.canonicalId.localeCompare(right.canonicalId));

const items = selected.map((item) => {
  const current = baseline(item);
  return {
    id: item.canonicalId,
    name: item.name,
    kind: item.kind,
    packages: item.packages,
    slice: sliceFor(item),
    state: current.state,
    boundary: current.boundary,
    evidence: current.evidence,
    dependencies: item.dependencies,
  };
});

const counts = {
  standard: items.filter((item) => item.packages.includes("standard")).length,
  sharedCore: items.filter((item) => item.packages.includes("shared-core"))
    .length,
  total: items.length,
  partial: items.filter((item) => item.state === "partial").length,
  verified: items.filter((item) => item.state === "verified").length,
  deferred: items.filter((item) => item.state === "deferred").length,
  unstarted: items.filter((item) => item.state === "unstarted").length,
};

assert(
  counts.standard === contract.catalogCoverage.standardItems,
  `Expected ${contract.catalogCoverage.standardItems} standard items, found ${counts.standard}.`,
);
assert(
  counts.sharedCore === contract.catalogCoverage.sharedCorePrerequisites,
  `Expected ${contract.catalogCoverage.sharedCorePrerequisites} shared items, found ${counts.sharedCore}.`,
);
assert(
  counts.total === contract.catalogCoverage.totalTrackedItems,
  `Expected ${contract.catalogCoverage.totalTrackedItems} tracked items, found ${counts.total}.`,
);
assert(
  new Set(items.map((item) => item.id)).size === items.length,
  "Duplicate item.",
);
for (const item of items) {
  assert(contract.states.includes(item.state), `Invalid state for ${item.id}.`);
  if (item.state === "partial") {
    assert(item.boundary !== null, `Partial item ${item.id} lacks a boundary.`);
    assert(item.evidence.length > 0, `Partial item ${item.id} lacks evidence.`);
  }
  if (item.state === "verified") {
    assert(
      item.evidence.some((entry) => entry.startsWith("receipt:")),
      `Verified item ${item.id} lacks a receipt.`,
    );
  }
  if (item.state === "deferred") {
    assert(item.boundary !== null, `Deferred item ${item.id} lacks a reason.`);
  }
}

const plan = {
  schemaVersion: 1,
  planId: "xiaoyaoyou-content-standard-plan-v1",
  rulesetId: catalog.rulesetId,
  sourceSnapshotSha256: catalog.sourceSnapshotSha256,
  counts,
  executionQueue: contract.executionQueue,
  items,
};

const planText = await format(JSON.stringify(plan), { parser: "json" });
const sliceCounts = Object.groupBy(items, (item) => item.slice);
const partialRows = items
  .filter((item) => item.state === "partial")
  .map(
    (item) =>
      `| \`${item.id}\` | ${item.name} | ${item.boundary} | ${item.evidence.join(", ")} |`,
  )
  .join("\n");
const queueRows = [
  "CS00-SHARED-CORE",
  ...contract.executionQueue.map((x) => x.id),
]
  .map((id) => `| \`${id}\` | ${(sliceCounts[id] ?? []).length} |`)
  .join("\n");
const reportText = await format(
  `# CONTENT-STANDARD 逐项执行图

> 本文件由 \`npm run content:plan\` 从权威目录与内容合同确定性生成；不能手工把条目标成完成。

- 标准包：${counts.standard}
- 共享核心前置：${counts.sharedCore}
- 总跟踪：${counts.total}
- 当前 partial：${counts.partial}
- 当前 verified：${counts.verified}
- 当前 deferred：${counts.deferred}
- 当前 unstarted：${counts.unstarted}

## 执行切片

| 切片 | 条目数 |
| --- | ---: |
${queueRows}

第一可执行切片是 \`CS01A-CORE-CARD-AUDIT\`：冻结鼠儿果、天雷破、冰心诀、灵葫仙丹的逐模式旧版证据并补齐灵葫仙丹普通自疗。仍依赖事件、技能或特殊牌的条目继续保持 partial，直到相应切片闭合。

## 已有局部实现（不得误报为完成）

| ID | 名称 | 已实现边界 | 证据 |
| --- | --- | --- | --- |
${partialRows}

完整 205 项状态、依赖原语、隐藏信息与 UI 选择见 \`content/standard-plan.json\`。
`,
  { parser: "markdown" },
);

function verifyFile(path, expected) {
  assert(existsSync(path), `Missing generated content plan file ${path}.`);
  assert(
    readFileSync(path, "utf8") === expected,
    `Stale generated file ${path}.`,
  );
}

if (write) {
  mkdirSync(dirname(planPath), { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(planPath, planText);
  writeFileSync(reportPath, reportText);
} else {
  verifyFile(planPath, planText);
  verifyFile(reportPath, reportText);
}

console.log(
  `Content-standard plan ${write ? "generated" : "verified"}: ${counts.total} tracked, ${counts.partial} partial, ${counts.verified} verified.`,
);
