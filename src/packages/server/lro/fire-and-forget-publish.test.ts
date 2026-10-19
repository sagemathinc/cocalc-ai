/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// LRO progress publishes are fire-and-forget, so nothing awaits them. A
// publish that times out (e.g. while a course collect floods the persist
// server) then rejects with nobody listening, and the hub logs it as an
// unhandled rejection. Every `void publishLro...(...)` must end in `.catch(`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..");
const SKIP = new Set(["node_modules", "dist", "dist-ts"]);
const PUBLISHERS = new Set(["publishLroEvent", "publishLroSummary"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

// `publish(...).catch(handler)`: the call is the object of a `.catch` that is
// itself called.
function isCaught(call: ts.CallExpression): boolean {
  const access = call.parent;
  return (
    ts.isPropertyAccessExpression(access) &&
    access.expression === call &&
    access.name.text === "catch" &&
    ts.isCallExpression(access.parent) &&
    access.parent.expression === access
  );
}

// Lines of `void publishLro...(...)` calls whose rejection nothing handles.
function uncaughtPublishes(text: string): number[] {
  const file = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      PUBLISHERS.has(node.expression.text) &&
      ts.isVoidExpression(node.parent) &&
      !isCaught(node)
    ) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

describe("fire-and-forget LRO publishes", () => {
  it("detects a void publish without a catch", () => {
    expect(
      uncaughtPublishes(
        "void publishLroEvent({ a: f(1) });\nvoid publishLroSummary({}).catch(() => {});\n",
      ),
    ).toEqual([1]);
  });

  it("is not fooled by parentheses in strings or comments", () => {
    expect(
      uncaughtPublishes(
        [
          'void publishLroEvent({ message: ")" }).catch(() => {});',
          'void publishLroEvent({ message: ").catch(" });',
          "void publishLroEvent({ a: 1 /* ).catch( */ });",
          "// void publishLroEvent({});",
        ].join("\n"),
      ),
    ).toEqual([2, 3]);
  });

  it("always handle rejection", () => {
    const offenders = sources(ROOT).flatMap((path) =>
      uncaughtPublishes(readFileSync(path, "utf8")).map(
        (line) => `${relative(ROOT, path)}:${line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
