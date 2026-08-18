import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) =>
  JSON.parse(readFileSync(resolve(root, path), "utf8"));
const contract = readJson("contracts/architecture.contract.json");
const rootPackage = readJson("package.json");
const serverPackage = readJson("apps/server/package.json");
const protocolPackage = readJson("packages/protocol/package.json");
const protocolSource = readFileSync(
  resolve(root, "packages/protocol/src/index.ts"),
  "utf8",
);
const serverSource = readFileSync(
  resolve(root, "apps/server/src/index.ts"),
  "utf8",
);
const persistenceSource = readFileSync(
  resolve(root, "apps/server/src/persistence.ts"),
  "utf8",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const [dependency, major] of [
  ["fastify", "5"],
  ["@fastify/websocket", "11"],
  ["better-sqlite3", "12.11.1"],
  ["prom-client", "15"],
]) {
  const value = serverPackage.dependencies[dependency];
  assert(
    typeof value === "string" && value.includes(major),
    `Missing frozen ${dependency}@${major}.`,
  );
}
assert(
  protocolPackage.dependencies.ajv.includes("8"),
  "Protocol must own Ajv 8 runtime validation.",
);
assert(
  contract.localEnvironment.players === 6,
  "Local environment must have six players.",
);
assert(
  contract.websocket.tokenInUrl === false,
  "Reconnect token must not be placed in URL.",
);
assert(
  contract.websocket.maxMessageBytes === 65536,
  "WebSocket payload bound drifted.",
);
assert(
  contract.persistence.snapshotEveryAcceptedCommands === 25,
  "Snapshot interval drifted.",
);
assert(
  contract.security.spectator === false,
  "Spectator support is out of scope.",
);
assert(
  protocolSource.includes("validateClientMessage"),
  "Runtime protocol validator is missing.",
);
assert(
  protocolSource.includes("validateServerMessage"),
  "Runtime server message validator is missing.",
);
assert(
  serverSource.includes("authenticationDeadlineMs"),
  "Authentication deadline is missing.",
);
assert(
  serverSource.includes("server-draining"),
  "Graceful WebSocket drain is missing.",
);
assert(
  persistenceSource.includes("journal_mode = WAL"),
  "SQLite WAL is missing.",
);
assert(
  persistenceSource.includes("synchronous = FULL"),
  "SQLite FULL durability is missing.",
);
assert(
  persistenceSource.includes("command_receipts"),
  "Idempotency receipts are missing.",
);

for (const command of [
  "architecture:verify",
  "architecture:smoke",
  "dev:local",
  "test:architecture",
]) {
  assert(
    typeof rootPackage.scripts[command] === "string",
    `Missing command ${command}.`,
  );
}
for (const file of [
  "apps/server/src/match-actor.ts",
  "apps/server/src/persistence.ts",
  "apps/server/src/local.ts",
  "docs/architecture/p08-runtime.md",
  "docs/architecture/threat-model.md",
  "docs/architecture/observability.md",
  "docs/architecture/local-development.md",
  "docs/adr/0004-production-runtime-stack.md",
  "docs/adr/0005-match-actor-and-wire-contract.md",
]) {
  assert(
    existsSync(resolve(root, file)),
    `Missing architecture evidence ${file}.`,
  );
}

console.log(
  `Architecture contract passed: ${Object.keys(contract.acceptanceMap).length} acceptance items, ${contract.localEnvironment.players} local players.`,
);
