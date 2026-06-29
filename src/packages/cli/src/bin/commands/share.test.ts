import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerShareCommand } from "./share";

const SHARE = {
  id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  path: "published/root",
  slug: "course/unit",
  visibility: "unlisted",
  requires_auth: true,
  availability_status: "available",
  available: true,
  read_policy: { rules: [] },
  site_license_grant_on_copy: false,
  site_license_copy_requires_grant: false,
  disabled: false,
  host_id: "host-id",
};

function commandWithDeps(overrides: Record<string, any> = {}) {
  const state: Record<string, any> = {
    hubCalls: [],
    output: undefined,
    catOutput: "",
  };
  const deps = {
    withContext: async (_command, _label, fn) => {
      state.output = await fn({
        globals: {},
        timeoutMs: 60_000,
        pollMs: 100,
      });
    },
    hubCallByName: async (_ctx, name, args) => {
      state.hubCalls.push({ name, args });
      if (name === "publicDirectoryShares.resolve") {
        const slug = args[0].slug;
        if (slug === SHARE.slug) return SHARE;
        throw new Error("public directory share not found");
      }
      if (name === "publicDirectoryShares.listDirectory") {
        return {
          share: SHARE,
          path: args[0].path,
          entries: [
            {
              name: "a.ipynb",
              path:
                args[0].path === "." ? "a.ipynb" : `${args[0].path}/a.ipynb`,
              isDir: false,
              size: 12,
            },
          ],
        };
      }
      if (name === "publicDirectoryShares.copyToProject") {
        return {
          destination_project_id: args[0].destination_project_id,
          op_id: "op-id",
          scope_type: "project",
          scope_id: args[0].destination_project_id,
          service: "persist",
          stream_name: "stream",
          captured: args[0],
        };
      }
      throw new Error(`unexpected call ${name}`);
    },
    resolveShareFilesystem: async () => ({
      readFile: async (path, encoding) =>
        encoding === "utf8" ? `read ${path}` : Buffer.from(`read ${path}`),
    }),
    emitProjectFileCatHumanContent: (content) => {
      state.catOutput += content;
    },
    writeFileLocal: async (path, data) => {
      state.written = { path, data };
    },
    mkdirLocal: async () => undefined,
    waitForLro: async () => ({ status: "succeeded" }),
    ...overrides,
  };
  const program = new Command();
  program.name("cocalc");
  registerShareCommand(program, deps as any);
  return { program, state };
}

test("share ls resolves the longest valid share prefix", async () => {
  const { program, state } = commandWithDeps();
  await program.parseAsync([
    "node",
    "cocalc",
    "share",
    "ls",
    "https://example.com/share/course/unit/subdir",
  ]);

  assert.deepEqual(
    state.hubCalls
      .filter((call) => call.name === "publicDirectoryShares.resolve")
      .map((call) => call.args[0].slug),
    ["course/unit/subdir", "course/unit"],
  );
  assert.deepEqual(state.hubCalls.at(-1), {
    name: "publicDirectoryShares.listDirectory",
    args: [{ slug: "course/unit", path: "subdir" }],
  });
  assert.deepEqual(state.output, [
    {
      name: "a.ipynb",
      path: "subdir/a.ipynb",
      is_dir: false,
      size: 12,
      mtime: null,
      link_target: null,
    },
  ]);
});

test("share cat reads through the scoped share filesystem", async () => {
  const { program, state } = commandWithDeps();
  await program.parseAsync([
    "node",
    "cocalc",
    "share",
    "cat",
    "--slug",
    "course/unit",
    "notebooks/a.ipynb",
  ]);

  assert.equal(state.catOutput, "read published/root/notebooks/a.ipynb");
  assert.equal(state.output, null);
});

test("share copy passes the selected relative path to the copy RPC", async () => {
  const { program, state } = commandWithDeps();
  await program.parseAsync([
    "node",
    "cocalc",
    "share",
    "copy",
    "--project",
    "destination-project",
    "--dest",
    "copied",
    "course/unit/notebooks",
  ]);

  const copyCall = state.hubCalls.find(
    (call) => call.name === "publicDirectoryShares.copyToProject",
  );
  assert.deepEqual(copyCall.args[0], {
    slug: "course/unit",
    path: "notebooks",
    destination_project_id: "destination-project",
    destination_path: "copied",
    options: { recursive: true },
  });
});
