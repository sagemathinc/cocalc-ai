/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// LRO progress publishes are fire-and-forget, so nothing awaits them. A
// publish that times out (e.g. while a course collect floods the persist
// server) then rejects with nobody listening, and the hub logs it as an
// unhandled rejection. Every `publishLro...(...)` whose promise is thrown
// away (`void`, a bare statement, a branch of && or ?: that is) must end
// in `.catch(`.

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

const PASS_THROUGH = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.CommaToken,
]);

// `Promise.all(...)` and friends: the combinator's name, else undefined.
function promiseCombinator(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "Promise" &&
    ["all", "allSettled", "race", "any"].includes(callee.name.text)
  )
    return callee.name.text;
  return undefined;
}

// Whether a publish call's promise can reject with nothing to handle it.
// Follow the promise up: through parentheses, type assertions, method calls
// on it (`.then`, `.catch`, ...), a branch of ?:, the right side of && ?? ||
// and comma, array and object literals, and Promise.all/race/any. It is
// handed to someone else if it ends up awaited, returned, assigned or passed
// to a function. Anywhere else (void, a bare statement, a condition, the
// left of a comma, ...) it is thrown away, which is fine only if its last
// method call was `.catch(...)`.
//
// This is a guard for how this code base fires and forgets publishes, not a
// full escape analysis: a promise handed to a function or stored is trusted
// to be handled there.
function isUnhandled(call: ts.CallExpression): boolean {
  let n: ts.Node = call;
  let last: string | undefined;
  for (;;) {
    const p = n.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p)
    ) {
      n = p;
    } else if (
      ts.isPropertyAccessExpression(p) &&
      p.expression === n &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    ) {
      last = p.name.text;
      n = p.parent;
    } else if (ts.isConditionalExpression(p) && n !== p.condition) {
      n = p;
    } else if (
      ts.isBinaryExpression(p) &&
      n === p.right &&
      PASS_THROUGH.has(p.operatorToken.kind)
    ) {
      n = p;
    } else if (
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isObjectLiteralExpression(p)
    ) {
      // A container holds the promise only as long as the container is kept.
      n = p;
    } else if (ts.isPropertyAssignment(p) && p.initializer === n) {
      n = p;
    } else if (ts.isCallExpression(p) && promiseCombinator(p) != null) {
      // Promise.all/race/any reject when it does; allSettled never rejects.
      if (promiseCombinator(p) === "allSettled") return false;
      last = undefined;
      n = p;
    } else if (
      ts.isAwaitExpression(p) ||
      ts.isReturnStatement(p) ||
      ts.isYieldExpression(p) ||
      (ts.isArrowFunction(p) && p.body === n) ||
      (ts.isVariableDeclaration(p) && p.initializer === n) ||
      (ts.isBinaryExpression(p) &&
        n === p.right &&
        p.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
      ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression !== n)
    ) {
      return false;
    } else {
      return last !== "catch";
    }
  }
}

// Lines of publishLro... calls whose rejection nothing handles.
function uncaughtPublishes(text: string): number[] {
  const file = ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      PUBLISHERS.has(node.expression.text) &&
      isUnhandled(node)
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

  it("treats a bare statement like void", () => {
    expect(
      uncaughtPublishes(
        [
          "publishLroEvent({});",
          "publishLroSummary({}).then(() => {});",
          "publishLroEvent({}).catch(() => {});",
          "async function f() { await publishLroEvent({}); }",
          "function g() { return publishLroSummary({}); }",
          "const p = publishLroEvent({});",
        ].join("\n"),
      ),
    ).toEqual([1, 2]);
  });

  it("follows the promise through && || ?? ?: and commas", () => {
    expect(
      uncaughtPublishes(
        [
          "ready && publishLroEvent({});",
          "void (ready && publishLroEvent({}));",
          "ready ? publishLroEvent({}) : undefined;",
          "void (ready ? undefined : publishLroSummary({}));",
          "(publishLroEvent({}), 1);",
          "x ?? publishLroEvent({});",
          "ready && publishLroEvent({}).catch(() => {});",
          "void (ready ? publishLroEvent({}).catch(() => {}) : 0);",
          "(ready && publishLroEvent({}))?.catch(() => {});",
          "const p = ready && publishLroEvent({});",
          "await (ready ? publishLroEvent({}) : null);",
          "f(publishLroEvent({}));",
          "publishLroEvent({}) ? a() : b();",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 13]);
  });

  it("follows the promise through containers and Promise.all", () => {
    expect(
      uncaughtPublishes(
        [
          "void Promise.all([publishLroEvent({})]);",
          "[publishLroEvent({})];",
          "void { p: publishLroSummary({}) };",
          "Promise.race([...[publishLroEvent({})]]).then(() => {});",
          "void Promise.all([publishLroEvent({})]).catch(() => {});",
          "await Promise.all([publishLroEvent({})]);",
          "const ps = [publishLroEvent({})];",
          "void Promise.allSettled([publishLroEvent({})]);",
          "return Promise.any([publishLroEvent({})]);",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4]);
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
