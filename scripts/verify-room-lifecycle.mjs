import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const readJson = (path) => JSON.parse(read(path));
const contract = readJson("contracts/room-lifecycle.contract.json");
const rootPackage = readJson("package.json");
const persistence = read("apps/server/src/persistence.ts");
const roomStore = read("apps/server/src/room-store.ts");
const roomServer = read("apps/server/src/room-server.ts");
const socketServer = read("apps/server/src/index.ts");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(contract.scope === "M01-ROOM-LIFECYCLE", "M01 scope drifted.");
assert(contract.room.capacity === 6, "Room capacity must remain six.");
assert(contract.room.spectator === false, "Spectators are out of scope.");
assert(
  contract.room.transitions.join("|") ===
    "create->open|open->started|started->ended",
  "Room state machine drifted.",
);
assert(
  contract.identity.reconnectToken.includes("256-bit"),
  "Reconnect token entropy contract is missing.",
);
assert(
  contract.identity.storedToken === "sha256-only",
  "Raw reconnect tokens must never be persisted.",
);
assert(
  contract.persistence.databaseSchemaVersion === 2,
  "Room database schema contract drifted.",
);
for (const table of contract.persistence.tables) {
  assert(
    persistence.includes(`CREATE TABLE ${table}`),
    `Missing persistent room table ${table}.`,
  );
}
for (const route of contract.http.routes) {
  const path = route.slice(route.indexOf(" ") + 1);
  const dynamicLifecycleRoute =
    path.endsWith("/start") || path.endsWith("/end");
  const present = dynamicLifecycleRoute
    ? roomServer.includes('for (const action of ["start", "end"]') &&
      roomServer.includes("`/api/rooms/:roomId/${action}`")
    : roomServer.includes(path);
  assert(present, `Missing room route ${route}.`);
}
for (const token of [
  "randomBytes(32)",
  'digest("hex")',
  "timingSafeEqual",
  "ROOM_CAPACITY = 6",
  "command-id-reused",
  "stale-version",
  "room-not-started",
]) {
  assert(roomStore.includes(token), `Missing room invariant: ${token}.`);
}
for (const token of [
  "allowedOrigins.includes(origin)",
  'previous.socket.close(4000, "connection-replaced")',
  "maxUnauthenticatedConnections ?? 100",
]) {
  assert(socketServer.includes(token), `Missing socket control: ${token}.`);
}
for (const file of [
  "apps/server/src/room-store.test.ts",
  "apps/server/src/room-main.ts",
  "tests/integration/room-lifecycle.integration.test.ts",
  "docs/room-lifecycle/m01-room-lifecycle.md",
  "docs/verification/receipts/m01-room-lifecycle.md",
]) {
  assert(existsSync(resolve(root, file)), `Missing M01 evidence ${file}.`);
}
for (const command of [
  "dev:rooms",
  "room:contract",
  "rooms:verify",
  "start:rooms",
  "test:rooms",
]) {
  assert(
    typeof rootPackage.scripts[command] === "string",
    `Missing command ${command}.`,
  );
}

console.log(
  `Room lifecycle contract passed: ${Object.keys(contract.acceptanceMap).length} acceptance items, ${contract.room.capacity} seats.`,
);
