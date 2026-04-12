#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const PACKAGES_ROOT = path.resolve(FRONTEND_ROOT, "..");
const BASELINE_PATH = path.join(
  SCRIPT_DIR,
  "no-antd-tooltip-imports-baseline.txt",
);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const IGNORE_DIRS = new Set([
  ".git",
  "dist",
  "e2e",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const ALWAYS_ALLOWED = new Set(["frontend/components/tip.tsx"]);
const PRINT_CURRENT = process.argv.includes("--print-current");

async function listSourceFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      out.push(...(await listSourceFiles(full)));
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    out.push(full);
  }
  return out;
}

function isTooltipModule(name) {
  return name === "antd/es/tooltip" || name === "antd/lib/tooltip";
}

function getTooltipImportLine(file, content) {
  const scriptKind =
    path.extname(file) === ".ts" || path.extname(file) === ".tsx"
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleName = statement.moduleSpecifier.text;
    const importClause = statement.importClause;
    if (importClause == null || importClause.isTypeOnly) continue;

    let hasTooltipImport = false;
    if (moduleName === "antd") {
      const namedBindings = importClause.namedBindings;
      if (namedBindings != null && ts.isNamedImports(namedBindings)) {
        hasTooltipImport = namedBindings.elements.some((element) => {
          const imported = element.propertyName?.text ?? element.name.text;
          return imported === "Tooltip";
        });
      }
    } else if (isTooltipModule(moduleName)) {
      if (importClause.name != null) {
        hasTooltipImport = true;
      } else if (
        importClause.namedBindings != null &&
        ts.isNamedImports(importClause.namedBindings)
      ) {
        hasTooltipImport = importClause.namedBindings.elements.some(
          (element) => {
            const imported = element.propertyName?.text ?? element.name.text;
            return imported === "Tooltip";
          },
        );
      } else if (
        importClause.namedBindings != null &&
        ts.isNamespaceImport(importClause.namedBindings)
      ) {
        hasTooltipImport = true;
      }
    }

    if (hasTooltipImport) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        statement.getStart(sourceFile),
      );
      return line + 1;
    }
  }

  return null;
}

async function loadBaseline() {
  const content = await fs.readFile(BASELINE_PATH, "utf8");
  return new Set(
    content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );
}

async function findTooltipImports() {
  const files = await listSourceFiles(FRONTEND_ROOT);
  const findings = [];
  for (const file of files) {
    const content = await fs.readFile(file, "utf8");
    const line = getTooltipImportLine(file, content);
    if (line == null) continue;
    findings.push({
      file: path.relative(PACKAGES_ROOT, file).replaceAll(path.sep, "/"),
      line,
    });
  }
  findings.sort((left, right) =>
    left.file === right.file
      ? left.line - right.line
      : left.file.localeCompare(right.file),
  );
  return findings;
}

async function main() {
  const findings = await findTooltipImports();
  const current = findings.filter(({ file }) => !ALWAYS_ALLOWED.has(file));

  if (PRINT_CURRENT) {
    for (const finding of current) {
      console.log(finding.file);
    }
    return;
  }

  const baseline = await loadBaseline();
  const currentFiles = new Set(current.map(({ file }) => file));
  const unexpected = current.filter(({ file }) => !baseline.has(file));
  const stale = [...baseline].filter((file) => !currentFiles.has(file));

  if (unexpected.length === 0 && stale.length === 0) {
    console.log(
      `No new raw antd Tooltip imports found (${current.length} grandfathered file(s); ${ALWAYS_ALLOWED.size} shared wrapper allowed).`,
    );
    return;
  }

  if (unexpected.length > 0) {
    console.error(
      "Found raw antd Tooltip imports that must use the shared tooltip wrapper instead:",
    );
    for (const finding of unexpected) {
      console.error(`- ${finding.file}:${finding.line}`);
    }
  }

  if (stale.length > 0) {
    if (unexpected.length > 0) {
      console.error("");
    }
    console.error(
      "The tooltip-import baseline is stale. Remove these paths from frontend/scripts/no-antd-tooltip-imports-baseline.txt:",
    );
    for (const file of stale) {
      console.error(`- ${file}`);
    }
  }

  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
