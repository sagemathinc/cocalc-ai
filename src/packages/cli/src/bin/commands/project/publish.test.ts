import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerProjectPublishCommands } from "./publish";

test("project publish calls public directory share create API", async () => {
  let captured: any;
  let output: any;
  const deps = {
    withContext: async (_command, _label, fn) => {
      const ctx = {};
      output = await fn(ctx);
    },
    hubCallByName: async (_ctx, name, args) => {
      assert.equal(name, "publicDirectoryShares.create");
      captured = args[0];
      return {
        id: "share-id",
        project_id: captured.project_id,
        path: captured.path,
        slug: captured.slug,
        visibility: "unlisted",
        requires_auth: true,
        availability_status: "available",
        site_license_grant_on_copy: false,
        site_license_copy_requires_grant: false,
        disabled: false,
      };
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project ?? "project-id",
      title: "Project",
    }),
  };

  const program = new Command();
  program.name("cocalc");
  const project = program.command("project");
  registerProjectPublishCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "cocalc",
    "project",
    "publish",
    "/home/user/x",
    "--project",
    "project-id",
    "--slug",
    "Cambridge/Book Code",
    "--title",
    "Book Code",
    "--description",
    "Examples",
  ]);

  assert.deepEqual(captured, {
    project_id: "project-id",
    path: "/home/user/x",
    slug: "Cambridge/Book Code",
    title: "Book Code",
    description: "Examples",
    license: undefined,
    site_license_grant_on_copy: false,
    site_license_copy_requires_grant: true,
    site_license_id: undefined,
    site_license_pool_id: undefined,
    site_license_duration_days: undefined,
  });
  assert.equal(output.url_path, "/share/Cambridge/Book%20Code");
});

test("project publish enables site-license grants from pool option", async () => {
  let captured: any;
  const deps = {
    withContext: async (_command, _label, fn) => {
      await fn({});
    },
    hubCallByName: async (_ctx, name, args) => {
      assert.equal(name, "publicDirectoryShares.create");
      captured = args[0];
      return {
        id: "share-id",
        project_id: captured.project_id,
        path: captured.path,
        slug: captured.slug,
        visibility: "unlisted",
        requires_auth: true,
        availability_status: "available",
        site_license_grant_on_copy: true,
        site_license_copy_requires_grant: false,
        disabled: false,
      };
    },
    resolveProjectFromArgOrContext: async (_ctx, project) => ({
      project_id: project ?? "project-id",
      title: "Project",
    }),
  };

  const program = new Command();
  program.name("cocalc");
  const project = program.command("project");
  registerProjectPublishCommands(project, deps as any);

  await program.parseAsync([
    "node",
    "cocalc",
    "project",
    "publish",
    "x",
    "--slug",
    "cambridge/x",
    "--site-license-id",
    "site-license-id",
    "--site-license-pool",
    "pool-id",
    "--site-license-duration-days",
    "14",
    "--no-copy-requires-grant",
  ]);

  assert.equal(captured.site_license_grant_on_copy, true);
  assert.equal(captured.site_license_copy_requires_grant, false);
  assert.equal(captured.site_license_id, "site-license-id");
  assert.equal(captured.site_license_pool_id, "pool-id");
  assert.equal(captured.site_license_duration_days, 14);
});
