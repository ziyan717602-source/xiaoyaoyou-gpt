import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Ajv2020 from "ajv/dist/2020.js";

const workspaceRoot = resolve(import.meta.dirname, "..");
const referenceRoot = join(workspaceRoot, "reference", "psd48-master");
const databasePath = join(referenceRoot, "~ex-lib", "psd.db3");
const inventoryPath = join(
  workspaceRoot,
  "docs",
  "legacy-evidence",
  "inventory.json",
);
const schemaPath = join(workspaceRoot, "catalog", "catalog.schema.json");
const catalogPath = join(workspaceRoot, "catalog", "catalog.json");
const reportPath = join(workspaceRoot, "catalog", "report.md");
const databaseSource = "reference/psd48-master/~ex-lib/psd.db3";
const packageNames = new Map([
  [1, "standard"],
  [2, "fengmingyushi"],
]);
const ignoredSourceDirectories = new Set([
  "bin",
  "obj",
  "Output",
  "log",
  "rec",
]);
const scopeAliases = new Map([
  ["Hero:10303", ["龙葵"]],
  ["Hero:10304", ["龙葵鬼"]],
]);
const tableBindings = {
  Aas: {
    path: "reference/psd48-master/PSDBase/SKBranch.cs",
    line: 107,
    symbol: "GetAas",
    role: "loader",
  },
  Hero: {
    path: "reference/psd48-master/PSDBase/Card/Hero.cs",
    line: 121,
    symbol: "HeroLib",
    role: "loader",
  },
  Skill: {
    path: "reference/psd48-master/PSDBase/Skill.cs",
    line: 201,
    symbol: "SkillLib",
    role: "loader",
  },
  Tux: {
    path: "reference/psd48-master/PSDBase/Card/Tux.cs",
    line: 206,
    symbol: "TuxLib",
    role: "loader",
  },
  Exsp: {
    path: "reference/psd48-master/PSDBase/Card/Exsp.cs",
    line: 38,
    symbol: "ExspLib",
    role: "loader",
  },
  Monster: {
    path: "reference/psd48-master/PSDBase/Card/Monster.cs",
    line: 299,
    symbol: "MonsterLib",
    role: "loader",
  },
  Npc: {
    path: "reference/psd48-master/PSDBase/Card/Npc.cs",
    line: 78,
    symbol: "NPCLib",
    role: "loader",
  },
  NJ: {
    path: "reference/psd48-master/PSDBase/NCAction.cs",
    line: 87,
    symbol: "NCActionLib",
    role: "loader",
  },
  Eve: {
    path: "reference/psd48-master/PSDBase/Card/Evenement.cs",
    line: 138,
    symbol: "EvenementLib",
    role: "loader",
  },
  Rune: {
    path: "reference/psd48-master/PSDBase/Rune.cs",
    line: 69,
    symbol: "RuneLib",
    role: "loader",
  },
  Five: {
    path: "reference/psd48-master/PSDBase/Card/FiveElement.cs",
    line: 54,
    symbol: "Int2Elem",
    role: "mapper",
  },
  Ops: {
    path: "reference/psd48-master/PSDBase/Operation.cs",
    line: 81,
    symbol: "OperationLib",
    role: "loader",
  },
};

const tableSpecs = {
  Aas: {
    kind: "configuration",
    idColumn: "ID",
    code: (row) => `aas-${row.AKEY}`,
    name: (row) => row.COMMENT || `Aas ${row.AKEY}`,
    textColumns: ["COMMENT"],
  },
  Hero: {
    kind: "hero",
    idColumn: "ID",
    code: (row) => row.OFCODE,
    name: (row) => row.NAME,
    textColumns: ["BIO"],
  },
  Skill: {
    kind: "skill",
    idColumn: "ID",
    code: (row) => row.CODE,
    name: (row) => row.NAME,
    textColumns: ["DESCRIPE"],
  },
  Tux: {
    kind: "card",
    idColumn: "ID",
    code: (row) => row.CODE,
    name: (row) => row.NAME,
    textColumns: ["DESCRIPTION", "SPECIAL"],
  },
  Exsp: {
    kind: "special-card",
    idColumn: "SID",
    code: (row) => row.CODE,
    name: (row) => row.NAME,
    textColumns: ["DESC"],
  },
  Monster: {
    kind: "monster",
    idColumn: "ID",
    code: (row) => row.CODE,
    name: (row) => row.NAME,
    textColumns: ["DEBUTTEXT", "PETTEXT", "WINTEXT"],
  },
  Npc: {
    kind: "npc",
    idColumn: "ID",
    code: (row) => row.Code,
    name: (row) => row.NAME,
    textColumns: ["DEBUTTEXT"],
  },
  NJ: {
    kind: "npc-action",
    idColumn: "ID",
    code: (row) => row.Code,
    name: (row) => row.Name,
    textColumns: ["INTRO", "ESCUE"],
  },
  Eve: {
    kind: "event",
    idColumn: "ID",
    code: (row) => row.CODE,
    name: (row) => row.NAME,
    textColumns: ["BACKGROUND", "EFFECT"],
  },
  Rune: {
    kind: "rune",
    idColumn: "ID",
    code: (row) => row.CODE,
    name: (row) => row.NAME,
    textColumns: ["DESC"],
  },
  Five: {
    kind: "five-element",
    idColumn: "ID",
    code: (row) => row.CODE,
    name: (row) => row.XING,
    textColumns: ["SCRIPT"],
  },
  Ops: {
    kind: "operation",
    idColumn: "CODE",
    code: (row) => row.CODE,
    name: (row) => row.NAME,
    textColumns: [],
  },
};

function normalize(path) {
  return path.split(sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function splitCodes(value) {
  return String(value ?? "")
    .split(/[|,&]/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function packageIdFromValid(value) {
  const packageId = Number(String(value ?? "").split(",")[0]);
  return packageNames.has(packageId) ? packageId : null;
}

function tuxCopies(row) {
  const values = String(row.COUNT ?? "")
    .split(",")
    .map(Number);
  const copies = [];
  for (let index = 0; index + 2 < values.length; index += 3) {
    const packageName = packageNames.get(values[index]);
    if (!packageName) continue;
    const serials = [];
    for (
      let serial = values[index + 1];
      serial <= values[index + 2];
      serial += 1
    ) {
      serials.push(serial);
    }
    copies.push({ package: packageName, serials });
  }
  return copies;
}

function canonicalId(kind, code) {
  const suffix = String(code)
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  if (!suffix)
    throw new Error(`Cannot derive canonical id for ${kind}:${code}.`);
  return `xyy.${kind}.${suffix}`;
}

function walkSource(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredSourceDirectories.has(entry.name))
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkSource(path));
    else if (entry.isFile() && entry.name.endsWith(".cs")) files.push(path);
  }
  return files;
}

function methodBindings() {
  const methods = [];
  const declaration =
    /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:[\w<>,.\[\]?]+\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/u;
  for (const path of walkSource(referenceRoot)) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      const symbol = line.match(declaration)?.[1];
      if (symbol) {
        methods.push({
          path: normalize(relative(workspaceRoot, path)),
          line: index + 1,
          symbol,
          role: "handler",
        });
      }
    });
  }
  return methods.sort((left, right) =>
    `${left.path}:${String(left.line).padStart(6, "0")}`.localeCompare(
      `${right.path}:${String(right.line).padStart(6, "0")}`,
      "en",
    ),
  );
}

function packagesForValid(row) {
  const packageId = packageIdFromValid(row.VALID);
  return packageId === null ? [] : [packageNames.get(packageId)];
}

function packagesForGenre(row) {
  const packageName = packageNames.get(Number(row.GENRE));
  return packageName ? [packageName] : [];
}

function rowMapByCode(rows, spec) {
  return new Map(rows.map((row) => [String(spec.code(row)), row]));
}

function unionPackages(entries) {
  return [...new Set(entries.flat())].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

function buildCatalog() {
  if (!existsSync(databasePath) || !existsSync(inventoryPath)) {
    throw new Error(
      "Local reference snapshot and legacy inventory are required to regenerate the catalog.",
    );
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec("PRAGMA query_only = ON");
  const rows = {};
  try {
    for (const table of Object.keys(tableSpecs)) {
      rows[table] = database.prepare(`SELECT * FROM "${table}"`).all();
    }
  } finally {
    database.close();
  }

  const selected = {};
  selected.Aas = rows.Aas;
  selected.Hero = rows.Hero.filter((row) => packagesForValid(row).length > 0);
  const heroPackagesById = new Map(
    selected.Hero.map((row) => [String(row.ID), packagesForGenre(row)]),
  );
  const skillPackagesByCode = new Map();
  for (const hero of selected.Hero) {
    for (const code of splitCodes(hero.SKILL)) {
      skillPackagesByCode.set(
        code,
        unionPackages([
          skillPackagesByCode.get(code) ?? [],
          packagesForGenre(hero),
        ]),
      );
    }
  }
  selected.Skill = rows.Skill.filter((row) =>
    skillPackagesByCode.has(row.CODE),
  );
  selected.Tux = rows.Tux.filter((row) => tuxCopies(row).length > 0);
  selected.Exsp = rows.Exsp.filter((row) =>
    heroPackagesById.has(String(row.HERO)),
  );
  for (const specialCard of selected.Exsp) {
    for (const code of splitCodes(specialCard.SKILL)) {
      skillPackagesByCode.set(
        code,
        unionPackages([
          skillPackagesByCode.get(code) ?? [],
          heroPackagesById.get(String(specialCard.HERO)) ?? [],
        ]),
      );
    }
  }
  selected.Skill = rows.Skill.filter((row) =>
    skillPackagesByCode.has(row.CODE),
  );
  selected.Monster = rows.Monster.filter(
    (row) => packagesForValid(row).length > 0,
  );
  selected.Npc = rows.Npc.filter((row) => packagesForValid(row).length > 0);
  const npcActionPackages = new Map();
  for (const npc of selected.Npc) {
    for (const code of splitCodes(npc.ACTION)) {
      npcActionPackages.set(
        code,
        unionPackages([
          npcActionPackages.get(code) ?? [],
          packagesForValid(npc),
        ]),
      );
    }
  }
  selected.NJ = rows.NJ.filter((row) => npcActionPackages.has(row.Code));
  selected.Eve = rows.Eve.filter((row) => packagesForValid(row).length > 0);
  selected.Rune = rows.Rune;
  selected.Five = rows.Five;
  selected.Ops = rows.Ops;

  const methods = methodBindings();
  const items = [];
  const itemRows = new Map();
  for (const [table, tableRows] of Object.entries(selected)) {
    const spec = tableSpecs[table];
    for (const row of tableRows) {
      const code = String(spec.code(row));
      let packages;
      if (["Aas", "Rune", "Five", "Ops"].includes(table)) {
        packages = ["shared-core"];
      } else if (table === "Tux") {
        packages = packagesForGenre(row);
      } else if (table === "Skill") {
        packages = skillPackagesByCode.get(code) ?? [];
      } else if (table === "Exsp") {
        packages = heroPackagesById.get(String(row.HERO)) ?? [];
      } else if (table === "NJ") {
        packages = npcActionPackages.get(code) ?? [];
      } else {
        packages = packagesForGenre(row);
      }
      packages = unionPackages([packages]);
      const id = canonicalId(spec.kind, code);
      const bindings = [
        tableBindings[table],
        ...methods.filter((method) => method.symbol.startsWith(code)),
      ];
      const item = {
        canonicalId: id,
        kind: spec.kind,
        name: String(spec.name(row)),
        aliases: scopeAliases.get(`${table}:${row[spec.idColumn]}`) ?? [],
        packages,
        legacyIds: {
          table,
          rowId: row[spec.idColumn],
          code,
          physicalCopies: table === "Tux" ? tuxCopies(row) : [],
          protocolCodes: table === "Aas" ? [] : [code],
        },
        source: {
          path: databaseSource,
          line: null,
          symbol: `${table}:${row[spec.idColumn]}`,
        },
        textEvidence: spec.textColumns.map((column) => ({
          table,
          column,
          sha256: sha256(String(row[column] ?? "")),
        })),
        bindings,
        dependencies: {
          contentIds: [],
          primitives: ["unclassified"],
          hiddenInformation: "unknown",
          uiChoices: ["unclassified"],
        },
        evidenceGrade: bindings.some((binding) => binding.role === "handler")
          ? "A"
          : "B",
        ruleStatus: "pending-evidence",
        migrationStatus: "unplanned",
        scenarioCoverage: [],
      };
      items.push(item);
      itemRows.set(id, row);
    }
  }

  const idByLegacyCode = new Map(
    items.map((item) => [item.legacyIds.code, item.canonicalId]),
  );
  const heroIdToCanonical = new Map(
    items
      .filter((item) => item.kind === "hero")
      .map((item) => [String(item.legacyIds.rowId), item.canonicalId]),
  );
  for (const item of items) {
    const row = itemRows.get(item.canonicalId);
    const dependencyIds = new Set();
    for (const value of Object.values(row)) {
      for (const token of String(value ?? "").match(/[A-Z][A-Z0-9]{2,}/gu) ??
        []) {
        const dependencyId = idByLegacyCode.get(token);
        if (dependencyId && dependencyId !== item.canonicalId) {
          dependencyIds.add(dependencyId);
        }
      }
    }
    if (item.kind === "hero") {
      for (const legacyHeroId of `${row.SPOUSE ?? ""},${row.ISO ?? ""}`.match(
        /\d{5}/gu,
      ) ?? []) {
        const dependencyId = heroIdToCanonical.get(legacyHeroId);
        if (dependencyId && dependencyId !== item.canonicalId) {
          dependencyIds.add(dependencyId);
        }
      }
    }
    if (item.kind === "npc") {
      const dependencyId = heroIdToCanonical.get(String(row.ORG));
      if (dependencyId) dependencyIds.add(dependencyId);
    }
    if (item.kind === "special-card") {
      const dependencyId = heroIdToCanonical.get(String(row.HERO));
      if (dependencyId) dependencyIds.add(dependencyId);
    }
    item.dependencies.contentIds = [...dependencyIds].sort((left, right) =>
      left.localeCompare(right, "en"),
    );
  }

  items.sort((left, right) =>
    left.canonicalId.localeCompare(right.canonicalId, "en"),
  );
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const selectionRules = {
    Aas: "all rows; shared runtime card-set configuration",
    Hero: "first integer in VALID is legacy package 1 or 2",
    Skill: "referenced by selected Hero.SKILL or selected Exsp.SKILL",
    Tux: "COUNT triplet package id is 1 or 2; serial range retained",
    Exsp: "HERO references a selected standard or fengmingyushi hero",
    Monster: "VALID is legacy package 1 or 2",
    Npc: "VALID is legacy package 1 or 2",
    NJ: "referenced by selected Npc.ACTION",
    Eve: "VALID is legacy package 1 or 2",
    Rune: "all rows; no package column, provisionally shared core",
    Five: "all rows; no package column, provisionally shared core",
    Ops: "all rows; no package column, provisionally shared core",
  };
  const reconciliation = Object.keys(tableSpecs).map((table) => ({
    table,
    totalRows: rows[table].length,
    selectedRows: selected[table].length,
    excludedRows: rows[table].length - selected[table].length,
    selectionRule: selectionRules[table],
  }));

  return {
    schemaVersion: 1,
    rulesetId: "standard+fengmingyushi",
    sourceSnapshotSha256: inventory.aggregateSha256,
    packageRule: {
      legacyLevel: 4,
      legacyPackageIds: [1, 2],
      selectionEvidence:
        "RuleCode.LEVEL_STD = 4 and Card.Level2Pkg(4) = [1,2] in PSDBase/Card/Card.cs:33-47",
      ownershipRule: {
        standardGenre: 1,
        fengmingyushiGenre: 2,
        evidence:
          "PSDClientAo/Request/Hour.xaml.cs:71-89 labels hero GENRE 1 as standard and GENRE 2 as fengmingyushi; the same GENRE ownership column exists on scoped Tux, Monster, Npc, and Eve rows.",
      },
    },
    reconciliation,
    items,
    discrepancies: [
      {
        id: "CAT-001",
        status: "provisional-autonomous",
        summary:
          "Global, training, and out-of-scope-hero Exsp rows have no package column.",
        affectedLegacyIds: ["Exsp:global-or-out-of-scope"],
        provisionalDecision:
          "Include only Exsp rows whose HERO points to a selected package-1 or package-2 hero; keep the remainder excluded until scenario evidence requires one.",
      },
      {
        id: "CAT-002",
        status: "provisional-autonomous",
        summary:
          "Rune, Five, Ops, and Aas have no legacy package ownership column.",
        affectedLegacyIds: ["Rune:*", "Five:*", "Ops:*", "Aas:*"],
        provisionalDecision:
          "Treat these runtime rule/configuration rows as shared core and verify their actual dependencies during P04 semantics work.",
      },
      {
        id: "CAT-003",
        status: "resolved",
        summary:
          "VALID/COUNT and GENRE encode different package concerns and cannot substitute for each other.",
        affectedLegacyIds: [
          "Hero:GENRE",
          "Tux:GENRE",
          "Monster:GENRE",
          "Npc:GENRE",
          "Eve:GENRE",
        ],
        provisionalDecision:
          "Use Card.Level2Pkg plus VALID/COUNT for enabled scope, then GENRE 1/2 for standard/fengmingyushi product ownership as shown by the old package UI.",
      },
      {
        id: "CAT-004",
        status: "resolved",
        summary:
          "The prior scope.md calls the two fengmingyushi forms 龙葵 and 龙葵鬼, while the database calls them 龙葵·蓝 and 龙葵·红.",
        affectedLegacyIds: ["Hero:10303", "Hero:10304"],
        provisionalDecision:
          "Use database names as canonical display names and retain the scope.md names as searchable aliases.",
      },
    ],
  };
}

function validateCatalog(catalog) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  });
  const validate = ajv.compile(schema);
  if (!validate(catalog)) {
    throw new Error(
      `Catalog schema validation failed:\n${JSON.stringify(validate.errors, null, 2)}`,
    );
  }

  const ids = catalog.items.map((item) => item.canonicalId);
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate canonicalId found.");
  const sortedIds = [...ids].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  if (JSON.stringify(ids) !== JSON.stringify(sortedIds)) {
    throw new Error("Catalog items must be sorted by canonicalId.");
  }
  const knownIds = new Set(ids);
  for (const item of catalog.items) {
    const expectedId = canonicalId(item.kind, item.legacyIds.code);
    if (item.canonicalId !== expectedId) {
      throw new Error(
        `${item.canonicalId} does not match stable id rule ${expectedId}.`,
      );
    }
    for (const dependencyId of item.dependencies.contentIds) {
      if (!knownIds.has(dependencyId)) {
        throw new Error(
          `${item.canonicalId} references unknown dependency ${dependencyId}.`,
        );
      }
      if (dependencyId === item.canonicalId) {
        throw new Error(`${item.canonicalId} cannot depend on itself.`);
      }
    }
  }
  const itemCountByTable = Object.groupBy(
    catalog.items,
    (item) => item.legacyIds.table,
  );
  for (const entry of catalog.reconciliation) {
    if (entry.totalRows !== entry.selectedRows + entry.excludedRows) {
      throw new Error(`${entry.table} reconciliation does not add up.`);
    }
    if ((itemCountByTable[entry.table]?.length ?? 0) !== entry.selectedRows) {
      throw new Error(
        `${entry.table} selected row count does not match catalog items.`,
      );
    }
  }
  const physicalSerials = new Set();
  for (const item of catalog.items) {
    for (const copyGroup of item.legacyIds.physicalCopies) {
      for (const serial of copyGroup.serials) {
        const key = `${copyGroup.package}:${serial}`;
        if (physicalSerials.has(key))
          throw new Error(`Duplicate physical serial ${key}.`);
        physicalSerials.add(key);
      }
    }
  }
  const discrepancyIds = catalog.discrepancies.map((entry) => entry.id);
  if (new Set(discrepancyIds).size !== discrepancyIds.length) {
    throw new Error("Duplicate catalog discrepancy id found.");
  }
  return {
    items: catalog.items.length,
    dependencies: catalog.items.reduce(
      (total, item) => total + item.dependencies.contentIds.length,
      0,
    ),
    bindings: catalog.items.reduce(
      (total, item) => total + item.bindings.length,
      0,
    ),
    physicalSerials: physicalSerials.size,
  };
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/gu, " ");
}

function buildReport(catalog) {
  const kinds = [...new Set(catalog.items.map((item) => item.kind))].sort(
    (left, right) => left.localeCompare(right, "en"),
  );
  const count = (predicate) => catalog.items.filter(predicate).length;
  const lines = [
    "# 标准包 + 凤鸣玉誓迁移目录报告",
    "",
    "> 本文件由 `npm run catalog:refresh` 确定性生成。完整条目、来源哈希与依赖见 `catalog.json`。",
    "",
    `- 规则集：\`${catalog.rulesetId}\``,
    `- 来源快照 SHA-256：\`${catalog.sourceSnapshotSha256}\``,
    `- 范围规则：旧版 level ${catalog.packageRule.legacyLevel} 启用包 ${catalog.packageRule.legacyPackageIds.join(", ")}；\`VALID/COUNT\` 决定纳入范围，\`GENRE\` 决定标准/凤鸣归属。`,
    `- 映射条目：${catalog.items.length}；C# 方法绑定：${catalog.items.reduce((total, item) => total + item.bindings.length, 0)}；内容依赖：${catalog.items.reduce((total, item) => total + item.dependencies.contentIds.length, 0)}。`,
    "",
    "## 按类型与归属统计",
    "",
    "| 类型 | 总数 | 标准包 | 凤鸣玉誓 | 共享核心 |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const kind of kinds) {
    lines.push(
      `| ${kind} | ${count((item) => item.kind === kind)} | ${count((item) => item.kind === kind && item.packages.includes("standard"))} | ${count((item) => item.kind === kind && item.packages.includes("fengmingyushi"))} | ${count((item) => item.kind === kind && item.packages.includes("shared-core"))} |`,
    );
  }
  lines.push(
    `| **合计** | **${catalog.items.length}** | **${count((item) => item.packages.includes("standard"))}** | **${count((item) => item.packages.includes("fengmingyushi"))}** | **${count((item) => item.packages.includes("shared-core"))}** |`,
    "",
    "## 34 名范围角色（旧 scope.md 对账）",
    "",
    "| 归属 | 数量 | 角色 |",
    "| --- | ---: | --- |",
  );
  for (const packageName of ["standard", "fengmingyushi"]) {
    const heroes = catalog.items.filter(
      (item) => item.kind === "hero" && item.packages.includes(packageName),
    );
    lines.push(
      `| ${packageName} | ${heroes.length} | ${heroes.map((item) => markdownCell(item.name)).join("、")} |`,
    );
  }
  lines.push(
    "",
    "## 12 张 SQLite 表逐表对账",
    "",
    "| 表 | 总行数 | 纳入 | 排除 | 选择规则 |",
    "| --- | ---: | ---: | ---: | --- |",
  );
  for (const entry of catalog.reconciliation) {
    lines.push(
      `| ${entry.table} | ${entry.totalRows} | ${entry.selectedRows} | ${entry.excludedRows} | ${markdownCell(entry.selectionRule)} |`,
    );
  }
  lines.push("", "## 差异与临时决定", "");
  for (const discrepancy of catalog.discrepancies) {
    lines.push(
      `- **${discrepancy.id} · ${discrepancy.status}**：${discrepancy.summary} ${discrepancy.provisionalDecision ?? ""}`.trimEnd(),
    );
  }
  lines.push(
    "",
    "## 当前证据边界",
    "",
    `- 证据 A（数据库行 + 专用 C# 方法绑定）：${count((item) => item.evidenceGrade === "A")} 项；证据 B（数据库行，暂无专用方法）：${count((item) => item.evidenceGrade === "B")} 项。`,
    "- 结算原语、隐藏信息与 UI 选择仍标记为 `unclassified/unknown`；这是 P03 后续依赖分类工作，不以空白冒充完成。",
    "- 公开仓库只保留描述列 SHA-256、表/列定位和 C# 符号，不复制本地参考包的完整规则文本或二进制资源。",
    "",
  );
  return lines.join("\n");
}

const mode = process.argv[2] ?? "--verify";
if (mode === "--write") {
  const catalog = buildCatalog();
  const summary = validateCatalog(catalog);
  writeFileSync(catalogPath, serialize(catalog), "utf8");
  writeFileSync(reportPath, buildReport(catalog), "utf8");
  console.log(
    `Wrote catalog/catalog.json and catalog/report.md with ${summary.items} items.`,
  );
} else if (mode === "--oracle-verify") {
  if (!existsSync(catalogPath))
    throw new Error("catalog/catalog.json is missing.");
  const generated = buildCatalog();
  const summary = validateCatalog(generated);
  if (readFileSync(catalogPath, "utf8") !== serialize(generated)) {
    throw new Error(
      "Catalog drifted from the local C#/SQLite oracle; run npm run catalog:refresh.",
    );
  }
  if (
    !existsSync(reportPath) ||
    readFileSync(reportPath, "utf8") !== buildReport(generated)
  ) {
    throw new Error("Catalog report drifted; run npm run catalog:refresh.");
  }
  console.log(
    `Oracle catalog verified: ${summary.items} items, ${summary.dependencies} dependencies, ${summary.bindings} C# bindings, ${summary.physicalSerials} physical card serials.`,
  );
} else if (mode === "--verify") {
  if (!existsSync(catalogPath))
    throw new Error("catalog/catalog.json is missing.");
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const summary = validateCatalog(catalog);
  if (
    !existsSync(reportPath) ||
    readFileSync(reportPath, "utf8") !== buildReport(catalog)
  ) {
    throw new Error("Catalog report drifted; run npm run catalog:refresh.");
  }
  console.log(
    `Catalog verified: ${summary.items} items, ${summary.dependencies} dependencies, ${summary.bindings} C# bindings, ${summary.physicalSerials} physical card serials.`,
  );
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
