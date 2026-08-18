import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const checklist = read("PREPARATION_CHECKLIST.md");
const unfinished = checklist
  .split(/\r?\n/u)
  .filter((line) => /^- \[ \] `P0[0-9]-/u.test(line));
assert(
  unfinished.length === 0,
  `P00-P09 has ${unfinished.length} unfinished items:\n${unfinished.join("\n")}`,
);

const catalog = json("catalog/catalog.json");
assert(
  catalog.items.length === 233,
  "Authoritative catalog item count drifted.",
);
assert(
  new Set(catalog.items.map((item) => item.canonicalId)).size ===
    catalog.items.length,
  "Catalog canonical IDs are not unique.",
);
const productPackages = new Set(catalog.items.flatMap((item) => item.packages));
for (const packageName of ["standard", "fengmingyushi", "shared-core"]) {
  assert(productPackages.has(packageName), `Catalog omits ${packageName}.`);
}
for (const discrepancy of catalog.discrepancies) {
  assert(
    ["resolved", "provisional-autonomous"].includes(discrepancy.status),
    `Catalog discrepancy ${discrepancy.id} lacks a decision.`,
  );
  assert(
    typeof discrepancy.provisionalDecision === "string" &&
      discrepancy.provisionalDecision.length > 0,
    `Catalog discrepancy ${discrepancy.id} lacks a documented decision.`,
  );
}

const semantics = json("contracts/semantics.contract.json");
const probes = json("contracts/technical-probes.contract.json");
const architecture = json("contracts/architecture.contract.json");
assert(
  semantics.temporaryDecisions.length === 6,
  "Semantic decisions drifted.",
);
assert(probes.probes.length === 3, "Three technical probes are required.");
assert(
  Object.keys(architecture.acceptanceMap).length === 9,
  "P08 architecture evidence is incomplete.",
);

for (const file of [
  "docs/audits/p01-remote-clone-verification.md",
  "docs/verification/receipts/p02-golden-traces.md",
  "docs/verification/receipts/p03-authoritative-catalog.md",
  "docs/verification/receipts/p04-semantics-contract.md",
  "docs/verification/receipts/p05-ux-prototype.md",
  "docs/verification/receipts/p06-technical-probes.md",
  "docs/verification/receipts/p07-verification-system.md",
  "docs/verification/receipts/p08-production-architecture.md",
  "docs/verification/receipts/p09-goal-dry-run.md",
  "GOAL_PROMPT.md",
]) {
  assert(
    existsSync(resolve(root, file)),
    `Missing preparation evidence ${file}.`,
  );
}

const readme = read("README.md");
assert(
  readme.includes("node scripts/bootstrap-local.mjs"),
  "README lacks the fresh-clone bootstrap command.",
);
const tracked = execFileSync("git", ["ls-files"], {
  cwd: root,
  encoding: "utf8",
});
assert(
  !tracked
    .split(/\r?\n/u)
    .some((path) =>
      path.replaceAll("\\", "/").startsWith("reference/psd48-master/"),
    ),
  "Tracked history contains the local legacy reference.",
);

console.log(
  `Preparation audit passed: 10 phases, ${catalog.items.length} catalog items, ${catalog.discrepancies.length} decided discrepancies, ${probes.probes.length} probes.`,
);
