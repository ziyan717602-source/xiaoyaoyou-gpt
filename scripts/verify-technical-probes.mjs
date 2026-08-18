import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const contract = JSON.parse(
  readFileSync(
    resolve(root, "contracts", "technical-probes.contract.json"),
    "utf8",
  ),
);
const source = readFileSync(
  resolve(root, "packages", "engine", "src", "technical-probes.replay.test.ts"),
  "utf8",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(contract.schemaVersion === 1, "Unknown technical probe contract.");
assert(contract.seed === "p06-fixed-seed-20260819", "P06 seed drifted.");
assert(contract.probes.length === 3, "Exactly three P06 probes are required.");
assert(
  contract.probes[1].viewCount === 6,
  "Privacy probe must derive six views.",
);
assert(
  contract.probes[2].actionMs === 15_000,
  "Action timeout must be 15 seconds.",
);
assert(
  contract.probes[2].disconnectMs === 60_000,
  "Disconnect timeout must be 60 seconds.",
);
assert(contract.goCriteria.length >= 5, "P06 go criteria are incomplete.");
for (const probe of contract.probes) {
  assert(source.includes(probe.id), `${probe.id} has no replay test.`);
  assert(
    probe.failureArtifact.startsWith("artifacts/failures/p06-"),
    `${probe.id} failure artifact is outside the ignored failure directory.`,
  );
}
assert(
  source.includes("roundTrip"),
  "Wait-point JSON round trips are missing.",
);
assert(
  source.includes("secret:${id}"),
  "Six-view secret canaries are missing.",
);
assert(
  !source.includes("TP01") && !source.includes("JP01"),
  "Technical probes must not migrate real catalog content.",
);

console.log(
  `Technical probe contract verified: ${contract.probes.length} probes, ${contract.goCriteria.length} go criteria, fixed seed ${contract.seed}.`,
);
