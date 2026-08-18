import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const requiredFiles = [
  "AGENTS.md",
  "PLAN.md",
  "GOAL_ACCEPTANCE.md",
  "PROGRESS.md",
  "GOAL_CONTRACT.md",
  "PREPARATION_CHECKLIST.md",
];
const requiredScripts = [
  "check:fast",
  "check:full",
  "test:replay",
  "test:bots",
  "test:e2e",
  "preparation:audit",
  "goal:preflight",
];
const failures = [];

for (const file of requiredFiles) {
  if (!existsSync(file)) failures.push(`missing required file: ${file}`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
for (const script of requiredScripts) {
  if (typeof packageJson.scripts?.[script] !== "string") {
    failures.push(`missing npm script: ${script}`);
  }
}

const checklist = readFileSync("PREPARATION_CHECKLIST.md", "utf8");
const unfinished = checklist
  .split(/\r?\n/u)
  .filter((line) => /^- \[ \] `P0[0-9]-/u.test(line));
if (unfinished.length > 0) {
  failures.push(
    `${unfinished.length} P00-P09 preparation items are not verified`,
  );
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

if (git("status", "--porcelain") !== "") {
  failures.push("worktree is not clean");
}
if (!git("branch", "--show-current").startsWith("codex/")) {
  failures.push("goal must run on a codex/* branch");
}

let readinessTag = "";
try {
  readinessTag = git(
    "describe",
    "--tags",
    "--match",
    "pre-goal-*",
    "--abbrev=0",
    "HEAD",
  );
} catch {
  // Report a stable failure below.
}
if (!readinessTag.startsWith("pre-goal-")) {
  failures.push("HEAD has no reachable pre-goal-* readiness tag");
}

if (failures.length > 0) {
  console.error(
    "Goal preflight is correctly blocked:\n" +
      failures.map((item) => `- ${item}`).join("\n"),
  );
  process.exit(1);
}

for (const script of ["preparation:audit", "check:full"]) {
  const result = spawnSync("npm", ["run", script], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(
  `Goal preflight passed at ${git("rev-parse", "HEAD")} (readiness ${readinessTag}).`,
);
