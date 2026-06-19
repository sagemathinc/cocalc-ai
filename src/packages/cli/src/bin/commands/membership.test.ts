import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("membership claim forwards accepted terms when requested", async () => {
  let claimArgs: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "11111111-1111-1111-1111-111111111111",
        hub: {
          purchases: {
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

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "claim",
    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    "--accepted-terms",
  ]);

  assert.deepEqual(claimArgs, {
    account_id: "11111111-1111-1111-1111-111111111111",
    package_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    accepted_terms: true,
  });
});

test("membership site-license provision parses pools and owner", async () => {
  let resolvedOwner: string | undefined;
  let capturedArgs: any;
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "admin-1",
        hub: {
          purchases: {
            adminProvisionSiteLicense: async (opts) => {
              capturedArgs = opts;
              return {
                site_license: {
                  id: "license-1",
                  owner_account_id: opts.owner_account_id,
                  name: opts.name,
                  organization_name: opts.organization_name,
                  allowed_domains: opts.allowed_domains,
                },
                pools: [],
                managers: [],
                pending_requests: [],
              };
            },
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async (_ctx, identifier) => {
      resolvedOwner = identifier;
      return { account_id: "owner-1" };
    },
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "provision",
    "--owner",
    "owner@example.edu",
    "--name",
    "Campus Pilot",
    "--organization-name",
    "Example University",
    "--domain",
    "Example.EDU,@dept.example.edu",
    "--pools-json",
    '[{"pool_name":"Student","membership_class":"student","seat_count":5000,"requires_approval":false,"verification_policy":"email-domain"},{"pool_name":"Instructor","membership_class":"instructor","seat_count":200,"requires_approval":true,"verification_policy":"manager-approval","exclusive_group":"teaching"}]',
    "--custom-terms-url",
    "https://example.edu/terms",
  ]);

  assert.equal(resolvedOwner, "owner@example.edu");
  assert.equal(captured?.site_license?.id, "license-1");
  assert.deepEqual(capturedArgs, {
    account_id: "admin-1",
    owner_account_id: "owner-1",
    name: "Campus Pilot",
    organization_name: "Example University",
    allowed_domains: ["dept.example.edu", "example.edu"],
    pools: [
      {
        pool_name: "Student",
        membership_class: "student",
        seat_count: 5000,
        requires_approval: false,
        verification_policy: "email-domain",
        exclusive_group: undefined,
        affiliation_reverification_days: undefined,
        affiliation_reverification_grace_days: undefined,
        allowed_domains: undefined,
        metadata: undefined,
      },
      {
        pool_name: "Instructor",
        membership_class: "instructor",
        seat_count: 200,
        requires_approval: true,
        verification_policy: "manager-approval",
        exclusive_group: "teaching",
        affiliation_reverification_days: undefined,
        affiliation_reverification_grace_days: undefined,
        allowed_domains: undefined,
        metadata: undefined,
      },
    ],
    custom_terms_url: "https://example.edu/terms",
    custom_policy_url: undefined,
    terms_version_label: undefined,
    renewal_policy: undefined,
    overage_policy: undefined,
    starts_at: undefined,
    expires_at: undefined,
    metadata: null,
  });
});

test("membership site-license overview routes by owner", async () => {
  let capturedArgs: any;
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "manager-1",
        hub: {
          purchases: {
            getSiteLicenseOverview: async (opts) => {
              capturedArgs = opts;
              return {
                site_license: {
                  id: opts.site_license_id,
                  owner_account_id: opts.owner_account_id,
                  name: "Campus",
                  organization_name: "Example University",
                  allowed_domains: ["example.edu"],
                },
                pools: [],
                managers: [],
                pending_requests: [],
              };
            },
          },
        },
      };
      captured = await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => ({ account_id: "owner-1" }),
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "overview",
    "license-1",
    "--owner",
    "owner@example.edu",
  ]);

  assert.deepEqual(capturedArgs, {
    account_id: "manager-1",
    owner_account_id: "owner-1",
    site_license_id: "license-1",
  });
  assert.equal(captured?.site_license?.id, "license-1");
});

test("membership site-license request and review call site-license APIs", async () => {
  let requestArgs: any;
  let reviewArgs: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "user-1",
        hub: {
          purchases: {
            requestSiteLicensePool: async (opts) => {
              requestArgs = opts;
              return {
                id: "request-1",
                site_license_id: "license-1",
                package_id: opts.package_id,
                account_id: opts.account_id,
                matched_email_address: "ada@example.edu",
                canonical_identity: "ada@example.edu",
                requested_membership_class: "instructor",
                state: "pending",
                requester_note: opts.requester_note,
              };
            },
            reviewSiteLicensePoolRequest: async (opts) => {
              reviewArgs = opts;
              return {
                id: opts.request_id,
                site_license_id: "license-1",
                package_id: "pool-1",
                account_id: "user-1",
                matched_email_address: "ada@example.edu",
                canonical_identity: "ada@example.edu",
                requested_membership_class: "instructor",
                state: "approved",
                review_note: opts.review_note,
              };
            },
          },
        },
      };
      return await fn(ctx);
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => ({ account_id: "owner-1" }),
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "request",
    "--owner",
    "owner@example.edu",
    "--package",
    "pool-1",
    "--note",
    "Teaching Math 101",
    "--accepted-terms",
  ]);
  assert.deepEqual(requestArgs, {
    account_id: "user-1",
    owner_account_id: "owner-1",
    package_id: "pool-1",
    requester_note: "Teaching Math 101",
    accepted_terms: true,
  });

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "review",
    "request-1",
    "--owner",
    "owner@example.edu",
    "--action",
    "approve",
    "--note",
    "Confirmed",
  ]);
  assert.deepEqual(reviewArgs, {
    account_id: "user-1",
    owner_account_id: "owner-1",
    request_id: "request-1",
    action: "approve",
    review_note: "Confirmed",
  });
});

test("membership site-license external-pool create parses claim pool options", async () => {
  let capturedArgs: any;
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "admin-1",
        hub: {
          purchases: {
            createSiteLicenseExternalClaimPool: async (opts) => {
              capturedArgs = opts;
              return {
                id: "claim-pool-1",
                site_license_id: opts.site_license_id,
                package_id: opts.package_id,
                name: opts.name,
                issuer: opts.issuer,
                audience: opts.audience,
                slug: opts.slug,
                default_membership_class: opts.default_membership_class,
                allow_membership_class_override:
                  opts.allow_membership_class_override,
                default_membership_duration_days:
                  opts.default_membership_duration_days,
                allow_membership_expires_at_override:
                  opts.allow_membership_expires_at_override,
                max_claims: opts.max_claims,
                max_claims_per_account: opts.max_claims_per_account,
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
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "external-pool",
    "create",
    "--site-license",
    "license-1",
    "--package",
    "package-1",
    "--name",
    "Instructor LMS",
    "--issuer",
    "https://lms.example.edu",
    "--slug",
    "instructor-lms",
    "--audience",
    "cocalc-site-license",
    "--default-membership-class",
    "instructor",
    "--allow-membership-class-override",
    "--default-membership-duration-days",
    "90",
    "--allow-membership-expires-at-override",
    "--max-claims",
    "500",
    "--max-claims-per-account",
    "2",
    "--metadata-json",
    '{"integration":"canvas"}',
  ]);

  assert.deepEqual(capturedArgs, {
    account_id: "admin-1",
    site_license_id: "license-1",
    package_id: "package-1",
    name: "Instructor LMS",
    issuer: "https://lms.example.edu",
    slug: "instructor-lms",
    audience: "cocalc-site-license",
    default_membership_class: "instructor",
    allow_membership_class_override: true,
    default_membership_duration_days: 90,
    default_membership_expires_at: undefined,
    allow_membership_expires_at_override: true,
    min_membership_duration_days: undefined,
    max_membership_duration_days: undefined,
    max_membership_expires_at: undefined,
    default_rootfs_id: undefined,
    max_claims: 500,
    max_claims_per_account: 2,
    starts_at: undefined,
    expires_at: undefined,
    disabled_at: undefined,
    metadata: { integration: "canvas" },
  });
  assert.equal(captured?.pool_id, "claim-pool-1");
  assert.equal(captured?.metadata?.integration, "canvas");
});

test("membership site-license external-key add parses key material", async () => {
  let capturedArgs: any;
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "admin-1",
        hub: {
          purchases: {
            addSiteLicenseExternalClaimKey: async (opts) => {
              capturedArgs = opts;
              return {
                id: "key-1",
                pool_id: opts.pool_id,
                kid: opts.kid,
                alg: opts.alg,
                public_key_jwk: opts.public_key_jwk,
                public_key_pem: opts.public_key_pem,
                starts_at: opts.starts_at,
                expires_at: opts.expires_at,
                revoked_at: opts.revoked_at,
                created_by_account_id: opts.account_id,
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
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "external-key",
    "add",
    "--pool",
    "claim-pool-1",
    "--kid",
    "key-2026-06",
    "--alg",
    "EdDSA",
    "--jwk-json",
    '{"kty":"OKP","crv":"Ed25519","x":"abc"}',
    "--starts-at",
    "2026-06-17T00:00:00.000Z",
    "--metadata-json",
    '{"rotated_by":"test"}',
  ]);

  assert.deepEqual(capturedArgs, {
    account_id: "admin-1",
    pool_id: "claim-pool-1",
    kid: "key-2026-06",
    alg: "EdDSA",
    public_key_jwk: { kty: "OKP", crv: "Ed25519", x: "abc" },
    public_key_pem: null,
    starts_at: "2026-06-17T00:00:00.000Z",
    expires_at: undefined,
    revoked_at: undefined,
    metadata: { rotated_by: "test" },
  });
  assert.equal(captured?.key_id, "key-1");
  assert.equal(captured?.public_key_type, "jwk");
});

test("membership site-license claim-token consumes an external claim token", async () => {
  let capturedArgs: any;
  let captured: any;
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "user-1",
        hub: {
          purchases: {
            consumeSiteLicenseExternalClaimToken: async (opts) => {
              capturedArgs = opts;
              return {
                id: "consumption-1",
                pool_id: "claim-pool-1",
                site_license_id: "license-1",
                package_id: "package-1",
                jti: "token-1",
                token_hash: "hash",
                issuer: "https://lms.example.edu",
                kid: "key-2026-06",
                account_id: opts.account_id,
                status: "granted",
                side_effect_key: "membership-package-assignment",
                assignment_id: "assignment-1",
                membership_grant_id: "grant-1",
                membership_class: "instructor",
                retry_count: 0,
                consumed_at: "2026-06-17T00:00:00.000Z",
                updated: "2026-06-17T00:00:00.000Z",
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
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "claim-token",
    "header.payload.signature",
  ]);

  assert.deepEqual(capturedArgs, {
    account_id: "user-1",
    token: "header.payload.signature",
  });
  assert.equal(captured?.consumption_id, "consumption-1");
  assert.equal(captured?.status, "granted");
});

test("membership site-license external claim admin list and revoke commands", async () => {
  const calls: Record<string, any> = {};
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      const ctx = {
        accountId: "admin-1",
        hub: {
          purchases: {
            listSiteLicenseExternalClaimPools: async (opts) => {
              calls.listPools = opts;
              return [
                {
                  id: "claim-pool-1",
                  site_license_id: opts.site_license_id,
                  package_id: "package-1",
                  name: "Instructor LMS",
                  issuer: "https://lms.example.edu",
                  audience: "cocalc-site-license",
                  allow_membership_class_override: false,
                  allow_membership_expires_at_override: false,
                },
              ];
            },
            disableSiteLicenseExternalClaimPool: async (opts) => {
              calls.disablePool = opts;
              return {
                id: opts.pool_id,
                site_license_id: "license-1",
                package_id: "package-1",
                name: "Instructor LMS",
                issuer: "https://lms.example.edu",
                audience: "cocalc-site-license",
                allow_membership_class_override: false,
                allow_membership_expires_at_override: false,
                disabled_at: opts.disabled_at,
              };
            },
            listSiteLicenseExternalClaimKeys: async (opts) => {
              calls.listKeys = opts;
              return [
                {
                  id: "key-1",
                  pool_id: opts.pool_id,
                  kid: "key-2026-06",
                  alg: "EdDSA",
                  public_key_jwk: { kty: "OKP" },
                },
              ];
            },
            revokeSiteLicenseExternalClaimKey: async (opts) => {
              calls.revokeKey = opts;
              return {
                id: "key-1",
                pool_id: opts.pool_id,
                kid: opts.kid,
                alg: "EdDSA",
                public_key_jwk: { kty: "OKP" },
                revoked_at: opts.revoked_at,
              };
            },
            listSiteLicenseExternalClaimConsumptions: async (opts) => {
              calls.listConsumptions = opts;
              return [
                {
                  id: "consumption-1",
                  pool_id: opts.pool_id,
                  site_license_id: opts.site_license_id,
                  package_id: "package-1",
                  jti: "token-1",
                  token_hash: "hash",
                  issuer: "https://lms.example.edu",
                  account_id: opts.target_account_id,
                  status: opts.status,
                  side_effect_key: "membership-package-assignment",
                  membership_class: "instructor",
                  retry_count: 0,
                  consumed_at: "2026-06-17T00:00:00.000Z",
                  updated: "2026-06-17T00:00:00.000Z",
                },
              ];
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

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "external-pool",
    "list",
    "--site-license",
    "license-1",
    "--limit",
    "10",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "external-pool",
    "disable",
    "claim-pool-1",
    "--disabled-at",
    "2026-06-17T00:00:00.000Z",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "external-key",
    "list",
    "--pool",
    "claim-pool-1",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "external-key",
    "revoke",
    "--pool",
    "claim-pool-1",
    "--kid",
    "key-2026-06",
    "--revoked-at",
    "2026-06-17T00:00:00.000Z",
  ]);
  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "external-claim-list",
    "--pool",
    "claim-pool-1",
    "--site-license",
    "license-1",
    "--account",
    "user-1",
    "--status",
    "granted",
    "--limit",
    "5",
  ]);

  assert.deepEqual(calls.listPools, {
    account_id: "admin-1",
    site_license_id: "license-1",
    package_id: undefined,
    pool_id: undefined,
    limit: 10,
  });
  assert.deepEqual(calls.disablePool, {
    account_id: "admin-1",
    pool_id: "claim-pool-1",
    disabled_at: "2026-06-17T00:00:00.000Z",
  });
  assert.deepEqual(calls.listKeys, {
    account_id: "admin-1",
    pool_id: "claim-pool-1",
    limit: undefined,
  });
  assert.deepEqual(calls.revokeKey, {
    account_id: "admin-1",
    pool_id: "claim-pool-1",
    kid: "key-2026-06",
    revoked_at: "2026-06-17T00:00:00.000Z",
  });
  assert.deepEqual(calls.listConsumptions, {
    account_id: "admin-1",
    pool_id: "claim-pool-1",
    site_license_id: "license-1",
    target_account_id: "user-1",
    status: "granted",
    limit: 5,
  });
});

test("membership site-license sample-token generates a compact claim token", async () => {
  let captured: any;
  const { privateKey } = generateKeyPairSync("ed25519");
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-claim-token-"));
  const privateKeyFile = join(dir, "ed25519.pem");
  writeFileSync(
    privateKeyFile,
    privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      captured = await fn({
        accountId: "admin-1",
        apiBaseUrl: "https://cocalc.ai",
        hub: { purchases: {} },
      });
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an account");
    },
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  await program.parseAsync([
    "node",
    "test",
    "membership",
    "site-license",
    "sample-token",
    "--kid",
    "key-2026-06",
    "--private-key-file",
    privateKeyFile,
    "--expires-at",
    "2026-06-18T00:00:00.000Z",
    "--membership-class",
    "instructor",
    "--subject",
    "reader-1",
    "--metadata-json",
    '{"course":"Math 101"}',
  ]);

  const url = new URL(captured);
  assert.equal(url.origin, "https://cocalc.ai");
  assert.equal(url.pathname, "/claim/site-license");
  const parts = `${url.searchParams.get("token") ?? ""}`.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  assert.deepEqual(header, {
    alg: "EdDSA",
    kid: "key-2026-06",
    typ: "JWT",
  });
  assert.equal(payload.iss, undefined);
  assert.equal(payload.site_license_id, undefined);
  assert.equal(payload.pool_id, undefined);
  assert.equal(payload.jti.length > 0, true);
  assert.equal(payload.exp, 1781740800);
  assert.equal(payload.membership_class, "instructor");
  assert.equal(payload.subject, "reader-1");
  assert.deepEqual(payload.metadata, { course: "Math 101" });
});

test("membership site-license sample-token defaults link expiry to 14 days", async () => {
  let captured: any;
  const { privateKey } = generateKeyPairSync("ed25519");
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-claim-token-"));
  const privateKeyFile = join(dir, "ed25519.pem");
  writeFileSync(
    privateKeyFile,
    privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  const program = new Command();
  registerMembershipCommand(program, {
    withContext: async (_command, _label, fn) => {
      captured = await fn({
        accountId: "admin-1",
        apiBaseUrl: "https://cocalc.ai",
        hub: { purchases: {} },
      });
    },
    toIso: (value) => value,
    resolveAccountByIdentifier: async () => {
      throw new Error("should not resolve an account");
    },
    resolveProject: async () => {
      throw new Error("should not resolve a project");
    },
  } as any);

  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-06-01T00:00:00.000Z");
  try {
    await program.parseAsync([
      "node",
      "test",
      "membership",
      "site-license",
      "sample-token",
      "--kid",
      "key-2026-06",
      "--private-key-file",
      privateKeyFile,
    ]);
  } finally {
    Date.now = originalNow;
  }

  const url = new URL(captured);
  const parts = `${url.searchParams.get("token") ?? ""}`.split(".");
  assert.equal(parts.length, 3);
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  assert.equal(
    payload.exp,
    Math.floor(Date.parse("2026-06-15T00:00:00.000Z") / 1000),
  );
});
