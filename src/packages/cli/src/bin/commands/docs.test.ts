/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { Command } from "commander";
import type { DocsAccess } from "@cocalc/docs";
import { registerDocsCommand, type DocsCommandDeps } from "./docs";

const OVERVIEW_ID = "docs.cocalc-at-a-glance";
const OVERVIEW_SLUG = "documentation/cocalc-at-a-glance";
const SITE_PROFILE = ["--site-profile", "cocalc-ai"];

type Row = {
  id: string;
  entry_id?: string;
  visibility?: string;
};

function harness() {
  const outputs: { label: string; data: unknown }[] = [];
  const errors: { label: string; message: string }[] = [];
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .option("--json")
    .option("--profile <name>")
    .option("--api <url>");
  const deps: DocsCommandDeps = {
    globalsFrom: (command: Command) => command.optsWithGlobals(),
    emitSuccess: (_context: unknown, label: string, data: unknown) => {
      outputs.push({ label, data });
    },
    emitError: (_context: unknown, label: string, error: unknown) => {
      errors.push({
        label,
        message: error instanceof Error ? error.message : String(error),
      });
    },
    normalizeUrl: (url: string) => url,
  };
  registerDocsCommand(program, deps);
  return {
    async run(args: string[]) {
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        await program.parseAsync(["--json", "docs", ...args], { from: "user" });
        return process.exitCode ?? 0;
      } finally {
        process.exitCode = previousExitCode;
      }
    },
    success<T>(): T {
      assert.deepEqual(errors, []);
      assert.equal(outputs.length, 1);
      return outputs[0].data as T;
    },
    error(): string {
      assert.deepEqual(outputs, []);
      assert.equal(errors.length, 1);
      return errors[0].message;
    },
  };
}

function forbidNetwork(t: TestContext) {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("bundled docs commands must not fetch");
  });
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
}

for (const identifier of [OVERVIEW_ID, OVERVIEW_SLUG]) {
  test(`docs show selects the cocalc.ai overview by ${identifier}`, async (t) => {
    forbidNetwork(t);
    const generic = harness();
    assert.equal(await generic.run(["show", identifier]), 1);
    assert.match(generic.error(), /documentation page not found/);

    const selected = harness();
    assert.equal(await selected.run(["show", identifier, ...SITE_PROFILE]), 0);
    assert.equal(selected.success<Row>().id, OVERVIEW_ID);
  });
}

const collectionCases = [
  { args: ["list"], entryId: OVERVIEW_ID },
  {
    args: ["search", "CoCalc at a glance", "--limit", "100"],
    entryId: OVERVIEW_ID,
  },
  {
    args: ["skill-context", "--query", "CoCalc at a glance", "--limit", "100"],
    entryId: OVERVIEW_ID,
  },
  { args: ["actions"], entryId: "projects.rstudio-project" },
];

for (const { args, entryId } of collectionCases) {
  test(`docs ${args[0]} includes site-specific results only when selected`, async (t) => {
    forbidNetwork(t);
    for (const selected of [false, true]) {
      const cli = harness();
      assert.equal(
        await cli.run([...args, ...(selected ? SITE_PROFILE : [])]),
        0,
      );
      const data = cli.success<Row[] | { entries: Row[] }>();
      const rows = Array.isArray(data) ? data : data.entries;
      assert.equal(
        rows.some((row) => (row.entry_id ?? row.id) === entryId),
        selected,
      );
    }
  });
}

test("docs action retains stable action lookup with a site profile", async (t) => {
  forbidNetwork(t);
  const cli = harness();
  assert.equal(
    await cli.run(["action", "docs.browser.open", ...SITE_PROFILE]),
    0,
  );
  assert.equal(cli.success<Row>().id, "docs.browser.open");
});

test("docs action forwards the site selector for a restricted action", async (t) => {
  forbidNetwork(t);
  // The only site-specific action ID also occurs on a generic page. Scope the
  // lookups to the real RStudio summary to exercise restricted action lookup.
  // The public exports are getters, so mock their underlying registry functions.
  const registry = require(
    join(dirname(require.resolve("@cocalc/docs")), "registry.js"),
  ) as Pick<typeof import("@cocalc/docs"), "listDocsActions" | "getDocsAction">;
  const listActions = registry.listDocsActions;
  const restrictedActions = (access?: DocsAccess) =>
    listActions(access).filter(
      (action) => action.entryId === "projects.rstudio-project",
    );
  t.mock.method(registry, "listDocsActions", restrictedActions);
  t.mock.method(registry, "getDocsAction", (id: string, access?: DocsAccess) =>
    restrictedActions(access).find((action) => action.id === id),
  );

  const generic = harness();
  assert.equal(await generic.run(["action", "projects.create.open"]), 1);
  assert.match(generic.error(), /documentation action not found/);

  const selected = harness();
  assert.equal(
    await selected.run(["action", "projects.create.open", ...SITE_PROFILE]),
    0,
  );
  assert.equal(selected.success<Row>().entry_id, "projects.rstudio-project");
});

const retrievalCases = [
  ["list"],
  ["search", "CoCalc"],
  ["skill-context"],
  ["actions"],
  ["action", "docs.browser.open"],
  ["show", "docs.browser"],
];

for (const args of retrievalCases) {
  test(`docs ${args[0]} rejects unsupported site profiles`, async (t) => {
    forbidNetwork(t);
    const cli = harness();
    assert.equal(await cli.run([...args, "--site-profile", "other-site"]), 1);
    assert.match(
      cli.error(),
      /invalid --site-profile 'other-site'; expected cocalc-ai/,
    );
  });
}

test("a site profile preserves admin, signed-in, and feature filtering", async (t) => {
  forbidNetwork(t);
  for (const includeAdmin of [false, true]) {
    const cli = harness();
    assert.equal(
      await cli.run([
        "list",
        ...SITE_PROFILE,
        ...(includeAdmin ? ["--include-admin"] : []),
      ]),
      0,
    );
    const rows = cli.success<Row[]>();
    assert.equal(
      rows.some((row) => row.id === "admin.site-settings"),
      includeAdmin,
    );
    assert.equal(
      rows.some((row) => row.id === "account.settings"),
      includeAdmin,
    );
    assert.equal(
      rows.some((row) => row.id === "projects.virtual-machines"),
      false,
    );
  }
});

for (const args of [
  ["show", "admin.site-settings"],
  ["action", "admin.site-settings.open"],
  ["show", "account.settings"],
  ["action", "account.profile.open"],
]) {
  test(`docs ${args[0]} keeps ${args[1]} behind --include-admin with a site profile`, async (t) => {
    forbidNetwork(t);
    const hidden = harness();
    assert.equal(await hidden.run([...args, ...SITE_PROFILE]), 1);
    assert.match(hidden.error(), /not found/);

    const included = harness();
    assert.equal(
      await included.run([...args, ...SITE_PROFILE, "--include-admin"]),
      0,
    );
    assert.equal(included.success<Row>().id, args[1]);
  });
}

for (const target of [
  ["--profile", "cocalc-ai"],
  ["--api", "https://cocalc.ai"],
]) {
  test(`${target[0]} does not implicitly select a docs site profile`, async (t) => {
    forbidNetwork(t);
    const cli = harness();
    assert.equal(await cli.run(["show", OVERVIEW_ID, ...target]), 1);
    assert.match(cli.error(), /documentation page not found/);

    const selected = harness();
    assert.equal(
      await selected.run(["show", OVERVIEW_ID, ...target, ...SITE_PROFILE]),
      0,
    );
    assert.equal(selected.success<Row>().id, OVERVIEW_ID);
  });
}
