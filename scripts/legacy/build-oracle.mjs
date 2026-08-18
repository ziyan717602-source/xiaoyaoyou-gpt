import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const toolProject = join(
  workspaceRoot,
  "tools",
  "legacy-oracle",
  "reference-assemblies.csproj",
);
const referenceAssemblyRoot = join(
  workspaceRoot,
  "tools",
  "legacy-oracle",
  ".packages",
  "microsoft.netframework.referenceassemblies.net40",
  "1.0.3",
  "build",
  ".NETFramework",
  "v4.0",
);
const artifactRoot = join(workspaceRoot, "artifacts", "oracle");
const outputRoot = join(artifactRoot, "bin");

function normalize(path) {
  return path.split(sep).join("/");
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} exited ${result.status}.`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (process.platform !== "win32") {
  throw new Error(
    "The .NET Framework 4.0 legacy oracle build is Windows-only.",
  );
}

run("dotnet", ["restore", toolProject, "--locked-mode"]);
if (!existsSync(join(referenceAssemblyRoot, "mscorlib.dll"))) {
  throw new Error(
    "Pinned .NET Framework 4.0 reference assemblies are missing.",
  );
}

mkdirSync(outputRoot, { recursive: true });
run(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  join(workspaceRoot, "scripts", "legacy", "inventory.mjs"),
  "--verify",
]);

const projects = [
  ["Base", "reference/psd48-master/PSDBase/Base.csproj", "Base.dll"],
  [
    "PSDClientZero",
    "reference/psd48-master/PSDClientZero/PSDClientZero.csproj",
    "PSDClientZero.exe",
  ],
  [
    "PSDGamepkg",
    "reference/psd48-master/PSDGamepkg/PSDGamepkg.csproj",
    "PSDGamepkg.exe",
  ],
];

for (const [name, projectPath] of projects) {
  const intermediateRoot = join(artifactRoot, "obj", name);
  mkdirSync(intermediateRoot, { recursive: true });
  run("dotnet", [
    "msbuild",
    join(workspaceRoot, projectPath),
    "/t:Build",
    "/p:Configuration=Release",
    "/p:Platform=AnyCPU",
    `/p:FrameworkPathOverride=${referenceAssemblyRoot}`,
    `/p:OutputPath=${outputRoot}${sep}`,
    `/p:IntermediateOutputPath=${intermediateRoot}${sep}`,
    `/p:BaseIntermediateOutputPath=${intermediateRoot}${sep}`,
    "/p:BuildProjectReferences=false",
    "/v:minimal",
  ]);
}

run(process.execPath, [
  "--disable-warning=ExperimentalWarning",
  join(workspaceRoot, "scripts", "legacy", "inventory.mjs"),
  "--verify",
]);

const output = projects.map(([, , fileName]) => {
  const path = join(outputRoot, fileName);
  if (!existsSync(path))
    throw new Error(`Expected output is missing: ${fileName}`);
  return {
    path: normalize(relative(workspaceRoot, path)),
    sha256: sha256(path),
  };
});

console.log("Legacy oracle minimum subset built without reference drift:");
for (const entry of output) console.log(`- ${entry.path} ${entry.sha256}`);
