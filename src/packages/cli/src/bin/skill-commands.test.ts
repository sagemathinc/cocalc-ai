/*
The CoCalc agent skill (skills/cocalc: SKILL.md and references/*.md) tells
agents which `cocalc ...` commands to run.  Every command path and --option it
mentions must exist in this CLI, so a renamed command or option fails here
instead of misleading agents.
*/

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { before, mock } from "node:test";
import { Command, type Option } from "commander";

// Mentioned on purpose as what not to do.
const NOT_COMMANDS = new Set(["docs project secrets"]);

let program: Command;

before(async () => {
  // The real CLI, as main.ts composes it, without parsing argv.
  let captured: Command | undefined;
  const parsing = mock.method(
    Command.prototype,
    "parseAsync",
    function (this: Command) {
      captured = this;
      return new Promise<Command>(() => {});
    },
  );
  const log = console.log;
  try {
    require("./main");
  } finally {
    console.log = log;
    parsing.mock.restore();
  }
  assert.ok(captured, "main.ts did not build its program");
  program = captured;
});

function skillDir(): string {
  // (tests run with the package as the working directory)
  return join(process.cwd(), "skills", "cocalc");
}

function skillText(): string {
  const dir = skillDir();
  const refs = join(dir, "references");
  return [
    readFileSync(join(dir, "SKILL.md"), "utf8"),
    ...readdirSync(refs)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => readFileSync(join(refs, name), "utf8")),
  ].join("\n");
}

// `cocalc ...` in code blocks (one per line) and in inline code.
function commandLines(text: string): string[] {
  const lines = new Set<string>();
  for (const m of text.matchAll(
    /^\s*(?:[A-Z_]+=\S+\s+)*cocalc\s+([^\n#`]*)/gm,
  )) {
    lines.add(m[1].trim());
  }
  for (const m of text.matchAll(/`cocalc\s+([^`]+)`/g)) {
    lines.add(m[1].trim());
  }
  return [...lines].filter(Boolean);
}

function findSub(cmd: Command, word: string): Command | undefined {
  return cmd.commands.find(
    (c) => c.name() === word || c.aliases().includes(word),
  );
}

function longOptions(cmds: Command[]): Set<string> {
  const out = new Set<string>(["--help"]);
  for (const cmd of cmds) {
    for (const option of cmd.options as readonly Option[]) {
      if (option.long) out.add(option.long);
    }
  }
  return out;
}

// The problems with one command line, if any.
function check(line: string): string[] {
  const words = line.replace(/\\$/, "").split(/\s+/);
  const chain: Command[] = [program];
  let i = 0;
  // global options before the command, e.g. `cocalc --json exec ...`
  while (i < words.length && words[i].startsWith("--")) {
    const name = words[i].split("=")[0];
    const option = (program.options as readonly Option[]).find(
      (o) => o.long === name,
    );
    if (option == null) return [`unknown global option ${name}`];
    i +=
      (option.required || option.optional) && !words[i].includes("=") ? 2 : 1;
  }
  for (; i < words.length; i++) {
    const next = findSub(chain[chain.length - 1], words[i]);
    if (next == null) break;
    chain.push(next);
  }
  const path = chain
    .slice(1)
    .map((c) => c.name())
    .join(" ");
  if (chain.length === 1) return [`unknown command: cocalc ${line}`];
  const problems: string[] = [];
  const last = chain[chain.length - 1];
  const rest = words.slice(i);
  if (last.commands.length > 0 && /^[a-z][\w-]*$/.test(rest[0] ?? "")) {
    problems.push(`unknown subcommand ${rest[0]} of cocalc ${path}`);
  }
  // options before a bare `--` (after it, they belong to another command)
  const end = rest.indexOf("--");
  const known = longOptions(chain);
  for (const word of end === -1 ? rest : rest.slice(0, end)) {
    const name = word.match(/^(--[a-z][\w-]*)/)?.[1];
    if (name && !known.has(name)) {
      problems.push(`unknown option ${name} of cocalc ${path}`);
    }
  }
  return problems;
}

test("every cocalc command in the agent skill exists in the CLI", () => {
  const lines = commandLines(skillText()).filter(
    (line) => !NOT_COMMANDS.has(line),
  );
  assert.ok(lines.length > 50, `only ${lines.length} commands found`);
  const problems = lines.flatMap((line) =>
    check(line).map((problem) => `${problem}   (from: cocalc ${line})`),
  );
  assert.deepEqual(problems, []);
});

test("the check finds made-up commands and options", () => {
  assert.notDeepEqual(check("project no-such-command"), []);
  assert.notDeepEqual(check("project storage show --no-such-option"), []);
  assert.deepEqual(check("project storage show --force-sample"), []);
});
