import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const contract = JSON.parse(
  readFileSync(
    resolve(root, "contracts", "ux-prototype.contract.json"),
    "utf8",
  ),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requiredScenarios = [
  "own-turn",
  "single-target",
  "multi-target",
  "bingxin-response",
  "multi-dying",
  "waiting",
  "disconnected",
  "reconnecting",
  "expired-action",
  "long-content",
  "settlement",
];

assert(contract.schemaVersion === 1, "Unknown UX contract version.");
assert(
  contract.viewports.desktop.width === 1366 &&
    contract.viewports.desktop.height === 768,
  "Desktop baseline must be 1366x768.",
);
assert(
  contract.viewports.mobile.width === 360 &&
    contract.viewports.mobile.height === 800,
  "Mobile baseline must be 360x800.",
);
assert(
  contract.accessibility.minimumHitTargetPx >= 44,
  "Interactive targets must be at least 44px.",
);
assert(
  contract.actionSource === "player-view.availableActions-only",
  "The browser must not infer legal actions.",
);
assert(
  JSON.stringify(contract.scenarioIds) === JSON.stringify(requiredScenarios),
  "UX scenario matrix drifted.",
);
const acceptanceIds = Array.from(
  { length: 11 },
  (_, index) => `P05-${String(index + 1).padStart(2, "0")}`,
);
assert(
  JSON.stringify(Object.keys(contract.acceptanceMap).sort()) ===
    JSON.stringify(acceptanceIds),
  "P05 acceptance map must cover P05-01 through P05-11.",
);

const source = readFileSync(
  resolve(root, "apps", "web", "src", "main.tsx"),
  "utf8",
);
const styles = readFileSync(
  resolve(root, "apps", "web", "src", "styles.css"),
  "utf8",
);
for (const scenario of requiredScenarios) {
  assert(source.includes(`"${scenario}"`), `Prototype is missing ${scenario}.`);
}
assert(
  source.includes("availableActions"),
  "Prototype must render availableActions.",
);
assert(
  styles.includes("prefers-reduced-motion"),
  "Reduced motion support is missing.",
);
assert(
  styles.includes("env(safe-area-inset-bottom)"),
  "Mobile safe-area support is missing.",
);
assert(styles.includes(":focus-visible"), "Visible keyboard focus is missing.");

function readJpegDimensions(jpeg, filename) {
  assert(jpeg[0] === 0xff && jpeg[1] === 0xd8, `${filename} is not a JPEG.`);
  let offset = 2;
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = jpeg[offset + 1];
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: jpeg.readUInt16BE(offset + 5),
        width: jpeg.readUInt16BE(offset + 7),
      };
    }
    const segmentLength = jpeg.readUInt16BE(offset + 2);
    assert(segmentLength >= 2, `${filename} has an invalid JPEG segment.`);
    offset += segmentLength + 2;
  }
  throw new Error(`${filename} has no JPEG size marker.`);
}

for (const [filename, expectedWidth, expectedHeight] of [
  ["p05-desktop-own-turn.jpg", 1366, 768],
  ["p05-desktop-bingxin.jpg", 1366, 768],
  ["p05-mobile-multi-dying.jpg", 360, 800],
]) {
  const jpeg = readFileSync(
    resolve(root, "docs", "verification", "screenshots", filename),
  );
  const dimensions = readJpegDimensions(jpeg, filename);
  assert(
    dimensions.width === expectedWidth && dimensions.height === expectedHeight,
    `${filename} must be ${expectedWidth}x${expectedHeight}.`,
  );
}

console.log(
  `UX prototype contract verified: ${acceptanceIds.length} acceptance items, ${requiredScenarios.length} scenarios, desktop and mobile baselines.`,
);
