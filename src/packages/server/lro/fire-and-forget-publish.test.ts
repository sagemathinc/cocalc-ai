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

// The calls of a method chain `f(...).a(...).b(...)`, outermost first, down
// to the root call `f(...)`.
function callChain(expr: ts.Expression): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  let e = expr;
  for (;;) {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e)) return calls;
    calls.push(e);
    if (!ts.isPropertyAccessExpression(e.expression)) return calls;
    e = e.expression.expression;
  }
}

function isPublisherCall(call: ts.CallExpression | undefined): boolean {
  return (
    call != null &&
    ts.isIdentifier(call.expression) &&
    PUBLISHERS.has(call.expression.text)
  );
}

// The discarded promise is handled only if the chain's last call is
// `.catch(...)`; `.then` or `.finally` after it reject again.
function endsInCatch(calls: ts.CallExpression[]): boolean {
  const outer = calls[0]?.expression;
  return (
    outer != null &&
    ts.isPropertyAccessExpression(outer) &&
    outer.name.text === "catch"
  );
}

// Lines of `void publishLro...(...)...` whose rejection nothing handles.
function uncaughtPublishes(text: string): number[] {
  const file = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVoidExpression(node)) {
      const calls = callChain(node.expression);
      if (isPublisherCall(calls[calls.length - 1]) && !endsInCatch(calls)) {
        lines.push(
          file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        );
      }
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

  it("requires the chain to end in .catch", () => {
    expect(
      uncaughtPublishes(
        [
          "void publishLroEvent({}).then(() => {});",
          "void publishLroEvent({}).finally(() => {});",
          "void publishLroEvent({}).catch(() => {}).then(() => {});",
          "void publishLroEvent({}).then(() => {}).catch(() => {});",
          "void (publishLroSummary({}));",
          "void (publishLroSummary({})).catch(() => {});",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 5]);
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
