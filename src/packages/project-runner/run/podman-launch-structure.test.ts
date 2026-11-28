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
import { dirname, join, normalize, relative } from "node:path";
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
    why: "L5 sandbox exec: ephemeral run (sideLaunchPolicy) or exec into the own container (execLaunchPolicy)",
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

// Every place that can start a process (a reference to child_process or
// node-pty, however imported or aliased), by file: a new one fails here until
// it is reviewed and counted, so a computed command or a helper that passes
// podman can't appear unnoticed.
const PROCESS_MODULES = new Set([
  "child_process",
  "node:child_process",
  "node-pty",
]);
const PROCESS_INVENTORY: Record<string, number> = {
  "backend/bash.ts": 2,
  "backend/computers/exec.ts": 1,
  "backend/conat/persist-durability.ts": 1,
  "backend/conat/persist-maintenance/compact-worker.ts": 1,
  "backend/conat/persist-verified-eviction.ts": 2,
  "backend/execute-code.ts": 3,
  "backend/frontend-build-fingerprint.ts": 3,
  "backend/podman/command.ts": 2,
  "backend/podman/conmon.ts": 1,
  "backend/process-stats.ts": 1,
  "backend/r2.ts": 1,
  "backend/sandbox/exec.ts": 3,
  "backend/sandbox/install.ts": 2,
  "backend/sandbox/privileged-delete.ts": 1,
  "project-runner/run/pull-image.ts": 1,
  "project-runner/run/sandbox-command-containment.ts": 3,
  "project-runner/run/sandbox-command-stream.ts": 1,
  "project-runner/run/workspace.ts": 1,
  "project-host/acp/claude-subscription-home.ts": 1,
  "project-host/acp/claude-subscription-login.ts": 1,
  "project-host/acp/claude-usage-probe.ts": 1,
  "project-host/acp/qualified-harness-entry.ts": 1,
  "project-host/app-supervisor.ts": 1,
  "project-host/daemon.ts": 2,
  "project-host/host-service-cgroup.ts": 3,
  "project-host/host-sysctl.ts": 1,
  "project-host/hub/acp/worker-manager.ts": 1,
  "project-host/io-metrics.ts": 1,
  "project-host/legacy-migration/project-archive.ts": 2,
  "project-host/onprem-tunnel.ts": 1,
  "project-host/runtime-conformance.ts": 1,
  "project-host/runtime-posture.ts": 1,
  "project-host/rustic-backup-browser.ts": 2,
  "project-host/rustic-cache-maintenance.ts": 1,
  "project-host/shared-browser-containers.ts": 2,
  "project-host/storage-admission.ts": 1,
  "project-host/upgrade.ts": 4,
  "lite/http.ts": 1,
  "lite/hub/acp/executor/local.ts": 2,
  "lite/hub/acp/local-harness.ts": 3,
  "lite/hub/acp/worker-manager.ts": 1,
  "lite/hub/api.ts": 1,
  "lite/hub/codex-auth.ts": 1,
  "lite/hub/codex-runtime.ts": 1,
  "lite/playwright/jupyter/global-setup.ts": 1,
  "lite/playwright/jupyter/helpers.ts": 1,
  "lite/static-apps.ts": 1,
};

// The literal "podman" (or a path ending in /podman) outside backend/podman,
// by file and why: each is a direct podman run (a non-launch verb, reviewed),
// or not a command at all.
// Calls of functions that can start a process (helpers around child_process,
// node-pty, or other helpers, across files: see processHelperCalls), by file:
// a new call, with whatever command, fails here until reviewed.
const HELPER_CALLS: Record<string, number> = {
  "backend/computers/connector-main.ts": 3,
  "backend/computers/connector.ts": 4,
  "backend/conat/persist-maintenance/inspect.ts": 2,
  "backend/conat/persist-verified-eviction.ts": 4,
  "backend/execute-code.ts": 9,
  "backend/frontend-build-fingerprint.ts": 4,
  "backend/podman/conmon.ts": 2,
  "backend/sandbox/cp.ts": 1,
  "backend/sandbox/du.ts": 1,
  "backend/sandbox/dust.ts": 4,
  "backend/sandbox/exec.ts": 1,
  "backend/sandbox/fd.ts": 1,
  "backend/sandbox/find.ts": 1,
  "backend/sandbox/index.ts": 12,
  "backend/sandbox/install.ts": 2,
  "backend/sandbox/ouch.ts": 1,
  "backend/sandbox/ripgrep.ts": 1,
  "backend/sandbox/rustic.ts": 19,
  "lite/http.ts": 4,
  "lite/hub/acp/index.ts": 1,
  "lite/hub/acp/local-harness.ts": 4,
  "lite/hub/acp/worker-manager.ts": 1,
  "lite/hub/api.ts": 3,
  "lite/main.ts": 3,
  "lite/playwright/jupyter/global-setup.ts": 5,
  "lite/static-apps.ts": 2,
  "project-host/acp-worker.ts": 3,
  "project-host/acp/claude-project-tool-bridge.ts": 1,
  "project-host/acp/claude-subscription-controller.ts": 8,
  "project-host/acp/claude-subscription-login.ts": 1,
  "project-host/acp/harness-launcher.ts": 4,
  "project-host/acp/harness-reaper.ts": 3,
  "project-host/acp/qualified-harness-entry.ts": 1,
  "project-host/app-supervisor.ts": 2,
  "project-host/exam/controller.ts": 2,
  "project-host/file-server.ts": 19,
  "project-host/host-agent.ts": 3,
  "project-host/hub/acp/worker-manager.ts": 7,
  "project-host/hub/projects.ts": 2,
  "project-host/legacy-migration/project-archive.ts": 13,
  "project-host/main.ts": 27,
  "project-host/managed-component-rollout.ts": 2,
  "project-host/master.ts": 12,
  "project-host/onprem-tunnel.ts": 9,
  "project-host/reconcile.ts": 7,
  "project-host/restore-backup-inventory.ts": 2,
  "project-host/runtime-conformance.ts": 10,
  "project-host/runtime-posture.ts": 7,
  "project-host/rustic-backup-browser.ts": 16,
  "project-host/shared-browser-containers.ts": 5,
  "project-host/snapshot-backup-maintenance.ts": 22,
  "project-host/storage-admission.ts": 4,
  "project-host/upgrade.ts": 60,
  "project-runner/run/podman.ts": 36,
  "project-runner/run/rootfs-base.ts": 1,
  "project-runner/run/runtime-backend.ts": 1,
  "project-runner/run/sandbox-command-containment.ts": 3,
  "project-runner/run/sandbox-exec.ts": 2,
  "project-runner/run/workspace.ts": 1,
};

// podman unshare call sites (host commands run as the runtime uid in
// Podman's namespace), by file.
const UNSHARE_SITES: Record<string, { count: number; why: string }> = {
  "project-runner/run/rootfs-base.ts": {
    count: 1,
    why: "image extraction: a bash script running podman image mount/unmount and rsync (no launch)",
  },
  "project-runner/run/rootfs-normalize.ts": {
    count: 1,
    why: "rootfs normalization: a bash script running podman image mount/unmount and file checks (no launch)",
  },
  "project-runner/run/runtime-host.ts": {
    count: 2,
    why: "reads Podman's live maps and its user namespace (cat, readlink)",
  },
  "project-host/rootfs-runtime-contract.ts": {
    count: 2,
    why: "reads Podman's live maps (cat /proc/self/uid_map, gid_map)",
  },
};

const PODMAN_LITERALS: Record<string, { count: number; why: string }> = {
  "project-runner/run/podman.ts": {
    count: 1,
    why: "the AppArmor profile named podman (the shared browser's launcher), not a command",
  },
  "project-runner/run/pull-image.ts": {
    count: 1,
    why: "podman pull through a pty (progress); a non-launch verb",
  },
  "project-runner/run/runtime-backend.ts": {
    count: 5,
    why: "the runtime mode's name, not a command",
  },
  "project-runner/run/sandbox-exec.ts": {
    count: 1,
    why: "a log label, not a command",
  },
  "project-runner/runtime-mode.ts": {
    count: 3,
    why: "the runtime mode's name, not a command",
  },
  "project-host/codex/codex-project.ts": {
    count: 2,
    why: "the command name reported for a process the wrappers started",
  },
  "project-host/daemon.ts": {
    count: 3,
    why: "daemon preflight: podman ps -a and system migrate (non-launch verbs)",
  },
  "project-host/hub/projects.ts": {
    count: 1,
    why: "the runtime mode's name, not a command",
  },
  "project-host/master.ts": {
    count: 6,
    why: "diagnostics (info, ps) routed to the wrappers by runDiagnosticCommand; a journal tag",
  },
  "project-host/rootfs-scan.ts": {
    count: 4,
    why: "the scanner's podman binary, run only through execFilePodman (anything else refused)",
  },
  "project-host/runtime-health.ts": {
    count: 3,
    why: "health probes (info, ps) routed to the wrappers",
  },
  "project-host/runtime-posture.ts": {
    count: 1,
    why: "podman --version",
  },
  "project-host/shared-browser-containers.ts": {
    count: 2,
    why: "the AppArmor profile named podman, not a command",
  },
  "project-host/upgrade.ts": {
    count: 10,
    why: "host upgrade: podman info, ps, stop --all, inspect (non-launch verbs) and the runtime bundle's binary list",
  },
};

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
  processRefs: Record<string, number>;
  podmanLiterals: Record<string, number>;
  helperCallCounts: Record<string, number>;
  unshare: Record<string, number>;
} {
  const directPodman: Finding[] = [];
  const verbs = new Map<string, string[]>();
  const mint: Finding[] = [];
  const processRefs: Record<string, number> = {};
  const podmanLiterals: Record<string, number> = {};
  const unshare: Record<string, number> = {};
  const parsed: { rel: string; file: ts.SourceFile }[] = [];
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
          // podman unshare runs host commands as the runtime uid
          if (first === "unshare") unshare[rel] = (unshare[rel] ?? 0) + 1;
          else if (first === "container" && GATED.has(second ?? ""))
            noteVerb(second!);
        }
        // a launcher written as a plain object ({ command, argsPrefix })
        // instead of minted: the wrappers would refuse it at run time
        if (
          ts.isObjectLiteralExpression(node) &&
          node.properties.some(
            (p) => p.name != null && p.name.getText(file) === "argsPrefix",
          ) &&
          !rel.startsWith("backend/podman/")
        )
          mint.push({
            file: rel,
            line: line(node),
            what: "a launcher object that isn't minted",
          });
        // only the gate mints policies
        if (
          ts.isImportDeclaration(node) &&
          /launch-policy-mint/.test(stringValue(node.moduleSpecifier) ?? "") &&
          rel !== "project-runner/run/podman-launch.ts"
        )
          mint.push({ file: rel, line: line(node), what: "imports the mint" });
        if (
          ts.isImportDeclaration(node) &&
          /launcher-mint/.test(stringValue(node.moduleSpecifier) ?? "") &&
          rel !== "project-runner/run/podman.ts"
        )
          mint.push({
            file: rel,
            line: line(node),
            what: "imports the launcher mint",
          });
        // the tokens, by name or as a string key (lp["__mintToken"])
        const tokenName = ts.isIdentifier(node) ? node.text : stringValue(node);
        if (
          (tokenName === "__mintToken" || tokenName === "__launcherToken") &&
          rel !== "backend/podman/launch-policy.ts" &&
          rel !== "backend/podman/launch-policy-mint.ts" &&
          rel !== "backend/podman/launcher-mint.ts"
        )
          mint.push({ file: rel, line: line(node), what: `uses ${tokenName}` });
        if (
          ts.isNewExpression(node) &&
          (node.expression.getText(file) === "PodmanLaunchPolicy" ||
            node.expression.getText(file) === "PodmanLauncher") &&
          rel !== "backend/podman/launch-policy-mint.ts" &&
          rel !== "backend/podman/launcher-mint.ts"
        )
          mint.push({
            file: rel,
            line: line(node),
            what: "constructs a policy or launcher",
          });
        ts.forEachChild(node, visit);
      };
      visit(file);
      parsed.push({ rel, file });
      const refs = processReferences(file);
      if (refs > 0) processRefs[rel] = refs;
      if (!rel.startsWith("backend/podman/")) {
        const literals = countPodmanLiterals(file);
        if (literals > 0) podmanLiterals[rel] = literals;
      }
    }
  }
  // helpers that can start a process (across files), then every call of one
  const helperCallCounts = processHelperCalls(
    parsed.filter(({ rel }) => rel !== WRAPPER),
  );
  return {
    directPodman,
    verbs,
    mint,
    processRefs,
    podmanLiterals,
    helperCallCounts,
    unshare,
  };
}

/** References to child_process / node-pty bindings in a file: every use of an
 * imported (or required) name, plus each dynamic import or bare require. */
export function processReferences(file: ts.SourceFile): number {
  return processReferenceNodes(file).length;
}

/** The nodes behind processReferences (identifiers, or in-place requires). */
function processReferenceNodes(file: ts.SourceFile): ts.Node[] {
  const bound = new Set<string>();
  const refs: ts.Node[] = [];
  const isProcessModule = (node: ts.Node | undefined) =>
    PROCESS_MODULES.has(stringValue(node) ?? "");
  const collect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      isProcessModule(node.moduleSpecifier) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      const clause = node.importClause;
      if (clause.name) bound.add(clause.name.text);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) bound.add(named.name.text);
      if (named && ts.isNamedImports(named))
        for (const el of named.elements)
          if (!el.isTypeOnly) bound.add(el.name.text);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && isProcessModule(ref.expression))
        bound.add(node.name.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      isProcessModule(node.arguments[0])
    ) {
      const parent = node.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
        const name = parent.name;
        if (ts.isIdentifier(name)) bound.add(name.text);
        else if (ts.isObjectBindingPattern(name))
          for (const el of name.elements)
            if (ts.isIdentifier(el.name)) bound.add(el.name.text);
      } else {
        refs.push(node); // used in place: require("child_process").spawn(...)
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);
  if (bound.size === 0) return refs;
  const isDeclaration = (id: ts.Identifier) => {
    const parent = id.parent;
    return (
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      (ts.isVariableDeclaration(parent) && parent.name === id) ||
      ts.isBindingElement(parent) ||
      // a type position: typeof cp, cp.ChildProcess as a type
      ts.isTypeQueryNode(parent) ||
      ts.isQualifiedName(parent)
    );
  };
  const uses = (node: ts.Node) => {
    if (ts.isIdentifier(node) && bound.has(node.text) && !isDeclaration(node))
      refs.push(node);
    ts.forEachChild(node, uses);
  };
  uses(file);
  return refs;
}

// The wrappers themselves (their calls are gated) are not helpers here: their
// module is left out of the analysis.

interface ModuleFacts {
  rel: string;
  file: ts.SourceFile;
  refs: ts.Node[];
  // local name -> function nodes (declarations, const arrows/functions)
  functions: Map<string, ts.Node[]>;
  // functions that are members (methods, object properties) of a named class
  // or object (owner: the class or const name; "" when it has none)
  members: { owner: string; name: string; node: ts.Node }[];
  // local import name -> where it comes from ("default", "*" or a symbol)
  imports: Map<string, { module?: string; symbol: string }>;
  // exported symbol -> a local name, or a re-export of another module's symbol
  exports: Map<string, { local?: string; module?: string; symbol?: string }>;
  starExports: string[];
}

/** A module specifier as a scanned file (relative or @cocalc/<pkg>/...). */
export function resolveModule(
  fromRel: string,
  spec: string,
  known: Set<string>,
): string | undefined {
  let base: string | undefined;
  if (spec.startsWith(".")) base = normalize(join(dirname(fromRel), spec));
  else if (spec.startsWith("@cocalc/")) base = spec.slice("@cocalc/".length);
  if (base == null) return undefined;
  base = base
    .split("\\")
    .join("/")
    .replace(/\.(js|ts)$/, "");
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ])
    if (known.has(candidate)) return candidate;
  return undefined;
}

function isFunctionLike(node: ts.Node | undefined): boolean {
  return (
    node != null && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
  );
}

/** The class or const a member function belongs to ("" if unnamed). */
function memberOwner(node: ts.Node): string {
  const holder = node.parent;
  if (holder != null && ts.isClassLike(holder)) return holder.name?.text ?? "";
  if (holder != null && ts.isObjectLiteralExpression(holder)) {
    const decl = holder.parent;
    if (
      decl != null &&
      ts.isVariableDeclaration(decl) &&
      ts.isIdentifier(decl.name)
    )
      return decl.name.text;
  }
  return "";
}

function moduleFacts(
  rel: string,
  file: ts.SourceFile,
  known: Set<string>,
): ModuleFacts {
  const facts: ModuleFacts = {
    rel,
    file,
    refs: processReferenceNodes(file),
    functions: new Map(),
    members: [],
    imports: new Map(),
    exports: new Map(),
    starExports: [],
  };
  const addFunction = (name: string, node: ts.Node) =>
    facts.functions.set(name, [...(facts.functions.get(name) ?? []), node]);
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
  const isDefault = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
    );
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? "default";
      addFunction(name, node);
      if (exported(node))
        facts.exports.set(isDefault(node) ? "default" : name, { local: name });
    } else if (ts.isClassDeclaration(node) && node.name && exported(node)) {
      facts.exports.set(isDefault(node) ? "default" : node.name.text, {
        local: node.name.text,
      });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isFunctionLike(node.initializer)
    ) {
      addFunction(node.name.text, node);
    } else if (
      (ts.isMethodDeclaration(node) ||
        (ts.isPropertyAssignment(node) && isFunctionLike(node.initializer))) &&
      node.name
    ) {
      facts.members.push({
        owner: memberOwner(node),
        name: node.name.getText(file),
        node,
      });
    }
    if (ts.isVariableStatement(node) && exported(node))
      for (const decl of node.declarationList.declarations)
        if (ts.isIdentifier(decl.name))
          facts.exports.set(decl.name.text, { local: decl.name.text });
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const e = node.expression;
      if (ts.isIdentifier(e)) facts.exports.set("default", { local: e.text });
      else {
        addFunction("default", e);
        facts.exports.set("default", { local: "default" });
      }
    }
    if (ts.isExportDeclaration(node)) {
      const from =
        node.moduleSpecifier != null
          ? resolveModule(rel, stringValue(node.moduleSpecifier) ?? "", known)
          : undefined;
      const clause = node.exportClause;
      if (clause == null) {
        if (from) facts.starExports.push(from);
      } else if (ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          const local = (el.propertyName ?? el.name).text;
          facts.exports.set(
            el.name.text,
            node.moduleSpecifier != null
              ? { module: from, symbol: local }
              : { local },
          );
        }
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      const from = resolveModule(
        rel,
        stringValue(node.moduleSpecifier) ?? "",
        known,
      );
      const clause = node.importClause;
      if (clause.name)
        facts.imports.set(clause.name.text, {
          module: from,
          symbol: "default",
        });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named))
        facts.imports.set(named.name.text, { module: from, symbol: "*" });
      if (named && ts.isNamedImports(named))
        for (const el of named.elements)
          if (!el.isTypeOnly)
            facts.imports.set(el.name.text, {
              module: from,
              symbol: (el.propertyName ?? el.name).text,
            });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return facts;
}

/**
 * Every call of a function that can start a process, by file. A function can
 * when it references child_process/node-pty, or calls such a function: in
 * its own file, or imported from another (named, default, namespace,
 * re-exported, aliases followed), to a fixed point. Member functions
 * (methods, object properties) that can are matched by name wherever they
 * are called, which can only over-count.
 */
export function processHelperCalls(
  files: { rel: string; file: ts.SourceFile }[],
): Record<string, number> {
  const known = new Set(files.map(({ rel }) => rel));
  const modules = new Map(
    files.map(({ rel, file }) => [rel, moduleFacts(rel, file, known)]),
  );
  const capable = new Set<string>(); // `${rel}#${local}`
  // `${rel}#${owner}` -> the owner's member functions that can
  const capableMembers = new Map<string, Set<string>>();
  const memberCapable = (rel: string, owner: string, name: string) =>
    capableMembers.get(`${rel}#${owner}`)?.has(name) ?? false;
  // where an exported symbol is declared (re-exports and imports followed)
  const exportOrigin = (
    rel: string | undefined,
    symbol: string,
    seen = new Set<string>(),
  ): { rel: string; local: string } | undefined => {
    if (rel == null || seen.has(`${rel}#${symbol}`)) return undefined;
    seen.add(`${rel}#${symbol}`);
    const m = modules.get(rel);
    if (m == null) return undefined;
    const e = m.exports.get(symbol);
    if (e?.local != null) {
      const imp = m.imports.get(e.local);
      if (imp != null && imp.symbol !== "*")
        return exportOrigin(imp.module, imp.symbol, seen);
      return { rel, local: e.local };
    }
    if (e?.module != null) return exportOrigin(e.module, e.symbol!, seen);
    for (const star of m.starExports) {
      const found = exportOrigin(star, symbol, seen);
      if (found) return found;
    }
    return undefined;
  };
  // the owners (classes, objects) a file can reach: its own and imported ones
  const reachableOwners = (
    m: ModuleFacts,
  ): { rel: string; owner: string }[] => {
    const out = m.members.map(({ owner }) => ({ rel: m.rel, owner }));
    for (const imp of m.imports.values()) {
      if (imp.symbol === "*") {
        // ns.owner.member(...): every owner the module (or its star
        // exports) defines is reachable
        const seen = new Set<string>();
        const add = (rel: string | undefined) => {
          if (rel == null || seen.has(rel)) return;
          seen.add(rel);
          const target = modules.get(rel);
          if (target == null) return;
          for (const { owner } of target.members) out.push({ rel, owner });
          for (const e of target.exports.values()) {
            if (e.module != null && e.symbol != null) {
              const origin = exportOrigin(e.module, e.symbol);
              if (origin) out.push({ rel: origin.rel, owner: origin.local });
            }
          }
          target.starExports.forEach(add);
        };
        add(imp.module);
        continue;
      }
      const origin = exportOrigin(imp.module, imp.symbol);
      if (origin) out.push({ rel: origin.rel, owner: origin.local });
    }
    return out;
  };
  const inside = (outer: ts.Node, inner: ts.Node) =>
    inner.pos >= outer.pos && inner.end <= outer.end;
  const exportCapable = (
    rel: string | undefined,
    symbol: string,
    seen = new Set<string>(),
  ): boolean => {
    if (rel == null || seen.has(`${rel}#${symbol}`)) return false;
    seen.add(`${rel}#${symbol}`);
    const m = modules.get(rel);
    if (m == null) return false;
    const e = m.exports.get(symbol);
    if (e?.local != null) return localCapable(m, e.local, seen);
    if (e?.module != null) return exportCapable(e.module, e.symbol!, seen);
    return m.starExports.some((star) => exportCapable(star, symbol, seen));
  };
  const localCapable = (
    m: ModuleFacts,
    name: string,
    seen = new Set<string>(),
  ): boolean => {
    if (capable.has(`${m.rel}#${name}`)) return true;
    const imp = m.imports.get(name);
    if (imp != null && imp.symbol !== "*")
      return exportCapable(imp.module, imp.symbol, seen);
    return false;
  };
  const callCapable = (m: ModuleFacts, call: ts.CallExpression): boolean => {
    const e = call.expression;
    if (ts.isIdentifier(e)) return localCapable(m, e.text);
    if (ts.isPropertyAccessExpression(e)) {
      const name = e.name.text;
      if (ts.isIdentifier(e.expression)) {
        const imp = m.imports.get(e.expression.text);
        if (imp?.symbol === "*") return exportCapable(imp.module, name);
      }
      // a member of a class or object this file defines or imports (called
      // through it, through this, or through an instance): matched by name
      // among the reachable owners' capable members
      return reachableOwners(m).some(({ rel, owner }) =>
        memberCapable(rel, owner, name),
      );
    }
    return false;
  };
  const bodyCapable = (m: ModuleFacts, node: ts.Node): boolean => {
    if (m.refs.some((r) => inside(node, r))) return true;
    let found = false;
    const find = (n: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(n) && callCapable(m, n)) found = true;
      else ts.forEachChild(n, find);
    };
    find(node);
    return found;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of modules.values()) {
      for (const [name, nodes] of m.functions) {
        if (capable.has(`${m.rel}#${name}`)) continue;
        if (nodes.some((node) => bodyCapable(m, node))) {
          capable.add(`${m.rel}#${name}`);
          changed = true;
        }
      }
      for (const { owner, name, node } of m.members) {
        if (memberCapable(m.rel, owner, name)) continue;
        if (bodyCapable(m, node)) {
          const key = `${m.rel}#${owner}`;
          capableMembers.set(
            key,
            new Set([...(capableMembers.get(key) ?? []), name]),
          );
          changed = true;
        }
      }
    }
  }
  const counts: Record<string, number> = {};
  for (const m of modules.values()) {
    let n = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && callCapable(m, node)) n++;
      ts.forEachChild(node, visit);
    };
    visit(m.file);
    if (n > 0) counts[m.rel] = n;
  }
  return counts;
}

const PODMAN_LITERAL = /^(.*\/)?podman$/;

/** String literals naming podman as a command. */
export function countPodmanLiterals(file: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node) => {
    const value = stringValue(node);
    const moduleName =
      node.parent != null &&
      (ts.isImportDeclaration(node.parent) ||
        ts.isExportDeclaration(node.parent)) &&
      node.parent.moduleSpecifier === node;
    if (value != null && !moduleName && PODMAN_LITERAL.test(value)) count++;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
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

  it("only the gate mints launch policies (and only podman.ts launchers)", () => {
    expect(result.mint).toEqual([]);
  });

  it("every place that can start a process is counted (fail closed)", () => {
    expect(result.processRefs).toEqual(PROCESS_INVENTORY);
  });

  it("every call of a process-capable helper is counted (fail closed)", () => {
    expect(result.helperCallCounts).toEqual(HELPER_CALLS);
  });

  it("every podman unshare (host commands as the runtime uid) is reviewed", () => {
    expect(result.unshare).toEqual(
      Object.fromEntries(
        Object.entries(UNSHARE_SITES).map(([f, { count }]) => [f, count]),
      ),
    );
  });

  it("counts calls through helpers across files (self-test)", () => {
    const src = (rel: string, text: string) => ({
      rel,
      file: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true),
    });
    const counts = processHelperCalls([
      // a forwarding chain across three files, with a computed command
      src(
        "x/a.ts",
        `import { spawn } from "node:child_process";
         export function low(c: string, a: string[]) { return spawn(c, a); }`,
      ),
      src(
        "x/b.ts",
        `import { low } from "./a";
         export function high(c: string, a: string[]) { return low(c, a); }`,
      ),
      src(
        "x/c.ts",
        `import { high } from "./b"; high(getCommand(), buildArgs());`,
      ),
      // a default export, and an export after the declaration, re-exported
      src(
        "x/d.ts",
        `import { execFile as run } from "node:child_process";
         export default (c: string) => run(c, []);
         function later(c: string) { return run(c, ["x"]); }
         export { later };`,
      ),
      src(
        "x/e.ts",
        `export { later as again } from "./d"; export * from "./b";`,
      ),
      src(
        "x/f.ts",
        `import go from "./d"; import { again, high as h2 } from "./e";
         import * as ns from "./b";
         go(cmd()); again(cmd()); h2(cmd(), argv()); ns.high(cmd(), argv());`,
      ),
      // a capable method, called by name elsewhere
      src(
        "x/g.ts",
        `import { spawnSync } from "node:child_process";
         export const runner = { exec(c: string) { return spawnSync(c, []); } };`,
      ),
      src("x/h.ts", `import { runner } from "./g"; runner.exec(cmd());`),
      // the same method through a namespace import (nested receiver)
      src("x/j.ts", `import * as ns from "./g"; ns.runner.exec(cmd());`),
      // not a process: no count
      src("x/i.ts", `export function pure() { return 1; } pure();`),
    ]);
    expect(counts).toEqual({
      "x/b.ts": 1,
      "x/c.ts": 1,
      "x/f.ts": 4,
      "x/h.ts": 1,
      "x/j.ts": 1,
    });
  });

  it("every literal podman command outside the wrappers is reviewed", () => {
    expect(result.podmanLiterals).toEqual(
      Object.fromEntries(
        Object.entries(PODMAN_LITERALS).map(([f, { count }]) => [f, count]),
      ),
    );
  });

  it("counts aliased, required and dynamically imported process APIs (self-test)", () => {
    const count = (text: string) =>
      processReferences(
        ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true),
      );
    // a neutral alias with a computed command and a dynamic argv
    expect(
      count(`import { execFile as run } from "node:child_process";
             const argv = build(); run(cmd, argv);`),
    ).toBe(1);
    expect(
      count(`import * as cp from "child_process";
             const rt = { go: cp.spawnSync }; rt.go(x, y);`),
    ).toBe(1);
    expect(
      count(`const { spawn: s } = require("node:child_process"); s(a);`),
    ).toBe(1);
    expect(count(`require("child_process").execFile(a, b);`)).toBe(1);
    expect(
      count(`const m = await import("node:child_process"); m.spawn(a);`),
    ).toBe(1);
    expect(count(`import { spawn } from "node-pty"; spawn(c, a, {});`)).toBe(1);
    expect(
      count(`import type { ChildProcess } from "node:child_process";`),
    ).toBe(0);
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
