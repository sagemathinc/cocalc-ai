import assert from "node:assert/strict";
import test from "node:test";

import { Command } from "commander";

import { registerMembershipCommand } from "./membership";

test("membership list defaults to the current account", async () => {
  let capturedArgs: any;
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            getMembershipPackages: async (opts) => {
              capturedArgs = opts;
              return [
                {
                  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                  owner_account_id: "11111111-1111-1111-1111-111111111111",
                  kind: "team",
                  membership_class: "pro",
                  seat_count: 2,
                  purchase_id: 9,
                  starts_at: "2026-05-01T00:00:00.000Z",
                  expires_at: "2026-06-01T00:00:00.000Z",
                  metadata: { interval: "month", seat_price: 20 },
                  created: "2026-05-01T00:00:00.000Z",
                  updated: "2026-05-02T00:00:00.000Z",
                  active_assignment_count: 1,
                  available_seat_count: 1,
                  assignments: [
                    {
                      id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                      package_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                      account_id: "22222222-2222-2222-2222-222222222222",
                    },
                  ],
                },
              ];
            },
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an explicit account");
    },
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync(["node", "test", "membership", "list"]);

  assert.deepEqual(capturedArgs, {
    account_id: "11111111-1111-1111-1111-111111111111",
  });
  assert.equal(
    captured?.[0]?.package_id,
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  );
  assert.equal(captured?.[0]?.kind, "team");
  assert.equal(captured?.[0]?.active_assignment_count, 1);
  assert.equal(captured?.[0]?.available_seat_count, 1);
  assert.equal("assignment_targets" in captured?.[0], false);
  assert.equal("seat_price" in captured?.[0], false);
});

test("membership list --wide keeps the broader summary shape", async () => {
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            getMembershipPackages: async () => [
              {
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                owner_account_id: "11111111-1111-1111-1111-111111111111",
                kind: "team",
                membership_class: "pro",
                seat_count: 2,
                purchase_id: 9,
                starts_at: "2026-05-01T00:00:00.000Z",
                expires_at: "2026-06-01T00:00:00.000Z",
                metadata: { interval: "month", seat_price: 20 },
                created: "2026-05-01T00:00:00.000Z",
                updated: "2026-05-02T00:00:00.000Z",
                active_assignment_count: 1,
                available_seat_count: 1,
                assignments: [
                  {
                    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    package_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    account_id: "22222222-2222-2222-2222-222222222222",
                  },
                ],
              },
            ],
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an explicit account");
    },
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync(["node", "test", "membership", "list", "--wide"]);

  assert.equal(
    captured?.[0]?.assignment_targets,
    "22222222-2222-2222-2222-222222222222",
  );
  assert.equal(captured?.[0]?.seat_price, 20);
  assert.equal(captured?.[0]?.interval, "month");
});

test("membership list resolves an explicit owner account", async () => {
  let capturedArgs: any;
  let resolvedIdentifier: string | undefined;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            getMembershipPackages: async (opts) => {
              capturedArgs = opts;
              return [];
            },
          },
        },
      };
      await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async (_ctx, identifier) => {
      resolvedIdentifier = identifier;
      return {
        account_id: "33333333-3333-3333-3333-333333333333",
      };
    },
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "list",
    "owner@example.com",
  ]);

  assert.equal(resolvedIdentifier, "owner@example.com");
  assert.deepEqual(capturedArgs, {
    account_id: "11111111-1111-1111-1111-111111111111",
    user_account_id: "33333333-3333-3333-3333-333333333333",
  });
});

test("membership show returns the full matching package", async () => {
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            getMembershipPackages: async () => [
              {
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                owner_account_id: "11111111-1111-1111-1111-111111111111",
                kind: "site",
                membership_class: "pro",
                seat_count: 10,
                metadata: { allowed_domains: ["example.edu"] },
                active_assignment_count: 0,
                available_seat_count: 10,
                assignments: [],
              },
            ],
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an explicit account");
    },
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "show",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  ]);

  assert.equal(captured?.package_id, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  assert.deepEqual(captured?.allowed_domains, ["example.edu"]);
  assert.deepEqual(captured?.assignments, []);
});

test("membership quote resolves course projects and metadata json", async () => {
  let capturedArgs: any;
  let resolvedProject: string | undefined;
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            getMembershipPackageQuote: async (opts) => {
              capturedArgs = opts;
              return {
                kind: "course",
                membership_class: "student",
                seat_count: 12,
                seat_price: 25,
                total_price: 300,
                starts_at: "2026-09-01T00:00:00.000Z",
                expires_at: "2026-12-15T00:00:00.000Z",
                metadata: opts.metadata,
              };
            },
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an account");
    },
    resolveProject: async (_ctx, identifier) => {
      resolvedProject = identifier;
      return {
        project_id: "44444444-4444-4444-4444-444444444444",
      };
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "quote",
    "--kind",
    "course",
    "--membership-class",
    "student",
    "--seat-count",
    "12",
    "--course-project",
    "cs-course",
    "--metadata-json",
    '{"source":"cli"}',
  ]);

  assert.equal(resolvedProject, "cs-course");
  assert.deepEqual(capturedArgs, {
    account_id: "11111111-1111-1111-1111-111111111111",
    package_id: undefined,
    kind: "course",
    membership_class: "student",
    seat_count: 12,
    interval: undefined,
    course_project_id: "44444444-4444-4444-4444-444444444444",
    starts_at: undefined,
    expires_at: undefined,
    metadata: { source: "cli" },
  });
  assert.equal(captured?.total_price, 300);
});

test("membership buy refuses to run without --yes", async () => {
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            purchaseMembershipPackage: async () => {
              throw new Error("should not purchase without --yes");
            },
          },
        },
      };
      await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an account");
    },
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await assert.rejects(
    () =>
      program.parseAsync([
        "node",
        "test",
        "membership",
        "buy",
        "--kind",
        "team",
        "--membership-class",
        "pro",
        "--seat-count",
        "2",
        "--interval",
        "month",
      ]),
    /without --yes/i,
  );
});

test("membership assign resolves target account and project metadata", async () => {
  let resolvedAccount: string | undefined;
  let resolvedProject: string | undefined;
  let capturedArgs: any;
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            assignMembershipPackageSeat: async (opts) => {
              capturedArgs = opts;
              return {
                id: "55555555-5555-5555-5555-555555555555",
                package_id: opts.package_id,
                account_id: opts.target_account_id,
                metadata: opts.metadata,
              };
            },
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async (_ctx, identifier) => {
      resolvedAccount = identifier;
      return {
        account_id: "22222222-2222-2222-2222-222222222222",
      };
    },
    resolveProject: async (_ctx, identifier) => {
      resolvedProject = identifier;
      return {
        project_id: "44444444-4444-4444-4444-444444444444",
      };
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "assign",
    "--package",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "--target-account",
    "student@example.com",
    "--project",
    "student-project",
    "--metadata-json",
    '{"course_role":"student"}',
  ]);

  assert.equal(resolvedAccount, "student@example.com");
  assert.equal(resolvedProject, "student-project");
  assert.deepEqual(capturedArgs, {
    account_id: "11111111-1111-1111-1111-111111111111",
    package_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    target_account_id: "22222222-2222-2222-2222-222222222222",
    target_email_address: undefined,
    metadata: {
      course_role: "student",
      project_id: "44444444-4444-4444-4444-444444444444",
    },
  });
  assert.equal(captured?.account_id, "22222222-2222-2222-2222-222222222222");
});

test("membership claimable and claim use the current account", async () => {
  let claimableArgs: any;
  let claimArgs: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
            getClaimableMembershipPackages: async (opts) => {
              claimableArgs = opts;
              return [
                {
                  package_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                  kind: "team",
                  membership_class: "pro",
                  owner_account_id: "99999999-9999-9999-9999-999999999999",
                  available_seat_count: 1,
                  matched_email_address: "student@example.com",
                  reason: "email-assignment",
                },
              ];
            },
            claimMembershipPackageSeat: async (opts) => {
              claimArgs = opts;
              return {
                id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                package_id: opts.package_id,
                account_id: opts.account_id,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an account");
    },
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync(["node", "test", "membership", "claimable"]);
  assert.deepEqual(claimableArgs, {
    account_id: "11111111-1111-1111-1111-111111111111",
  });

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "claim",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  ]);
  assert.deepEqual(claimArgs, {
    account_id: "11111111-1111-1111-1111-111111111111",
    package_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  });
});
