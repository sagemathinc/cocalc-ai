import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
        accountId: "11111111-1111-4111-8111-111111111111",
        hub: {
          system: {},
          messages: {},
          db: {},
          adminDb: {},
          adminHost: {},
          adminSupport: {},
          adminCrashes: {},
          purchases: {},
        },
      };
      Object.assign(ctx.hub.system, overrides.system ?? {});
      Object.assign(ctx.hub.messages, overrides.messages ?? {});
      Object.assign(ctx.hub.db, overrides.db ?? {});
      Object.assign(ctx.hub.adminDb, overrides.adminDb ?? {});
      Object.assign(ctx.hub.adminHost, overrides.adminHost ?? {});
      Object.assign(ctx.hub.adminSupport, overrides.adminSupport ?? {});
      Object.assign(ctx.hub.adminCrashes, overrides.adminCrashes ?? {});
      Object.assign(ctx.hub.purchases, overrides.purchases ?? {});
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

test("admin user ban resolves the target and forwards the audit reason", async () => {
  let captured: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        adminBanUser: async (opts: any) => {
          captured = opts;
          return { affected_accounts: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "user",
    "ban",
    "alice@example.com",
    "--reason",
    "confirmed bandwidth relay abuse",
  ]);

  assert.deepEqual(captured, {
    user_account_id: "22222222-2222-4222-8222-222222222222",
    reason: "confirmed bandwidth relay abuse",
  });
});

test("admin user unban targets only the resolved account", async () => {
  let captured: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        adminUnbanUser: async (opts: any) => {
          captured = opts;
          return { banned: false };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "user",
    "unban",
    "22222222-2222-4222-8222-222222222222",
    "--reason",
    "manual review cleared the account",
  ]);

  assert.deepEqual(captured, {
    user_account_id: "22222222-2222-4222-8222-222222222222",
    reason: "manual review cleared the account",
  });
});

test("admin membership-package purchase previews before committing", async () => {
  let quoteArgs: any;
  let purchaseCalls = 0;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      purchases: {
        getMembershipPackageQuote: async (opts: any) => {
          quoteArgs = opts;
          return {
            total_price: 900,
            starts_at: "2026-08-10T00:00:00.000Z",
            expires_at: "2026-08-22T00:00:00.000Z",
          };
        },
        adminCreateMembershipPackagePurchase: async () => {
          purchaseCalls += 1;
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "purchase",
    "membership-package",
    "alice@example.com",
    "--kind",
    "course",
    "--membership-class",
    "student",
    "--seat-count",
    "100",
    "--price",
    "150",
    "--source",
    "credit",
    "--reason",
    "approved ticket 20443 offer",
    "--course-project",
    "44444444-4444-4444-8444-444444444444",
    "--starts-at",
    "2026-08-10T00:00:00Z",
    "--expires-at",
    "2026-08-22T00:00:00Z",
  ]);

  assert.equal(purchaseCalls, 0);
  assert.equal(quoteArgs.account_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(quoteArgs.seat_count, 100);
  assert.equal(
    quoteArgs.course_project_id,
    "44444444-4444-4444-8444-444444444444",
  );
});

test("admin membership-package purchase commits the reviewed custom price", async () => {
  let purchaseArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      purchases: {
        getMembershipPackageQuote: async () => ({
          total_price: 900,
          starts_at: "2026-08-10T00:00:00.000Z",
          expires_at: "2026-08-22T00:00:00.000Z",
        }),
        adminCreateMembershipPackagePurchase: async (opts: any) => {
          purchaseArgs = opts;
          return { package_id: "package-1", purchase_id: 42 };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "purchase",
    "membership-package",
    "alice@example.com",
    "--kind",
    "team",
    "--membership-class",
    "standard",
    "--seat-count",
    "100",
    "--interval",
    "month",
    "--price",
    "150",
    "--source",
    "card",
    "--reason",
    "approved custom camp package",
    "--idempotency-key",
    "ticket-20443",
    "--commit",
  ]);

  assert.equal(
    purchaseArgs.user_account_id,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(purchaseArgs.price, 150);
  assert.equal(purchaseArgs.source, "card");
  assert.equal(purchaseArgs.idempotency_key, "ticket-20443");
  assert.deepEqual(purchaseArgs.product, {
    type: "membership-package",
    kind: "team",
    membership_class: "standard",
    seat_count: 100,
    interval: "month",
    course_project_id: undefined,
    starts_at: undefined,
    expires_at: undefined,
    metadata: undefined,
  });
});

test("admin db query forwards audited read-only SQL options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminDb: {
        query: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-1", rows: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "db",
    "query",
    "--sql",
    "select now()",
    "--reason",
    "incident check",
    "--bay",
    "prod-bay-0",
    "--limit",
    "25",
    "--timeout-ms",
    "5000",
    "--lock-timeout-ms",
    "250",
    "--max-bytes",
    "100000",
  ]);

  assert.deepEqual(capturedArgs, {
    bay_id: "prod-bay-0",
    limit: 25,
    statement_timeout_ms: 5000,
    lock_timeout_ms: 250,
    max_bytes: 100000,
    sql: "select now()",
    reason: "incident check",
  });
});

test("admin host logs forwards audited bounded log options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        logs: async (opts: any) => {
          capturedArgs = opts;
          return {
            audit_id: "audit-host-1",
            host_id: opts.host_id,
            source: "host-agent",
            lines: opts.lines,
            text: "",
            result_bytes: 0,
            truncated: false,
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "logs",
    "--host-id",
    "11111111-1111-4111-8111-111111111111",
    "--source",
    "host-agent",
    "--tail",
    "50",
    "--grep",
    "reconcile",
    "--max-bytes",
    "4096",
    "--reason",
    "incident check",
  ]);

  assert.deepEqual(capturedArgs, {
    lines: 50,
    max_bytes: 4096,
    host_id: "11111111-1111-4111-8111-111111111111",
    source: "host-agent",
    grep: "reconcile",
    reason: "incident check",
  });
});

test("admin support list forwards bounded redacted ticket options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        list: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-support-1", tickets: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "list",
    "--since-minutes",
    "360",
    "--limit",
    "25",
    "--status",
    "new,open,solved",
    "--max-bytes",
    "100000",
    "--reason",
    "review support spike",
  ]);

  assert.deepEqual(capturedArgs, {
    since_minutes: 360,
    limit: 25,
    statuses: ["new", "open", "solved"],
    max_bytes: 100000,
    reason: "review support spike",
  });
});

test("admin support show forwards ticket conversation limits", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        show: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-support-2", comments: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "show",
    "12345",
    "--max-comments",
    "30",
    "--max-bytes",
    "200000",
    "--reason",
    "inspect probable outage report",
  ]);

  assert.deepEqual(capturedArgs, {
    ticket_id: 12345,
    max_comments: 30,
    max_bytes: 200000,
    reason: "inspect probable outage report",
  });
});

test("admin support conventions exposes the shared status workflow", async () => {
  let output: any;
  const deps = adminDeps();
  deps.withContext = async (_command: unknown, _label: string, fn: any) => {
    output = await fn({ hub: {} });
    return output;
  };
  const program = new Command();
  registerAdminCommand(program, deps as any);

  await program.parseAsync(["node", "test", "admin", "support", "conventions"]);

  assert.equal(
    output.statuses.new,
    "We have not reviewed or acted on the ticket.",
  );
  assert.match(output.statuses.open, /actively investigating/);
  assert.match(output.statuses.pending, /waiting for the requester/);
  assert.match(output.statuses.solved, /complete and verified/);
  assert.equal(output.version, 2);
  assert.match(output.workflow.join("\n"), /multiline comments/);
  assert.match(output.workflow.join("\n"), /--public-reply-file/);
});

test("admin support image verifies and writes a Zendesk attachment", async () => {
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const dir = await mkdtemp(join(tmpdir(), "cocalc-support-image-"));
  const output = join(dir, "screenshot.png");
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        getImage: async (opts: any) => {
          capturedArgs = opts;
          return {
            audit_id: "audit-support-image",
            ticket_id: 20463,
            comment_id: 10,
            attachment_id: 987,
            filename: "ticket-20463-attachment-987.png",
            content_type: "image/png",
            size: image.length,
            sha256:
              "0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543",
            data_base64: image.toString("base64"),
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "image",
    "20463",
    "987",
    "--output",
    output,
    "--max-bytes",
    "4096",
    "--reason",
    "inspect screenshot on ticket 20463",
  ]);

  assert.deepEqual(capturedArgs, {
    ticket_id: 20463,
    attachment_id: 987,
    max_bytes: 4096,
    reason: "inspect screenshot on ticket 20463",
  });
  assert.deepEqual(await readFile(output), image);
});

test("admin support triage forwards deterministic grouping options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        triage: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-support-3", groups: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "triage",
    "--since-minutes",
    "720",
    "--status",
    "new,pending",
    "--reason",
    "group active support incidents",
  ]);

  assert.deepEqual(capturedArgs, {
    since_minutes: 720,
    limit: 50,
    statuses: ["new", "pending"],
    max_bytes: 262144,
    reason: "group active support incidents",
  });
});

test("admin support search forwards a bounded Zendesk query", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        search: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-support-search", tickets: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "search",
    "--query",
    "type:ticket status<solved updated>2026-08-01",
    "--limit",
    "25",
    "--reason",
    "triage current queue",
  ]);

  assert.deepEqual(capturedArgs, {
    query: "type:ticket status<solved updated>2026-08-01",
    limit: 25,
    max_bytes: 262144,
    reason: "triage current queue",
  });
});

test("admin support update is dry-run by default", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        planUpdate: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-support-plan", commit: false };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "update",
    "20437",
    "--status",
    "pending",
    "--add-tags",
    "investigating,ssh",
    "--reason",
    "approved status update",
  ]);

  assert.deepEqual(capturedArgs, {
    ticket_id: 20437,
    status: "pending",
    add_tags: ["investigating", "ssh"],
    remove_tags: undefined,
    expected_updated_at: undefined,
    reason: "approved status update",
  });
});

test("admin support update rejects literal newline escapes in inline comments", async () => {
  const program = new Command();
  registerAdminCommand(program, adminDeps() as any);

  await assert.rejects(
    () =>
      program.parseAsync([
        "node",
        "test",
        "admin",
        "support",
        "update",
        "20437",
        "--public-reply",
        "Hello\\n\\nThis should be multiline.",
        "--reason",
        "approved response",
      ]),
    /--public-reply contains a literal \\n escape; use --public-reply-file/,
  );
});

test("admin support reply commit reads the approved file and supplies idempotency", async () => {
  let capturedArgs: any;
  const dir = await mkdtemp(join(tmpdir(), "cocalc-support-reply-"));
  const replyFile = join(dir, "reply.txt");
  await writeFile(replyFile, "The issue is now fixed.\n", "utf8");
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        update: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-support-update", commit: true };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "reply",
    "20437",
    "--file",
    replyFile,
    "--status",
    "solved",
    "--expected-updated-at",
    "2026-08-05T12:00:00.000Z",
    "--reason",
    "approved response",
    "--commit",
  ]);

  assert.match(capturedArgs.idempotency_key, /^support-update-[0-9a-f]{40}$/);
  const { idempotency_key: _idempotencyKey, ...request } = capturedArgs;
  assert.deepEqual(request, {
    ticket_id: 20437,
    public_reply: "The issue is now fixed.",
    status: "solved",
    expected_updated_at: "2026-08-05T12:00:00.000Z",
    reason: "approved response",
    timeout: 60_000,
  });
});

test("admin support merge commit forwards explicit target and source versions", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        merge: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-support-merge", commit: true };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "merge",
    "--target",
    "20431",
    "--source",
    "20432",
    "--target-comment",
    "Combining duplicate billing requests.",
    "--target-expected-updated-at",
    "2026-08-05T12:00:00.000Z",
    "--source-expected-updated-at",
    "2026-08-05T12:01:00.000Z",
    "--idempotency-key",
    "support-merge-approved-20431-20432",
    "--reason",
    "approved duplicate merge",
    "--commit",
  ]);

  assert.deepEqual(capturedArgs, {
    target_ticket_id: 20431,
    source_ticket_id: 20432,
    target_comment: "Combining duplicate billing requests.",
    source_comment: undefined,
    target_comment_public: false,
    source_comment_public: false,
    target_expected_updated_at: "2026-08-05T12:00:00.000Z",
    source_expected_updated_at: "2026-08-05T12:01:00.000Z",
    reason: "approved duplicate merge",
    idempotency_key: "support-merge-approved-20431-20432",
    timeout: 120_000,
  });
});

test("admin support spam is dry-run by default", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        planSpam: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-support-spam-plan", commit: false };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "spam",
    "20455",
    "--reason",
    "review obvious unsolicited junk",
  ]);

  assert.deepEqual(capturedArgs, {
    ticket_id: 20455,
    expected_updated_at: undefined,
    reason: "review obvious unsolicited junk",
  });
});

test("admin support spam commit forwards the reviewed ticket version", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminSupport: {
        spam: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-support-spam", commit: true };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "support",
    "spam",
    "20455",
    "--expected-updated-at",
    "2026-08-06T12:00:00.000Z",
    "--idempotency-key",
    "support-spam-approved-20455",
    "--reason",
    "approved obvious unsolicited junk",
    "--commit",
  ]);

  assert.deepEqual(capturedArgs, {
    ticket_id: 20455,
    expected_updated_at: "2026-08-06T12:00:00.000Z",
    reason: "approved obvious unsolicited junk",
    timeout: 60_000,
    idempotency_key: "support-spam-approved-20455",
  });
});

test("admin crashes triage forwards fleet filtering options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminCrashes: {
        triage: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-crash-1", groups: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crashes",
    "triage",
    "--since-minutes",
    "720",
    "--limit",
    "500",
    "--status",
    "all",
    "--bay",
    "bay-1",
    "--reason",
    "investigate recent browser crashes",
  ]);

  assert.deepEqual(capturedArgs, {
    since_minutes: 720,
    limit: 500,
    max_bytes: 524288,
    bay_id: "bay-1",
    status: "all",
    reason: "investigate recent browser crashes",
  });
});

test("admin crashes resolve forwards representative report and bay", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminCrashes: {
        resolve: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-crash-2" };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crashes",
    "resolve",
    "11111111-1111-4111-8111-111111111111",
    "--bay",
    "bay-1",
    "--note",
    "fixed by frontend deployment",
    "--reason",
    "close confirmed crash signature",
  ]);

  assert.deepEqual(capturedArgs, {
    report_id: "11111111-1111-4111-8111-111111111111",
    bay_id: "bay-1",
    note: "fixed by frontend deployment",
    reason: "close confirmed crash signature",
  });
});

test("admin host describe forwards summary options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        describe: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-host-2", host_id: "host-1" };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "describe",
    "montreal-1",
    "--recent-limit",
    "7",
    "--no-live",
    "--reason",
    "incident review",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    recent_limit: 7,
    include_live: false,
    reason: "incident review",
  });
});

test("admin host events forwards timeline options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        events: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-host-3", events: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "events",
    "montreal-1",
    "--since-minutes",
    "360",
    "--limit",
    "25",
    "--reason",
    "incident timeline",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    since_minutes: 360,
    limit: 25,
    reason: "incident timeline",
  });
});

test("admin host top forwards metrics options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        top: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-host-4", point_count: 0 };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "top",
    "montreal-1",
    "--window-minutes",
    "120",
    "--max-points",
    "20",
    "--reason",
    "pressure check",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    window_minutes: 120,
    max_points: 20,
    reason: "pressure check",
  });
});

test("admin host ps forwards process snapshot options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        ps: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-host-5", snapshot: {} };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "ps",
    "montreal-1",
    "--limit",
    "25",
    "--sort",
    "cpu",
    "--reason",
    "process check",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    limit: 25,
    sort: "cpu",
    reason: "process check",
  });
});

test("admin host abuse-processes forwards bounded snapshot options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        scanAbuseProcesses: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-abuse-processes", snapshot: {} };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "abuse-processes",
    "montreal-1",
    "--max-projects",
    "300",
    "--max-processes",
    "4000",
    "--timeout-ms",
    "6000",
    "--reason",
    "standard abuse health scan",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    max_projects: 300,
    max_processes: 4000,
    timeout_ms: 6000,
    reason: "standard abuse health scan",
  });
});

test("admin host intrusion-snapshot forwards the host and audit reason", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        intrusionSnapshot: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-intrusion-snapshot", snapshot: {} };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "intrusion-snapshot",
    "montreal-1",
    "--reason",
    "host integrity review",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    reason: "host integrity review",
  });
});

test("admin host abuse-filesystems forwards bounded snapshot options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        scanAbuseFilesystems: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-abuse-filesystems", snapshot: {} };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "abuse-filesystems",
    "montreal-1",
    "--max-projects",
    "300",
    "--max-entries-per-project",
    "4000",
    "--max-total-entries",
    "80000",
    "--max-depth",
    "6",
    "--timeout-ms",
    "12000",
    "--reason",
    "standard abuse health scan",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    max_projects: 300,
    max_entries_per_project: 4000,
    max_total_entries: 80000,
    max_depth: 6,
    timeout_ms: 12000,
    reason: "standard abuse health scan",
  });
});

test("admin host net forwards network snapshot options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        net: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-host-6", snapshot: {} };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "net",
    "montreal-1",
    "--limit",
    "80",
    "--reason",
    "socket check",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    limit: 80,
    reason: "socket check",
  });
});

test("admin host filesystem forwards filesystem snapshot options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        filesystem: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-host-7", snapshot: {} };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "filesystem",
    "montreal-1",
    "--reason",
    "disk check",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    reason: "disk check",
  });
});

test("admin host podman forwards podman snapshot options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminHost: {
        podman: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-host-8", snapshot: {} };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "host",
    "podman",
    "montreal-1",
    "--limit",
    "12",
    "--reason",
    "podman check",
  ]);

  assert.deepEqual(capturedArgs, {
    host: "montreal-1",
    limit: 12,
    reason: "podman check",
  });
});

test("admin db lro forwards diagnostic filters", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminDb: {
        diagnostic: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-2", rows: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "db",
    "lro",
    "--op-id",
    "11111111-1111-4111-8111-111111111111",
    "--kind",
    "project-start",
    "--status",
    "failed",
    "--window-minutes",
    "30",
  ]);

  assert.deepEqual(capturedArgs, {
    bay_id: undefined,
    limit: 200,
    statement_timeout_ms: 15000,
    lock_timeout_ms: 1000,
    max_bytes: 2097152,
    diagnostic: "lro",
    params: {
      op_id: "11111111-1111-4111-8111-111111111111",
      kind: "project-start",
      status: "failed",
      scope_type: undefined,
      scope_id: undefined,
      window_seconds: 1800,
    },
  });
});

test("admin db host-query forwards audited project-host SQLite options", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminDb: {
        queryHost: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-host-1", rows: [] };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "db",
    "host-query",
    "--host-id",
    "11111111-1111-4111-8111-111111111111",
    "--sql",
    "select table_name, count(*) from data group by table_name",
    "--reason",
    "host sqlite incident check",
    "--limit",
    "50",
    "--timeout-ms",
    "10000",
    "--max-bytes",
    "500000",
  ]);

  assert.deepEqual(capturedArgs, {
    bay_id: undefined,
    limit: 50,
    statement_timeout_ms: 10000,
    lock_timeout_ms: 1000,
    max_bytes: 500000,
    host_id: "11111111-1111-4111-8111-111111111111",
    sql: "select table_name, count(*) from data group by table_name",
    reason: "host sqlite incident check",
  });
});

test("admin db exec forwards audited write options with rollback default", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      adminDb: {
        exec: async (opts: any) => {
          capturedArgs = opts;
          return { audit_id: "audit-3", committed: opts.commit };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "db",
    "exec",
    "--write",
    "--sql",
    "update accounts set banned=false where account_id='11111111-1111-4111-8111-111111111111'",
    "--reason",
    "incident repair dry run",
  ]);

  assert.deepEqual(capturedArgs, {
    bay_id: undefined,
    limit: 200,
    statement_timeout_ms: 15000,
    lock_timeout_ms: 1000,
    max_bytes: 2097152,
    sql: "update accounts set banned=false where account_id='11111111-1111-4111-8111-111111111111'",
    reason: "incident repair dry run",
    write: true,
    commit: false,
  });
});

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
  assert.match(
    JSON.stringify(schema),
    /features\.bandwidth_relay_abuse_exempt/,
  );
  assert.match(JSON.stringify(schema), /features\.cryptomining_abuse_exempt/);
  assert.match(
    JSON.stringify(schema),
    /authorizes administrator-managed collection/,
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

test("admin membership-assignment get resolves a user", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        getAdminAssignedMembership: async (opts: any) => {
          capturedArgs = opts;
          return {
            account_id: opts.user_account_id,
            membership_class: "member",
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "membership-assignment",
    "get",
    "alice@example.com",
  ]);

  assert.deepEqual(capturedArgs, {
    user_account_id: "22222222-2222-4222-8222-222222222222",
  });
});

test("admin membership-assignment set validates and stores a temporary tier", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      db: {
        userQuery: async () => ({
          membership_tiers: [
            { id: "free", disabled: false },
            { id: "member", label: "Standard", disabled: false },
          ],
        }),
      },
      system: {
        setAdminAssignedMembership: async (opts: any) => {
          capturedArgs = opts;
        },
        getAdminAssignedMembership: async (opts: any) => ({
          account_id: opts.user_account_id,
          membership_class: "member",
          expires_at: new Date("2099-09-01T00:00:00.000Z"),
          notes: "support ticket 20435",
        }),
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "membership-assignment",
    "set",
    "alice@example.com",
    "--tier",
    "member",
    "--expires-at",
    "2099-09-01T00:00:00Z",
    "--reason",
    "support ticket 20435",
  ]);

  assert.deepEqual(capturedArgs, {
    user_account_id: "22222222-2222-4222-8222-222222222222",
    membership_class: "member",
    expires_at: new Date("2099-09-01T00:00:00.000Z"),
    notes: "support ticket 20435",
  });
});

test("admin membership-assignment set rejects an unknown tier", async () => {
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      db: {
        userQuery: async () => ({
          membership_tiers: [{ id: "member", disabled: false }],
        }),
      },
    }) as any,
  );

  await assert.rejects(
    program.parseAsync([
      "node",
      "test",
      "admin",
      "membership-assignment",
      "set",
      "alice@example.com",
      "--tier",
      "typo",
      "--expires-at",
      "never",
      "--reason",
      "test",
    ]),
    /unknown membership tier 'typo'; enabled tiers: member/,
  );
});

test("admin membership-assignment clear uses UUID targets without search", async () => {
  let capturedArgs: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        clearAdminAssignedMembership: async (opts: any) => {
          capturedArgs = opts;
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "membership-assignment",
    "clear",
    "11111111-1111-4111-8111-111111111111",
  ]);

  assert.deepEqual(capturedArgs, {
    user_account_id: "11111111-1111-4111-8111-111111111111",
  });
});

test("admin settings set reads a secret from a file without returning it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cocalc-admin-settings-"));
  const path = join(dir, "token");
  await writeFile(path, "secret-token\n");
  let captured: any;
  const program = new Command();
  registerAdminCommand(
    program,
    adminDeps({
      system: {
        setSiteSettings: async (opts: any) => {
          captured = opts;
          return {
            scope: "server_settings",
            version: 7,
            bays: [{ bay_id: "bay-0", status: "local" }],
          };
        },
      },
    }) as any,
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "settings",
    "set",
    "project_hosts_cloudflare_tunnel_api_token",
    "--value-file",
    path,
  ]);

  assert.deepEqual(captured, {
    settings: [
      {
        name: "project_hosts_cloudflare_tunnel_api_token",
        value: "secret-token",
      },
    ],
  });
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
