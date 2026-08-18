import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const contract = JSON.parse(
  readFileSync(
    resolve(root, "contracts", "verification-system.contract.json"),
    "utf8",
  ),
);
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
for (const command of contract.commands)
  assert(
    typeof packageJson.scripts[command] === "string",
    `Missing command ${command}.`,
  );
assert(
  packageJson.scripts["check:full"].includes("test:integration"),
  "Full check omits integration tests.",
);
assert(
  contract.botLongGameTurns >= 10_000,
  "Bot long-game threshold is too low.",
);
assert(
  contract.browserContexts === 6,
  "Browser verification must use six contexts.",
);

const requiredFiles = [
  "packages/engine/src/index.property.test.ts",
  "packages/engine/src/testing/bots.ts",
  "packages/engine/src/testing/bots.bot.test.ts",
  "tests/integration/six-connection.integration.test.ts",
  "tests/e2e/six-player.e2e.spec.ts",
  "tests/e2e/persistent-failure-reporter.ts",
  ".github/workflows/ci.yml",
  ".github/workflows/nightly.yml",
];
for (const file of requiredFiles)
  assert(existsSync(resolve(root, file)), `Missing verification file ${file}.`);

function jpegDimensions(path) {
  const bytes = readFileSync(path);
  assert(bytes[0] === 0xff && bytes[1] === 0xd8, `${path} is not JPEG.`);
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker >= 0xc0 && marker <= 0xc3)
      return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
    offset += bytes.readUInt16BE(offset + 2) + 2;
  }
  throw new Error(`${path} lacks a JPEG size marker.`);
}
for (const [file, width, height] of [
  ["p07-desktop-room-ready.jpg", 1366, 768],
  ["p07-mobile-room-ready.jpg", 360, 800],
]) {
  const dimensions = jpegDimensions(
    resolve(root, "docs", "verification", "screenshots", file),
  );
  assert(
    dimensions[0] === width && dimensions[1] === height,
    `${file} has wrong dimensions.`,
  );
}

console.log(
  `Verification system contract passed: ${contract.layers.length} layers, ${contract.commands.length} commands, ${contract.browserContexts} browser contexts.`,
);
