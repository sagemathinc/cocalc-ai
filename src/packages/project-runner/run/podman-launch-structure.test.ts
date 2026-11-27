/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Structural test for the launch gate (podman-launch.ts): every podman
invocation goes through the wrappers in @cocalc/backend/podman/command.ts,
which refuse create/run/exec/build without the gate's policy, and every place
that builds such an argv is in the inventory below, with its policy.

It reads the TypeScript sources of the packages that run on a project host
(a syntax tree, not a text search), so a new call site fails here until it
goes through the wrappers and is added to the inventory with a decision.
*/

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const PACKAGES = join(__dirname, "..", "..");
const SCANNED = ["backend", "project-runner", "project-host", "lite"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "test", "tests"]);

// The only file that may hand podman to child_process.
const WRAPPER = "backend/podman/command.ts";

// Every argv that starts with a gated verb, by file: the launchers (L0-L6)
// and exec sites, each passing a policy from the gate to the wrappers. A new
// one must be added here with its policy (and a test), or this test fails.
const INVENTORY: Record<string, { verbs: string[]; why: string }> = {
  "project-runner/run/podman.ts": {
    verbs: ["create"],
    why: "L0 project container (projectLaunchPolicy)",
  },
  "project-host/acp/harness-launcher.ts": {
    verbs: ["create"],
    why: "L1 ACP harness sidecar (sideLaunchPolicy acp-harness)",
  },
  "project-host/acp/claude-subscription-controller.ts": {
    verbs: ["create"],
    why: "L2 Claude controller (sideLaunchPolicy claude-controller)",
  },
  "project-host/codex/codex-project.ts": {
    verbs: ["run", "exec", "exec"],
    why: "L3 Codex container (sideLaunchPolicy codex) and its execs (execLaunchPolicy, feature codex)",
  },
  "project-host/shared-browser-containers.ts": {
    verbs: ["run"],
    why: "L4 shared browser (sideLaunchPolicy shared-browser)",
  },
  "project-runner/run/sandbox-exec.ts": {
    verbs: ["run", "exec"],
    why: "L5 sandbox exec: ephemeral run (sideLaunchPolicy) or exec (execLaunchPolicy, feature sandbox-exec)",
  },
  "project-host/rootfs-scan.ts": {
    verbs: ["run"],
    why: "L6 rootfs scan (sideLaunchPolicy rootfs-scan)",
  },
  "project-host/acp/claude-subscription-in-project.ts": {
    verbs: ["exec", "exec", "exec"],
    why: "Claude in the project container (execLaunchPolicy, feature acp-harness)",
  },
  "project-host/rootfs-build-runner.ts": {
    verbs: ["exec", "exec"],
    why: "RootFS build in the project container (execLaunchPolicy)",
  },
};

// Argvs that start with a gated word but are not podman, by file.
const NOT_PODMAN: Record<string, { verbs: string[]; why: string }> = {};

const GATED = new Set(["create", "run", "exec", "build"]);
const CHILD_PROCESS_CALLS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
  "fork",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (
      /\.(ts|tsx|mts|cts)$/.test(name) &&
      !/\.(test|spec)\.|\.d\.ts$|__tests__/.test(path)
    )
      out.push(path);
  }
  return out;
}

function stringValue(node: ts.Node | undefined): string | undefined {
  if (node == null) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  return undefined;
}

// Does this expression name podman (as a command to run)?
function podmanish(node: ts.Expression, file: ts.SourceFile): boolean {
  const literal = stringValue(node);
  if (literal != null) return /(^|\/)podman$/.test(literal);
  const text = node.getText(file);
  if (/podman/i.test(text)) return true;
  // launcher.command: the podman launchers (bash scripts that exec podman)
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "command" &&
    /launcher/i.test(node.expression.getText(file))
  )
    return true;
  return false;
}

function callName(call: ts.CallExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

interface Finding {
  file: string;
  line: number;
  what: string;
}

function scan(): {
  directPodman: Finding[];
  verbs: Map<string, string[]>;
  mint: Finding[];
} {
  const directPodman: Finding[] = [];
  const verbs = new Map<string, string[]>();
  const mint: Finding[] = [];
  for (const pkg of SCANNED) {
    for (const path of sourceFiles(join(PACKAGES, pkg))) {
      const rel = relative(PACKAGES, path).split("\\").join("/");
      const text = readFileSync(path, "utf8");
      const file = ts.createSourceFile(
        path,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      const line = (node: ts.Node) =>
        file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      const noteVerb = (verb: string) => {
        const list = verbs.get(rel) ?? [];
        list.push(verb);
        verbs.set(rel, list);
      };
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const name = callName(node);
          if (name && CHILD_PROCESS_CALLS.has(name) && node.arguments[0]) {
            const command = node.arguments[0];
            const args = node.arguments[1];
            const sudoPodman =
              stringValue(command) === "sudo" &&
              args != null &&
              ts.isArrayLiteralExpression(args) &&
              args.elements.some((e) => stringValue(e) === "podman");
            if (podmanish(command, file) || sudoPodman) {
              if (rel !== WRAPPER)
                directPodman.push({
                  file: rel,
                  line: line(node),
                  what: node.getText(file).slice(0, 80),
                });
            }
          }
          // executeCode({ command: ..., args: [...] }), "sudo podman" too
          if (name === "executeCode" && node.arguments[0]) {
            const opts = node.arguments[0];
            if (ts.isObjectLiteralExpression(opts)) {
              const prop = (key: string) =>
                opts.properties.find(
                  (p): p is ts.PropertyAssignment =>
                    ts.isPropertyAssignment(p) && p.name.getText(file) === key,
                )?.initializer;
              const command = prop("command");
              const args = prop("args");
              const sudoPodman =
                command != null &&
                stringValue(command) === "sudo" &&
                args != null &&
                ts.isArrayLiteralExpression(args) &&
                args.elements.some((e) => stringValue(e) === "podman");
              if (
                command != null &&
                (podmanish(command, file) || sudoPodman) &&
                rel !== WRAPPER
              )
                directPodman.push({
                  file: rel,
                  line: line(node),
                  what: node.getText(file).slice(0, 80),
                });
            }
          }
          // args.push("create", ...)
          if (
            name === "push" &&
            node.arguments.length > 0 &&
            GATED.has(stringValue(node.arguments[0]) ?? "")
          )
            noteVerb(stringValue(node.arguments[0])!);
        }
        // ["run", ...], ["container", "run", ...], or after global options
        // (["--log-level=debug", "run", ...])
        if (ts.isArrayLiteralExpression(node) && node.elements.length > 0) {
          const words = node.elements.map((e) => stringValue(e));
          let i = 0;
          while (i < words.length && words[i]?.startsWith("-")) i++;
          const first = words[i];
          const second = words[i + 1];
          if (GATED.has(first ?? "")) noteVerb(first!);
          else if (first === "container" && GATED.has(second ?? ""))
            noteVerb(second!);
        }
        // only the gate mints policies
        if (
          ts.isImportDeclaration(node) &&
          /launch-policy-mint/.test(stringValue(node.moduleSpecifier) ?? "") &&
          rel !== "project-runner/run/podman-launch.ts"
        )
          mint.push({ file: rel, line: line(node), what: "imports the mint" });
        if (
          ts.isIdentifier(node) &&
          node.text === "__mintToken" &&
          rel !== "backend/podman/launch-policy.ts" &&
          rel !== "backend/podman/launch-policy-mint.ts"
        )
          mint.push({ file: rel, line: line(node), what: "uses __mintToken" });
        if (
          ts.isNewExpression(node) &&
          node.expression.getText(file) === "PodmanLaunchPolicy" &&
          rel !== "backend/podman/launch-policy-mint.ts"
        )
          mint.push({
            file: rel,
            line: line(node),
            what: "constructs a policy",
          });
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }
  return { directPodman, verbs, mint };
}

describe("podman launch gate: structure", () => {
  const result = scan();

  it("nothing hands podman to child_process except the wrappers", () => {
    expect(result.directPodman).toEqual([]);
  });

  it("every argv with a gated verb is in the inventory, with its policy", () => {
    const found: Record<string, string[]> = {};
    for (const [file, list] of result.verbs) {
      if (file === "project-runner/run/podman-launch.ts") continue;
      if (file.startsWith("backend/podman/")) continue;
      found[file] = [...list].sort();
    }
    const expected: Record<string, string[]> = {};
    for (const [file, { verbs }] of Object.entries({
      ...INVENTORY,
      ...NOT_PODMAN,
    }))
      expected[file] = [...verbs].sort();
    expect(found).toEqual(expected);
  });

  it("only the gate mints launch policies", () => {
    expect(result.mint).toEqual([]);
  });

  it("catches a direct call and an unlisted verb (self-test)", () => {
    const sample = ts.createSourceFile(
      "x.ts",
      `import { execFile } from "node:child_process";
       execFile(podman_binary, ["run", "--rm", "x"]);
       execFile(launcher.command, [...launcher.argsPrefix, "exec", c]);`,
      ts.ScriptTarget.Latest,
      true,
    );
    const calls: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && callName(node) === "execFile")
        if (podmanish(node.arguments[0], sample)) calls.push("direct");
      ts.forEachChild(node, visit);
    };
    visit(sample);
    expect(calls).toEqual(["direct", "direct"]);
  });
});
