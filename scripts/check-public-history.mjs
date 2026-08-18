import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const failures = [];
const tracked = git("-c", "core.quotePath=false", "ls-files", "-z")
  .split("\0")
  .filter(Boolean);
const reachable = git(
  "-c",
  "core.quotePath=false",
  "rev-list",
  "--objects",
  "--branches",
  "--tags",
);

for (const path of tracked) {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("reference/psd48-master/")) {
    failures.push(`legacy reference is tracked: ${normalized}`);
  }
  if (
    /(^|\/)(node_modules|dist|dist-types|coverage|bin|obj|Output)\//u.test(
      normalized,
    ) ||
    normalized.endsWith(".tsbuildinfo")
  ) {
    failures.push(`generated path is tracked: ${normalized}`);
  }

  const stats = statSync(normalized);
  if (stats.size > 5 * 1024 * 1024) {
    failures.push(`tracked file exceeds 5 MiB: ${normalized}`);
  }

  if (stats.size > 1024 * 1024) continue;
  const buffer = readFileSync(normalized);
  if (buffer.includes(0)) continue;
  const content = buffer.toString("utf8");
  const checks = [
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
    [
      "GitHub token",
      /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/u,
    ],
    ["AWS access key", /AKIA[0-9A-Z]{16}/u],
    ["Google API key", /AIza[0-9A-Za-z_-]{30,}/u],
    ["credential URL", /https?:\/\/[^/\s:@]+:[^/\s@]+@/u],
    ["local user path", /[A-Z]:\\(?:Users|Project)\\/iu],
    ["Git LFS pointer", /version https:\/\/git-lfs\.github\.com\/spec\/v1/u],
  ];
  for (const [label, pattern] of checks) {
    if (pattern.test(content)) failures.push(`${label} found in ${normalized}`);
  }
}

if (reachable.includes("reference/psd48-master/")) {
  failures.push("legacy reference is reachable from a public branch or tag");
}

if (failures.length > 0) {
  console.error(
    "Public history check failed:\n" +
      failures.map((item) => `- ${item}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `Public history check passed: ${tracked.length} tracked files; no legacy path, generated output, oversized file, common credential, local path, or LFS pointer.`,
);
