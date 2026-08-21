import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const contract = json("contracts/time-recovery.contract.json");
const architecture = read("packages/engine/src/architecture.ts");
const engine = read("packages/engine/src/time-recovery.ts");
const service = read("apps/server/src/match-service.ts");
const rootPackage = json("package.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(contract.schemaVersion === 1, "Unknown M06 contract schema.");
assert(contract.scope === "M06-TIME-RECOVERY", "M06 scope drifted.");
assert(contract.deadlines.actionMs === 15_000, "Action timeout drifted.");
assert(
  contract.deadlines.disconnectMs === 60_000,
  "Disconnect timeout drifted.",
);
assert(contract.persistence.matchSchema === 7, "M06 match schema drifted.");
assert(
  Object.keys(contract.acceptanceMap).length === 15,
  "M06 acceptance map must contain fifteen items.",
);
for (const origin of contract.systemPipeline.origins) {
  assert(architecture.includes(`origin: "${origin}"`), `Missing ${origin}.`);
}
for (const token of [
  "ACTION_DEADLINE_MS = 15_000",
  "DISCONNECT_GRACE_MS = 60_000",
  "collectSystemDeadlines",
  "applySystemCommand",
  "reduceTimeRecoveryEvent",
  '"connection.auto-enabled"',
  '"system.timeout-resolved"',
]) {
  assert(engine.includes(token), `Missing M06 engine boundary ${token}.`);
}
for (const token of [
  "DeadlineScheduler",
  "collectSystemDeadlines",
  '"system"',
]) {
  assert(service.includes(token), `Missing M06 service boundary ${token}.`);
}
for (const file of [
  "packages/engine/src/time-recovery.test.ts",
  "packages/engine/src/time-recovery.replay.test.ts",
  "packages/engine/src/testing/time-recovery-engine.bot.test.ts",
  "tests/integration/time-recovery-lifecycle.integration.test.ts",
  "docs/time-recovery/m06-time-recovery.md",
  "docs/verification/receipts/m06-time-recovery.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing M06 evidence ${file}.`);
}
for (const command of ["time:contract", "time:verify", "test:time"]) {
  assert(
    typeof rootPackage.scripts[command] === "string",
    `Missing ${command}.`,
  );
}

console.log(
  `Time/recovery contract passed: ${Object.keys(contract.acceptanceMap).length} acceptance items, ${contract.deadlines.actionMs} ms action, ${contract.deadlines.disconnectMs} ms disconnect, schema v${contract.persistence.matchSchema}.`,
);
