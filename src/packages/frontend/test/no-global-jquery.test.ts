/** @jest-environment node */

import { readdirSync } from "fs";
import { join, relative } from "path";
import ts from "typescript";

const root = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (
      [
        "node_modules",
        "dist",
        ".git",
        "test",
        "__test__",
        "__tests__",
        "playwright",
      ].includes(entry.name)
    )
      return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) && !/\.(?:test|spec|d)\.tsx?$/.test(path)
      ? [path]
      : [];
  });
}

it("binds jQuery calls locally rather than relying on bundle initialization order", () => {
  // Resolve lexical bindings, but deliberately omit ambient jQuery declarations.
  // Merely installing @types/jquery must not make an undeclared browser global safe.
  const program = ts.createProgram(sourceFiles(root), {
    noResolve: true,
    noLib: true,
    types: [],
    jsx: ts.JsxEmit.Preserve,
  });
  const checker = program.getTypeChecker();
  const unbound: string[] = [];
  for (const source of program.getSourceFiles()) {
    function visit(node: ts.Node): void {
      if (
        ts.isIdentifier(node) &&
        ["$", "jQuery"].includes(node.text) &&
        ((ts.isCallExpression(node.parent) &&
          node.parent.expression === node) ||
          (ts.isPropertyAccessExpression(node.parent) &&
            node.parent.expression === node))
      ) {
        const declarations = checker.getSymbolAtLocation(node)?.declarations;
        if (
          !declarations?.some(
            (declaration) =>
              declaration.getSourceFile() === source &&
              !declaration.getSourceFile().isDeclarationFile,
          )
        ) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          unbound.push(
            `${relative(root, source.fileName)}:${line + 1}: ${node.text}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(unbound).toEqual([]);
}, 30000);
