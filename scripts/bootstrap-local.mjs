import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const smoke = process.argv.includes("--smoke");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args) {
  const result = spawnSync(npmCommand, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["ci"]);
run(["run", "check:full"]);

if (smoke) {
  console.log(
    "Fresh-clone bootstrap passed: install, build, full tests, and local six-player smoke start.",
  );
} else {
  run(["run", "dev:local"]);
}
