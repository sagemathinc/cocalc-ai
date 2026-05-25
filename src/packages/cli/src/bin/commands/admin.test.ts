import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Command } from "commander";

import {
  buildEntitlementOverrideSchemaDoc,
  registerAdminCommand,
} from "./admin";

function adminDeps(overrides: Record<string, any> = {}) {
  return {
    withContext: async (_command: unknown, _label: string, fn: any) => {
      const ctx = {
        hub: {
          system: {},
          messages: {},
          db: {},
        },
      };
      Object.assign(ctx.hub.system, overrides.system ?? {});
      Object.assign(ctx.hub.messages, overrides.messages ?? {});
      Object.assign(ctx.hub.db, overrides.db ?? {});
      return await fn(ctx);
    },
    resolveAccountByIdentifier: async (_ctx: unknown, identifier: string) => ({
      account_id:
        identifier === "alice@example.com"
          ? "22222222-2222-4222-8222-222222222222"
          : "33333333-3333-4333-8333-333333333333",
    }),
    isValidUUID: (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ),
  };
}

test("admin entitlement-override get resolves a user and fetches override", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        getAccountEntitlementOverride: async (opts: any) => {
          capturedArgs = opts;
          return {
            account_id: opts.user_account_id,
            enabled: true,
            updated_by: "admin",
            updated_at: "2026-05-10T00:00:00.000Z",
          };
        },
      },
    }) as any,
  );

  program.exitOverride();
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "entitlement-override",
    "get",
    "alice@example.com",
  ]);

  assert.deepEqual(capturedArgs, {
    user_account_id: "22222222-2222-4222-8222-222222222222",
  });
});

test("admin entitlement-override set reads JSON file and forwards reason and expiration", async () => {
  let capturedArgs: any;
  const dir = await mkdtemp(join(tmpdir(), "cocalc-cli-admin-"));
  const file = join(dir, "override.json");
  await writeFile(
    file,
    JSON.stringify({
      enabled: true,
      usage_limits: {
        max_projects: { mode: "minimum", value: 50 },
      },
    }),
    "utf8",
  );
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        setAccountEntitlementOverride: async (opts: any) => {
          capturedArgs = opts;
          return {
            account_id: opts.user_account_id,
            ...opts.override,
            reason: opts.reason,
            updated_by: "admin",
            updated_at: "2026-05-10T00:00:00.000Z",
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "entitlement-override",
    "set",
    "alice@example.com",
    "--file",
    file,
    "--reason",
    "smoke test",
    "--expires-at",
    "2026-05-11T12:00:00Z",
  ]);

  assert.deepEqual(capturedArgs, {
    user_account_id: "22222222-2222-4222-8222-222222222222",
    reason: "smoke test",
    override: {
      enabled: true,
      usage_limits: {
        max_projects: { mode: "minimum", value: 50 },
      },
      expires_at: "2026-05-11T12:00:00.000Z",
    },
  });
});

test("admin entitlement-override clear uses UUID targets without search", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        clearAccountEntitlementOverride: async (opts: any) => {
          capturedArgs = opts;
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "entitlement-override",
    "clear",
    "11111111-1111-4111-8111-111111111111",
    "--reason",
    "cleanup",
  ]);

  assert.deepEqual(capturedArgs, {
    user_account_id: "11111111-1111-4111-8111-111111111111",
    reason: "cleanup",
  });
});

test("admin entitlement-override schema documents usable override payloads", async () => {
  const schema = buildEntitlementOverrideSchemaDoc();

  assert.match(JSON.stringify(schema), /project_defaults\.disk_quota/);
  assert.match(
    JSON.stringify(schema),
    /usage_limits\.credit_spend_limit_7d_usd/,
  );
  assert.equal(
    (schema as any).numeric_rule.modes.minimum,
    "Use the override value only when it is higher than the membership value.",
  );

  let output = "";
  const originalWrite = process.stdout.write;
  (process.stdout.write as any) = (chunk: unknown) => {
    output += String(chunk);
    return true;
  };
  try {
    const program = new Command();
    registerAdminCommand(program, adminDeps() as any);
    await program.parseAsync([
      "node",
      "test",
      "admin",
      "entitlement-override",
      "schema",
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }

  const parsed = JSON.parse(output);
  assert.equal(
    parsed.set_command,
    "cocalc admin entitlement-override set <user> --file override.json --reason <reason> [--expires-at <iso|none|never>]",
  );
});

test("admin acp-denials forwards filters to the hub report endpoint", async () => {
  let captured: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        getAcpAdmissionDenialReport: async (opts: any) => {
          captured = opts;
          return {
            checked_at: "2026-05-11T00:00:00.000Z",
            since: "2026-05-10T23:00:00.000Z",
            window_minutes: opts.window_minutes,
            min_count: opts.min_count,
            groups: [
              {
                account_id: opts.user_account_id,
                project_id: opts.project_id,
                limit: opts.denial_limit,
                source: opts.source,
                count: 7,
                first_time: "2026-05-10T23:30:00.000Z",
                last_time: "2026-05-10T23:59:00.000Z",
                max_current: 10,
                max_maximum: 10,
              },
            ],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "acp-denials",
    "--window-minutes",
    "30",
    "--min-count",
    "3",
    "--limit",
    "25",
    "--account",
    "alice@example.com",
    "--project",
    "11111111-1111-4111-8111-111111111111",
    "--denial-limit",
    "queued_per_account",
    "--source",
    "chat",
  ]);

  assert.deepEqual(captured, {
    window_minutes: 30,
    min_count: 3,
    limit: 25,
    user_account_id: "22222222-2222-4222-8222-222222222222",
    project_id: "11111111-1111-4111-8111-111111111111",
    denial_limit: "queued_per_account",
    source: "chat",
  });
});

test("admin membership-tiers queries tier usage counts and formats rows", async () => {
  let captured: any;
  let formatted: any;
  const program = new Command();
  registerAdminCommand(program, {
    ...adminDeps(),
    withContext: async (_command: unknown, _label: string, fn: any) => {
      formatted = await fn({
        hub: {
          db: {
            userQuery: async (opts: any) => {
              captured = opts;
              return {
                membership_tiers: [
                  {
                    id: "student",
                    label: "Student",
                    store_visible: true,
                    course_store_visible: false,
                    priority: 10,
                    price_monthly: "5",
                    price_yearly: "50",
                    course_price: "20",
                    course_duration_days: 180,
                    course_grace_days: 7,
                    disabled: false,
                    subscription_count: "3",
                    subscribed_account_count: "2",
                    admin_assigned_count: "4",
                    site_license_count: "1",
                    updated: "2026-05-22T00:00:00.000Z",
                  },
                ],
              };
            },
          },
        },
      });
    },
  } as any);

  await program.parseAsync(["node", "test", "admin", "membership-tiers"]);

  assert.deepEqual(captured.query.membership_tiers, {
    id: "*",
    label: null,
    store_visible: null,
    course_store_visible: null,
    priority: null,
    price_monthly: null,
    price_yearly: null,
    trial_days: null,
    course_price: null,
    course_duration_days: null,
    course_grace_days: null,
    disabled: null,
    subscription_count: null,
    subscribed_account_count: null,
    admin_assigned_count: null,
    site_license_count: null,
    updated: null,
  });
  assert.deepEqual(formatted, [
    {
      id: "student",
      label: "Student",
      monthly: "$5.00",
      yearly: "$50.00",
      trial: "",
      subs: 3,
      accounts: 2,
      admin: 4,
      licenses: 1,
      active: "yes",
    },
  ]);
});

test("admin membership-tiers --wide includes diagnostic columns", async () => {
  let formatted: any;
  const program = new Command();
  registerAdminCommand(program, {
    ...adminDeps(),
    withContext: async (_command: unknown, _label: string, fn: any) => {
      formatted = await fn({
        hub: {
          db: {
            userQuery: async () => ({
              membership_tiers: [
                {
                  id: "student",
                  label: "Student",
                  store_visible: true,
                  course_store_visible: false,
                  priority: 10,
                  price_monthly: "5",
                  price_yearly: "50",
                  course_price: "20",
                  course_duration_days: 180,
                  course_grace_days: 7,
                  disabled: false,
                  subscription_count: "3",
                  subscribed_account_count: "2",
                  admin_assigned_count: "4",
                  site_license_count: "1",
                  updated: "2026-05-22T00:00:00.000Z",
                },
              ],
            }),
          },
        },
      });
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "membership-tiers",
    "--wide",
  ]);

  assert.deepEqual(formatted, [
    {
      id: "student",
      label: "Student",
      visible: "yes",
      course: "no",
      priority: 10,
      monthly: "$5.00",
      yearly: "$50.00",
      trial_days: "",
      course_price: "$20.00",
      course_days: 180,
      grace_days: 7,
      subscriptions: 3,
      subscribed_accounts: 2,
      admin_assigned: 4,
      site_licenses: 1,
      active: "yes",
      updated: "2026-05-22T00:00:00.000Z",
    },
  ]);
});

test("admin membership-tiers can emit prometheus gauges", async () => {
  let output = "";
  const program = new Command();
  registerAdminCommand(program, {
    ...adminDeps(),
    withContext: async (_command: unknown, _label: string, fn: any) => {
      output = await fn({
        hub: {
          db: {
            userQuery: async () => ({
              membership_tiers: [
                {
                  id: "instructor",
                  label: "Instructor",
                  subscription_count: 8,
                  subscribed_account_count: 7,
                  admin_assigned_count: 2,
                  site_license_count: 3,
                },
              ],
            }),
          },
        },
      });
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "membership-tiers",
    "--prometheus",
  ]);

  assert.match(output, /cocalc_membership_tier_subscriptions/);
  assert.match(output, /tier_id="instructor"/);
  assert.match(output, /cocalc_membership_tier_subscribed_accounts.* 7/);
  assert.match(output, /cocalc_membership_tier_admin_assigned.* 2/);
  assert.match(output, /cocalc_membership_tier_site_licenses.* 3/);
});

test("admin acp-denials can emit prometheus text", async () => {
  let output = "";
  const program = new Command();
  registerAdminCommand(program, {
    withContext: async (_command, _label, fn) => {
      output = await fn({
        hub: {
          system: {
            getAcpAdmissionDenialReport: async () => ({
              checked_at: "2026-05-11T00:00:00.000Z",
              since: "2026-05-10T23:00:00.000Z",
              window_minutes: 60,
              min_count: 1,
              groups: [
                {
                  bay_id: "bay-1",
                  account_id: "acct",
                  project_id: "project",
                  limit: "running_per_account",
                  source: "claim",
                  count: 4,
                  first_time: "2026-05-10T23:30:00.000Z",
                  last_time: "2026-05-10T23:59:00.000Z",
                  max_current: 8,
                  max_maximum: 8,
                },
              ],
            }),
          },
        },
      });
    },
    resolveAccountByIdentifier: async () => {
      throw new Error("not used");
    },
    isValidUUID: () => false,
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "acp-denials",
    "--prometheus",
  ]);

  assert.match(output, /cocalc_acp_admission_denials_window_total/);
  assert.match(output, /bay_id="bay-1"/);
  assert.match(output, /limit="running_per_account"/);
  assert.match(output, / 4\n/);
});

test("admin service-denials forwards filters to the hub report endpoint", async () => {
  let captured: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        getServiceAdmissionDenialReport: async (opts: any) => {
          captured = opts;
          return {
            checked_at: "2026-05-11T00:00:00.000Z",
            since: "2026-05-10T23:00:00.000Z",
            window_minutes: opts.window_minutes,
            min_count: opts.min_count,
            groups: [],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "service-denials",
    "--window-minutes",
    "30",
    "--min-count",
    "3",
    "--limit",
    "25",
    "--account",
    "alice@example.com",
    "--project",
    "11111111-1111-4111-8111-111111111111",
    "--surface",
    "hub-conat-api",
    "--denial-limit",
    "COCALC_HUB_CONAT_API_MAX_ACTIVE",
    "--source",
    "hub-api",
  ]);

  assert.deepEqual(captured, {
    window_minutes: 30,
    min_count: 3,
    limit: 25,
    user_account_id: "22222222-2222-4222-8222-222222222222",
    project_id: "11111111-1111-4111-8111-111111111111",
    surface: "hub-conat-api",
    denial_limit: "COCALC_HUB_CONAT_API_MAX_ACTIVE",
    source: "hub-api",
  });
});

test("admin service-denials can emit prometheus text", async () => {
  let output = "";
  const program = new Command();
  registerAdminCommand(program, {
    withContext: async (_command, _label, fn) => {
      output = await fn({
        hub: {
          system: {
            getServiceAdmissionDenialReport: async () => ({
              checked_at: "2026-05-11T00:00:00.000Z",
              since: "2026-05-10T23:00:00.000Z",
              window_minutes: 60,
              min_count: 1,
              groups: [
                {
                  bay_id: "bay-1",
                  host_id: "host",
                  account_id: "acct",
                  project_id: "project",
                  surface: "jupyter-run-code",
                  limit: "COCALC_JUPYTER_MAX_ACTIVE_RUNS",
                  source: "project-service",
                  count: 4,
                  first_time: "2026-05-10T23:30:00.000Z",
                  last_time: "2026-05-10T23:59:00.000Z",
                  max_current: 8,
                  max_maximum: 8,
                },
              ],
            }),
          },
        },
      });
    },
    resolveAccountByIdentifier: async () => {
      throw new Error("not used");
    },
    isValidUUID: () => false,
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "service-denials",
    "--prometheus",
  ]);

  assert.match(output, /cocalc_service_admission_denials_window_total/);
  assert.match(output, /bay_id="bay-1"/);
  assert.match(output, /surface="jupyter-run-code"/);
  assert.match(output, / 4\n/);
});

test("admin rootfs-quotas forwards filters to the hub report endpoint", async () => {
  let captured: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        getRootfsQuotaReport: async (opts: any) => {
          captured = opts;
          return {
            checked_at: "2026-05-11T00:00:00.000Z",
            since: "2026-05-10T23:00:00.000Z",
            window_minutes: opts.window_minutes,
            min_count: opts.min_count,
            near_percent: opts.near_percent,
            top_users: [],
            near_limit_users: [],
            denials: [],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "rootfs-quotas",
    "--limit",
    "25",
    "--near-percent",
    "90",
    "--window-minutes",
    "30",
    "--min-count",
    "2",
    "--account",
    "alice@example.com",
    "--denial-limit",
    "rootfs_total_storage_gb",
    "--operation",
    "publish",
  ]);

  assert.deepEqual(captured, {
    limit: 25,
    near_percent: 90,
    window_minutes: 30,
    min_count: 2,
    user_account_id: "22222222-2222-4222-8222-222222222222",
    denial_limit: "rootfs_total_storage_gb",
    operation: "publish",
  });
});

test("admin rootfs-quotas can emit prometheus text", async () => {
  let output = "";
  const program = new Command();
  registerAdminCommand(program, {
    withContext: async (_command, _label, fn) => {
      output = await fn({
        hub: {
          system: {
            getRootfsQuotaReport: async () => ({
              checked_at: "2026-05-11T00:00:00.000Z",
              since: "2026-05-10T23:00:00.000Z",
              window_minutes: 60,
              min_count: 1,
              near_percent: 80,
              top_users: [
                {
                  bay_id: "bay-1",
                  account_id: "acct",
                  count: 3,
                  total_storage_bytes: 4000000000,
                  max_rootfs_bytes: 2000000000,
                },
              ],
              near_limit_users: [
                {
                  bay_id: "bay-1",
                  account_id: "acct",
                  count: 3,
                  total_storage_bytes: 4000000000,
                  max_rootfs_bytes: 2000000000,
                  count_ratio: 1,
                  total_storage_ratio: 0.8,
                },
              ],
              denials: [
                {
                  bay_id: "bay-1",
                  account_id: "acct",
                  limit: "rootfs_count",
                  operation: "publish",
                  reason: "too many root filesystem images",
                  count: 2,
                  first_time: "2026-05-10T23:30:00.000Z",
                  last_time: "2026-05-10T23:59:00.000Z",
                  max_current: 3,
                  max_maximum: 3,
                  max_requested: 1,
                },
              ],
            }),
          },
        },
      });
    },
    resolveAccountByIdentifier: async () => {
      throw new Error("not used");
    },
    isValidUUID: () => false,
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "rootfs-quotas",
    "--prometheus",
  ]);

  assert.match(output, /cocalc_rootfs_quota_usage_count/);
  assert.match(output, /cocalc_rootfs_quota_near_limit_ratio/);
  assert.match(output, /cocalc_rootfs_quota_denials_window_total/);
  assert.match(output, /bay_id="bay-1"/);
  assert.match(output, /limit="rootfs_count"/);
  assert.match(output, / 2\n/);
});

test("admin message send-system-notice forwards the system notice payload", async () => {
  let captured: any;
  const program = new Command();
  registerAdminCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        hub: {
          messages: {
            sendSystemNotice: async (opts: any) => {
              captured = opts;
              return 123;
            },
          },
        },
      };
      return await fn(ctx);
    },
    resolveAccountByIdentifier: async () => {
      throw new Error("not used");
    },
    normalizeUrl: (value: string) => value,
    isValidUUID: () => false,
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "message",
    "send-system-notice",
    "--target",
    "11111111-1111-4111-8111-111111111111",
    "--target",
    "user@example.com",
    "--subject",
    "Maintenance",
    "--body-markdown",
    "Tonight",
    "--dedup-minutes",
    "30",
  ]);

  assert.deepEqual(captured, {
    to_ids: ["11111111-1111-4111-8111-111111111111", "user@example.com"],
    subject: "Maintenance",
    body: "Tonight",
    dedupMinutes: 30,
  });
});
