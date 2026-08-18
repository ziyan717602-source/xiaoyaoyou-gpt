import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const workspaceRoot = resolve(import.meta.dirname, "..", "..");
const referenceRoot = join(workspaceRoot, "reference", "psd48-master");
const snapshotPath = join(
  workspaceRoot,
  "docs",
  "legacy-evidence",
  "inventory.json",
);
const ignoredDirectoryNames = new Set(["bin", "obj", "Output", "log", "rec"]);

function normalize(path) {
  return path.split(sep).join("/");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function walk(directory) {
  const output = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function categoryFor(path) {
  const extension = extname(path).toLowerCase();
  if ([".cs", ".csproj", ".sln", ".config"].includes(extension)) {
    return "source";
  }
  if (extension === ".db3") return "database";
  if (extension === ".dll") return "assembly";
  if ([".png", ".jpg", ".jpeg", ".ico"].includes(extension)) {
    return "image";
  }
  if ([".ogg", ".wav", ".mp3"].includes(extension)) return "audio";
  if ([".md", ".txt", ".doc", ".docx", ".xml"].includes(extension)) {
    return "document";
  }
  return "other";
}

function firstTag(xml, name) {
  return xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, "u"))?.[1] ?? null;
}

function includes(xml, element) {
  return [...xml.matchAll(new RegExp(`<${element}\\s+Include="([^"]+)"`, "gu"))]
    .map((match) => normalize(match[1]))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function tagValues(xml, element) {
  return [...xml.matchAll(new RegExp(`<${element}>([^<]+)</${element}>`, "gu"))]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function referenceEntries(xml) {
  return [
    ...xml.matchAll(
      /<Reference\s+Include="([^"]+)"(?:\s*\/>|>([\s\S]*?)<\/Reference>)/gu,
    ),
  ]
    .map((match) => ({
      include: match[1],
      hintPath:
        match[2]
          ?.match(/<HintPath>([^<]+)<\/HintPath>/u)?.[1]
          ?.replaceAll("\\", "/") ?? null,
    }))
    .sort((left, right) => left.include.localeCompare(right.include, "en"));
}

function projectReferenceEntries(xml) {
  return [
    ...xml.matchAll(
      /<ProjectReference\s+Include="([^"]+)"[^>]*>([\s\S]*?)<\/ProjectReference>/gu,
    ),
  ]
    .map((match) => ({
      include: normalize(match[1]),
      name: match[2].match(/<Name>([^<]+)<\/Name>/u)?.[1] ?? null,
    }))
    .sort((left, right) => left.include.localeCompare(right.include, "en"));
}

function inspectProjects(files) {
  return files
    .filter((entry) => entry.path.endsWith(".csproj"))
    .map((entry) => {
      const absolutePath = join(referenceRoot, entry.path);
      const xml = readFileSync(absolutePath, "utf8");
      return {
        path: entry.path,
        assemblyName: firstTag(xml, "AssemblyName"),
        rootNamespace: firstTag(xml, "RootNamespace"),
        outputType: firstTag(xml, "OutputType"),
        targetFramework: firstTag(xml, "TargetFrameworkVersion"),
        platformTargets: tagValues(xml, "PlatformTarget"),
        compileFiles: includes(xml, "Compile"),
        resourceFiles: [
          ...new Set([
            ...includes(xml, "Resource"),
            ...includes(xml, "Content"),
            ...includes(xml, "EmbeddedResource"),
          ]),
        ].sort((left, right) => left.localeCompare(right, "en")),
        references: referenceEntries(xml),
        projectReferences: projectReferenceEntries(xml),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function inspectSolution() {
  const path = join(referenceRoot, "psd.sln");
  const text = readFileSync(path, "utf8");
  const projects = [
    ...text.matchAll(
      /^Project\("[^"]+"\) = "([^"]+)", "([^"]+)", "([^"]+)"/gmu,
    ),
  ].map((match) => {
    const projectPath = normalize(match[2]);
    return {
      name: match[1],
      path: projectPath,
      guid: match[3].toLowerCase(),
      present: existsSync(join(referenceRoot, projectPath)),
    };
  });
  return {
    path: "psd.sln",
    formatVersion:
      text.match(/Solution File, Format Version ([^\r\n]+)/u)?.[1] ?? null,
    visualStudioVersion:
      text.match(/^VisualStudioVersion = ([^\r\n]+)/mu)?.[1] ?? null,
    projects,
    missingProjects: projects.filter((project) => !project.present),
  };
}

function quoteIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

function inspectDatabase(entry) {
  const absolutePath = join(referenceRoot, entry.path);
  const database = new DatabaseSync(absolutePath, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON");
    const objects = database
      .prepare(
        "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    return {
      path: entry.path,
      sha256: entry.sha256,
      bytes: entry.bytes,
      applicationId: database.prepare("PRAGMA application_id").get()
        .application_id,
      userVersion: database.prepare("PRAGMA user_version").get().user_version,
      pageSize: database.prepare("PRAGMA page_size").get().page_size,
      objects: objects.map((object) => {
        const columns = database
          .prepare(`PRAGMA table_info(${quoteIdentifier(object.name)})`)
          .all()
          .map((column) => ({
            cid: Number(column.cid),
            name: String(column.name),
            type: String(column.type),
            notNull: Number(column.notnull) === 1,
            defaultValue:
              column.dflt_value === null ? null : String(column.dflt_value),
            primaryKeyPosition: Number(column.pk),
          }));
        const rowCount =
          object.type === "table"
            ? Number(
                database
                  .prepare(
                    `SELECT COUNT(*) AS count FROM ${quoteIdentifier(object.name)}`,
                  )
                  .get().count,
              )
            : null;
        return {
          name: String(object.name),
          type: String(object.type),
          rowCount,
          columns,
          createSql: object.sql === null ? null : String(object.sql),
        };
      }),
    };
  } finally {
    database.close();
  }
}

function buildInventory() {
  if (!existsSync(referenceRoot)) {
    throw new Error(
      "Local reference/psd48-master is required for oracle inventory verification.",
    );
  }
  const files = walk(referenceRoot)
    .map((absolutePath) => {
      const content = readFileSync(absolutePath);
      return {
        path: normalize(relative(referenceRoot, absolutePath)),
        bytes: statSync(absolutePath).size,
        sha256: sha256(content),
        category: categoryFor(absolutePath),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const categorySummary = Object.entries(
    Object.groupBy(files, (entry) => entry.category),
  )
    .map(([category, entries]) => ({
      category,
      files: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    }))
    .sort((left, right) => left.category.localeCompare(right.category, "en"));
  const extensionSummary = Object.entries(
    Object.groupBy(
      files,
      (entry) => extname(entry.path).toLowerCase() || "<none>",
    ),
  )
    .map(([extension, entries]) => ({
      extension,
      files: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    }))
    .sort((left, right) => left.extension.localeCompare(right.extension, "en"));
  const databases = files
    .filter((entry) => entry.category === "database")
    .map(inspectDatabase);

  return {
    schemaVersion: 1,
    sourceRoot: "reference/psd48-master",
    ignoredGeneratedDirectories: [...ignoredDirectoryNames].sort(),
    totalFiles: files.length,
    totalBytes: files.reduce((total, entry) => total + entry.bytes, 0),
    aggregateSha256: sha256(
      files
        .map((entry) => `${entry.path}\0${entry.bytes}\0${entry.sha256}\n`)
        .join(""),
    ),
    categorySummary,
    extensionSummary,
    solution: inspectSolution(),
    projects: inspectProjects(files),
    databases,
    files,
  };
}

const mode = process.argv[2] ?? "--verify";
const serialized = JSON.stringify(buildInventory(), null, 2) + "\n";

if (mode === "--write") {
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, serialized, "utf8");
  console.log(`Wrote ${normalize(relative(workspaceRoot, snapshotPath))}.`);
} else if (mode === "--verify") {
  if (!existsSync(snapshotPath)) {
    throw new Error(
      "Inventory snapshot is missing; run npm run oracle:refresh-inventory.",
    );
  }
  const expected = readFileSync(snapshotPath, "utf8");
  if (expected !== serialized) {
    throw new Error(
      "Legacy reference inventory drifted. Preserve the old snapshot as evidence and investigate before refreshing it.",
    );
  }
  const inventory = JSON.parse(serialized);
  console.log(
    `Legacy inventory verified: ${inventory.totalFiles} files, ${inventory.projects.length} projects, ${inventory.databases[0]?.objects.length ?? 0} SQLite objects, aggregate ${inventory.aggregateSha256}.`,
  );
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
