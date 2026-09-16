import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Command } from "commander";

import { getDocsEntry } from "@cocalc/docs";
import { CRM_EXTERNAL_OBJECT_KINDS } from "@cocalc/util/crm";

import { registerCrmCommand } from "./crm";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function setup(adminCrm: Record<string, any>) {
  let output: unknown;
  const program = new Command();
  const admin = program.command("admin");
  registerCrmCommand(admin, {
    withContext: async (_command: unknown, _label: string, fn: any) => {
      output = await fn({ accountId: ACCOUNT_ID, hub: { adminCrm } });
      return output;
    },
    resolveAccountByIdentifier: async (_ctx: unknown, identifier: string) => ({
      account_id:
        identifier === "owner@example.edu"
          ? "22222222-2222-4222-8222-222222222222"
          : undefined,
    }),
    isValidUUID: (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ),
  });
  return { program, output: () => output };
}

type CrmLeafBehavior =
  | "read"
  | "conditional write"
  | "previewed mutation"
  | "sensitive export";

type CrmLeafInventoryEntry = {
  path: string;
  behavior: CrmLeafBehavior;
};

function crmCommandFrom(program: Command): Command {
  const admin = program.commands.find((command) => command.name() === "admin");
  const crm = admin?.commands.find((command) => command.name() === "crm");
  assert.ok(crm);
  return crm;
}

function registeredCrmLeafInventory(): CrmLeafInventoryEntry[] {
  const crm = crmCommandFrom(setup({}).program);
  const entries: CrmLeafInventoryEntry[] = [];
  const walk = (command: Command, parents: string[]) => {
    const path = [...parents, command.name()];
    if (command.commands.length) {
      for (const child of command.commands) walk(child, path);
      return;
    }
    const fullPath = path.join(" ");
    entries.push({
      path: fullPath,
      behavior: command.options.some((option) => option.long === "--commit")
        ? "previewed mutation"
        : command.options.some((option) => option.long === "--refresh")
          ? "conditional write"
          : fullPath === "crm export"
            ? "sensitive export"
            : "read",
    });
  };
  for (const command of crm.commands) walk(command, ["crm"]);
  return entries;
}

function adminDocsBody(id: "admin.crm" | "admin.crm-outreach"): string {
  const entry = getDocsEntry(id, { includeAdmin: true });
  assert.ok(entry);
  return entry.body;
}

function documentedCrmLeafInventory(body: string): CrmLeafInventoryEntry[] {
  const section = body.match(
    /<!-- crm-cli-inventory:start -->([\s\S]*?)<!-- crm-cli-inventory:end -->/,
  );
  assert.ok(section, "admin CRM docs must contain the checked CLI inventory");
  const entries: CrmLeafInventoryEntry[] = [];
  for (const line of section[1].split("\n")) {
    if (!line.trim()) continue;
    const match = line
      .replace(/\\`/g, "`")
      .match(
        /^- \*\*(read|conditional write|previewed mutation|sensitive export)\*\* — `cocalc admin (crm [^`]+)`$/,
      );
    assert.ok(match, `invalid CRM inventory line: ${line}`);
    entries.push({
      behavior: match[1] as CrmLeafBehavior,
      path: match[2],
    });
  }
  return entries;
}

type CrmShellExample = {
  annotation: string;
  command: string;
};

function crmShellExamples(body: string): CrmShellExample[] {
  const lines = body.split("\n");
  const examples: CrmShellExample[] = [];
  let inShell = false;
  let previousNonblank = "";
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (line === "~~~sh") {
      inShell = !inShell;
      previousNonblank = "";
      continue;
    }
    if (!inShell) continue;
    if (line.startsWith("cocalc admin crm ")) {
      const annotation = previousNonblank;
      while (line.endsWith("\\")) {
        line = `${line.slice(0, -1).trimEnd()} ${lines[++i].trim()}`;
      }
      examples.push({
        annotation,
        command: line.replace(/\s+/g, " ").trim(),
      });
      previousNonblank = line;
      continue;
    }
    if (line) previousNonblank = line;
  }
  return examples;
}

test("CRM help exposes the packaged runbook and preview workflow", () => {
  const { program } = setup({});
  const admin = program.commands.find((command) => command.name() === "admin");
  const crm = admin?.commands.find((command) => command.name() === "crm");
  assert.ok(crm);
  let help = "";
  crm.configureOutput({ writeOut: (text) => (help += text) });
  crm.outputHelp();
  assert.match(help, /docs show admin\/crm --include-admin/);
  assert.match(help, /Mutations preview by default/);
  for (const family of [
    "organizations",
    "domains",
    "people",
    "opportunities",
    "tasks",
    "activities",
    "links",
    "order",
    "support-context",
    "backfill",
    "digest",
    "diagnostics",
    "export",
  ]) {
    assert.ok(crm.commands.some((command) => command.name() === family));
  }
});

test("CRM docs inventory matches every registered CLI leaf", () => {
  const registered = registeredCrmLeafInventory().sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const documented = documentedCrmLeafInventory(
    adminDocsBody("admin.crm"),
  ).sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(
    new Set(documented.map(({ path }) => path)).size,
    documented.length,
  );
  assert.deepEqual(documented, registered);
});

test("CRM mutation examples identify preview and commit behavior", () => {
  const inventory = registeredCrmLeafInventory().sort(
    (left, right) => right.path.length - left.path.length,
  );
  const examples = [
    ...crmShellExamples(adminDocsBody("admin.crm")),
    ...crmShellExamples(adminDocsBody("admin.crm-outreach")),
  ];
  assert.ok(examples.length > 0);
  for (const example of examples) {
    const value = example.command.replace(/^cocalc admin /, "");
    const leaf = inventory.find(
      ({ path }) => value === path || value.startsWith(`${path} `),
    );
    if (!leaf) {
      assert.match(
        example.command,
        / --help(?:\s|$)/,
        `CRM docs reference an unknown leaf command: ${example.command}`,
      );
      continue;
    }
    if (leaf.behavior !== "previewed mutation") continue;
    assert.match(
      example.annotation,
      example.command.includes(" --commit")
        ? /^# COMMIT —/
        : /^# PREVIEW ONLY —/,
      `CRM mutation example has an ambiguous effect: ${example.command}`,
    );
  }
});

test("CRM links help exposes cursor-complete listing and person bindings", () => {
  const { program } = setup({});
  const admin = program.commands.find((command) => command.name() === "admin");
  const crm = admin?.commands.find((command) => command.name() === "crm");
  const links = crm?.commands.find((command) => command.name() === "links");
  assert.ok(links);
  for (const name of ["list", "add", "remove"]) {
    assert.ok(links.commands.some((command) => command.name() === name));
  }

  const list = links.commands.find((command) => command.name() === "list");
  assert.ok(list);
  const listHelp = list.helpInformation();
  for (const option of [
    "--provider",
    "--kind",
    "--external-id",
    "--external-id-prefix",
    "--organization",
    "--verification-state",
    "--cursor",
    "--limit",
    "--max-bytes",
  ]) {
    assert.match(listHelp, new RegExp(option));
  }

  assert.ok(CRM_EXTERNAL_OBJECT_KINDS.includes("person"));
  for (const name of ["add", "remove"]) {
    const command = links.commands.find(
      (candidate) => candidate.name() === name,
    );
    assert.ok(command);
    let help = "";
    command.configureOutput({ writeOut: (text) => (help += text) });
    command.outputHelp();
    for (const kind of CRM_EXTERNAL_OBJECT_KINDS) {
      assert.match(help, new RegExp(kind.replace(/_/g, "-")));
    }
    assert.match(help, /--reject/);
    assert.match(
      help,
      /--kind is person, --person is required when adding or verifying.*reject always stores an unbound identity.*remove may omit it/,
    );
  }
});

test("CRM links add records an explicit reviewed rejection", async () => {
  let captured: any;
  const { program } = setup({
    mutateExternalReference: async (opts: any) => {
      captured = opts;
      return { preview: true, expected_version: 0 };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "links",
    "add",
    "example-customer",
    "--provider",
    "cocalc",
    "--kind",
    "person",
    "--external-id",
    "source-system:person-001",
    "--reject",
    "--reason",
    "reviewed and rejected the source candidate",
  ]);
  assert.equal(captured.action, "reject");
  assert.equal(captured.provider, "cocalc");
  assert.equal(captured.object_kind, "person");
  assert.equal(captured.external_id, "source-system:person-001");
  assert.equal(captured.person, undefined);
  assert.equal(captured.commit, false);
});

test("CRM links list forwards exact filters and bounded pagination", async () => {
  let captured: any;
  const response = {
    external_references: [
      {
        reference: {
          id: "33333333-3333-4333-8333-333333333333",
          provider: "cocalc",
          object_kind: "person",
          external_id: "source-system:person-001",
          verification_state: "verified",
        },
        organization: {
          id: "44444444-4444-4444-8444-444444444444",
          customer_number: "synthetic-customer-number",
          display_name: "Example University",
        },
      },
    ],
    next_cursor: "next-page",
    truncated: true,
    result_bytes: 512,
  };
  const { program, output } = setup({
    listExternalReferences: async (opts: any) => {
      captured = opts;
      return response;
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "links",
    "list",
    "--provider",
    "CoCalc",
    "--kind",
    "person",
    "--external-id",
    "source-system:person-001",
    "--organization",
    "example-customer",
    "--verification-state",
    "verified",
    "--cursor",
    "current-page",
    "--limit",
    "25",
    "--max-bytes",
    "65536",
    "--reason",
    "Reconcile reviewed source bindings",
  ]);
  assert.equal(captured.provider, "cocalc");
  assert.equal(captured.object_kind, "person");
  assert.equal(captured.external_id, "source-system:person-001");
  assert.equal(captured.external_id_prefix, undefined);
  assert.equal(captured.organization, "example-customer");
  assert.equal(captured.verification_state, "verified");
  assert.equal(captured.cursor, "current-page");
  assert.equal(captured.limit, 25);
  assert.equal(captured.max_bytes, 65536);
  assert.equal(captured.reason, "Reconcile reviewed source bindings");
  assert.deepEqual((output() as any).data, response);
});

test("CRM links list preserves literal prefixes and rejects mixed selectors", async () => {
  let captured: any;
  const prefixRun = setup({
    listExternalReferences: async (opts: any) => {
      captured = opts;
      return {
        external_references: [],
        truncated: false,
        result_bytes: 2,
      };
    },
  });
  await prefixRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "links",
    "list",
    "--external-id-prefix",
    "source-system:person_%",
  ]);
  assert.equal(captured.external_id, undefined);
  assert.equal(captured.external_id_prefix, "source-system:person_%");
  assert.equal(captured.reason, "Review CRM external references");

  let called = false;
  const mixedRun = setup({
    listExternalReferences: async () => {
      called = true;
      return {};
    },
  });
  await assert.rejects(
    mixedRun.program.parseAsync([
      "node",
      "test",
      "admin",
      "crm",
      "links",
      "list",
      "--external-id",
      "source-system:person-001",
      "--external-id-prefix",
      "source-system:",
    ]),
    /--external-id and --external-id-prefix are mutually exclusive/,
  );
  assert.equal(called, false);
});

test("organization create previews with a stable idempotency key", async () => {
  let captured: any;
  const response = {
    preview: true,
    expected_version: 0,
    idempotency_key: "server-key",
  };
  const { program, output } = setup({
    createOrganization: async (opts: any) => {
      captured = opts;
      return response;
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "organizations",
    "create",
    "--name",
    "Example University",
    "--type",
    "university",
    "--owner",
    "owner@example.edu",
    "--reason",
    "reviewed institutional inquiry",
  ]);
  assert.equal(captured.commit, false);
  assert.equal(captured.organization_type, "university");
  assert.equal(
    captured.relationship_owner_account_id,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.match(captured.idempotency_key, /^cli:organization\.create:/);
  assert.deepEqual(output(), {
    schema_version: 1,
    provenance: {
      authority: "seed",
      service: "adminCrm",
      source: "cli",
    },
    redaction: {
      profile: "bounded_admin",
      unrestricted_provider_payloads: false,
      payment_credentials: false,
    },
    data: response,
  });
});

test("task create previews explicitly without --commit", async () => {
  let captured: any;
  const response = {
    preview: true,
    expected_version: 0,
    idempotency_key: "server-key",
  };
  const { program } = setup({
    createTask: async (opts: any) => {
      captured = opts;
      return response;
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "tasks",
    "create",
    "example-customer",
    "--type",
    "review",
    "--assignee",
    "owner@example.edu",
    "--due",
    "2026-09-08T17:00:00-07:00",
    "--subject",
    "Review institutional renewal",
    "--reason",
    "reviewed customer next action",
  ]);
  assert.equal(captured.commit, false);
  assert.equal(captured.expected_version, undefined);
  assert.equal(captured.due_at, "2026-09-09T00:00:00.000Z");
  assert.match(captured.idempotency_key, /^cli:task\.create:/);
});

test("task due dates require an RFC3339 timestamp with a timezone", async () => {
  for (const due of [
    "2026-09-08",
    "2026-09-08T17:00:00",
    "2026-02-30T17:00:00Z",
    "2026-09-08T24:00:00Z",
  ]) {
    let called = false;
    const { program } = setup({
      createTask: async () => {
        called = true;
        return {};
      },
    });
    await assert.rejects(
      program.parseAsync([
        "node",
        "test",
        "admin",
        "crm",
        "tasks",
        "create",
        "example-customer",
        "--type",
        "review",
        "--assignee",
        "owner@example.edu",
        "--due",
        due,
        "--subject",
        "Review institutional renewal",
        "--reason",
        "reviewed customer next action",
      ]),
      /--due must be (?:an RFC3339 timestamp with an explicit timezone|a valid RFC3339 timestamp)/,
    );
    assert.equal(called, false);
  }
});

test("activity previews bind an explicit event timestamp", async () => {
  let captured: any;
  const { program } = setup({
    addActivity: async (opts: any) => {
      captured = opts;
      return {
        preview: true,
        expected_version: 0,
        idempotency_key: "server-key",
      };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "activities",
    "note",
    "example-customer",
    "--summary",
    "Reviewed renewal timing",
    "--occurred-at",
    "2026-09-08T17:00:00-07:00",
    "--reason",
    "record reviewed customer context",
  ]);
  assert.equal(captured.commit, false);
  assert.equal(captured.expected_version, undefined);
  assert.equal(captured.occurred_at, "2026-09-09T00:00:00.000Z");
  assert.match(captured.idempotency_key, /^cli:activity\.note:/);
});

test("activity event times require an RFC3339 timestamp with a timezone", async () => {
  for (const occurredAt of [
    "2026-09-08",
    "2026-09-08T17:00:00",
    "2026-02-30T17:00:00Z",
    "2026-09-08T24:00:00Z",
  ]) {
    let called = false;
    const { program } = setup({
      addActivity: async () => {
        called = true;
        return {};
      },
    });
    await assert.rejects(
      program.parseAsync([
        "node",
        "test",
        "admin",
        "crm",
        "activities",
        "note",
        "example-customer",
        "--summary",
        "Reviewed renewal timing",
        "--occurred-at",
        occurredAt,
        "--reason",
        "record reviewed customer context",
      ]),
      /--occurred-at must be (?:an RFC3339 timestamp with an explicit timezone|a valid RFC3339 timestamp)/,
    );
    assert.equal(called, false);
  }
});

test("committed CRM mutations require the reviewed expected version", async () => {
  const { program } = setup({ archiveOrganization: async () => ({}) });
  await assert.rejects(
    program.parseAsync([
      "node",
      "test",
      "admin",
      "crm",
      "organizations",
      "archive",
      "CRM-2026-000001",
      "--reason",
      "customer relationship ended",
      "--commit",
    ]),
    /--expected-version is required/,
  );
});

test("CRM search forwards external identifiers and bounded pagination", async () => {
  let captured: any;
  const { program } = setup({
    searchOrganizations: async (opts: any) => {
      captured = opts;
      return { organizations: [], truncated: false, result_bytes: 2 };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "organizations",
    "search",
    "--domain",
    "example.edu",
    "--account",
    "owner@example.edu",
    "--zendesk-ticket",
    "20599",
    "--limit",
    "25",
  ]);
  assert.equal(captured.domain, "example.edu");
  assert.equal(
    captured.linked_account_id,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(captured.zendesk_ticket_id, 20599);
  assert.equal(captured.limit, 25);
  assert.equal(captured.reason, "Search CRM customers");
});

test("customer metrics can be refreshed through the CLI", async () => {
  let captured: any;
  const { program } = setup({
    getCustomerMetrics: async (opts: any) => {
      captured = opts;
      return { organization_id: opts.organization, generated_at: "now" };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "organizations",
    "metrics",
    "CRM-2026-000001",
    "--refresh",
  ]);
  assert.deepEqual(captured, {
    organization: "CRM-2026-000001",
    refresh: true,
    reason: "Refresh CRM customer metrics",
  });
});

test("support context resolves requester identity for agents", async () => {
  let captured: any;
  const { program } = setup({
    getSupportContext: async (opts: any) => {
      captured = opts;
      return { candidates: [] };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "support-context",
    "--ticket",
    "20529",
    "--email",
    "owner@example.edu",
    "--account",
    "owner@example.edu",
  ]);
  assert.deepEqual(captured, {
    ticket_id: 20529,
    requester_email: "owner@example.edu",
    requester_account_id: "22222222-2222-4222-8222-222222222222",
    reason: "Review CRM support context",
  });
});

for (const command of ["list", "search"] as const) {
  for (const status of [undefined, "active", "merged", "archived"] as const) {
    test(`people ${command} preserves ${status ?? "omitted"} status and pagination`, async () => {
      const calls: unknown[] = [];
      const response = {
        people: [],
        next_cursor: "synthetic-next-cursor",
        truncated: true,
        result_bytes: 2,
      };
      const { program, output } = setup({
        [command === "list" ? "listPeople" : "searchPeople"]: async (
          opts: unknown,
        ) => {
          calls.push(opts);
          return response;
        },
      });
      await program.parseAsync([
        "node",
        "test",
        "admin",
        "crm",
        "people",
        command,
        "--search",
        "Synthetic Contact",
        "--organization",
        "CRM-2026-000001",
        "--cursor",
        "synthetic-start-cursor",
        "--limit",
        "2",
        "--max-bytes",
        "100000",
        "--reason",
        "verify synthetic contact search",
        ...(status ? ["--status", status] : []),
      ]);
      assert.deepEqual(calls, [
        {
          search: "Synthetic Contact",
          organization: "CRM-2026-000001",
          cursor: "synthetic-start-cursor",
          limit: 2,
          max_bytes: 100000,
          status,
          reason: "verify synthetic contact search",
        },
      ]);
      assert.deepEqual(output(), {
        schema_version: 1,
        provenance: {
          authority: "seed",
          service: "adminCrm",
          source: "cli",
        },
        redaction: {
          profile: "bounded_admin",
          unrestricted_provider_payloads: false,
          payment_credentials: false,
        },
        data: response,
      });
    });
  }
}

test("people link manages reviewed email relationships without raw SQL", async () => {
  let captured: any;
  const { program } = setup({
    mutatePersonEmail: async (opts: any) => {
      captured = opts;
      return { preview: true, expected_version: 0 };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "people",
    "link",
    "ada@example.edu",
    "--email",
    "ada@billing.example.edu",
    "--email-kind",
    "billing",
    "--primary",
    "--verify",
    "--reason",
    "customer verified the billing contact",
  ]);
  assert.equal(captured.person, "ada@example.edu");
  assert.equal(captured.email, "ada@billing.example.edu");
  assert.equal(captured.action, "add");
  assert.equal(captured.kind, "billing");
  assert.equal(captured.is_primary, true);
  assert.equal(captured.verified, true);
  assert.equal(captured.commit, false);
});

test("people create exposes reviewed profile links and an internal note", async () => {
  let captured: any;
  const { program } = setup({
    createPerson: async (opts: any) => {
      captured = opts;
      return { preview: true, expected_version: 0 };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "people",
    "create",
    "--name",
    "Ada Example",
    "--website",
    "https://ada.example.edu",
    "--linkedin",
    "https://linkedin.com/in/ada-example",
    "--facebook",
    "https://facebook.com/ada.example",
    "--x",
    "https://x.com/ada_example",
    "--note",
    "Primary procurement contact",
    "--reason",
    "reviewed public contact details",
  ]);
  assert.equal(captured.website, "https://ada.example.edu");
  assert.equal(captured.linkedin_url, "https://linkedin.com/in/ada-example");
  assert.equal(captured.facebook_url, "https://facebook.com/ada.example");
  assert.equal(captured.x_url, "https://x.com/ada_example");
  assert.equal(captured.note, "Primary procurement contact");
  assert.equal(captured.commit, false);
});

test("people update accepts profile fields without requiring a JSON file", async () => {
  let captured: any;
  const { program } = setup({
    updatePerson: async (opts: any) => {
      captured = opts;
      return { preview: true, expected_version: 3 };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "people",
    "update",
    "ada@example.edu",
    "--website",
    "https://ada.example.edu",
    "--note",
    "Coordinates pilot onboarding",
    "--reason",
    "reviewed current contact context",
  ]);
  assert.equal(captured.person, "ada@example.edu");
  assert.deepEqual(captured.changes, {
    website: "https://ada.example.edu",
    note: "Coordinates pilot onboarding",
  });
  assert.equal(captured.commit, false);
});

test("order handoff preserves canonical receivables actions", async () => {
  let captured: any;
  const { program } = setup({
    createCommercialOrderFromOpportunity: async (opts: any) => {
      captured = opts;
      return { preview: true, expected_version: 5 };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "order",
    "create",
    "opportunity-id",
    "--next-action",
    "create-invoice",
    "--collection-mode",
    "stripe-invoice",
    "--payment-terms-days",
    "0",
    "--reason",
    "review accepted opportunity handoff",
  ]);
  assert.equal(captured.next_action, "Create invoice");
  assert.equal(captured.collection_mode, "stripe_invoice");
  assert.equal(captured.payment_terms_days, 0);
});

test("daily digest resolves assignees and forwards deterministic windows", async () => {
  let captured: any;
  const { program } = setup({
    getDailyDigest: async (opts: any) => {
      captured = opts;
      return { counts: {}, truncated: false };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "digest",
    "--as-of",
    "2026-08-24T12:00:00Z",
    "--due-within-days",
    "2",
    "--renewal-within-days",
    "120",
    "--assignee",
    "owner@example.edu",
    "--limit",
    "25",
  ]);
  assert.deepEqual(captured, {
    as_of: "2026-08-24T12:00:00Z",
    due_within_days: 2,
    renewal_within_days: 120,
    assignee_account_id: "22222222-2222-4222-8222-222222222222",
    limit: 25,
    reason: "Review daily CRM work digest",
  });
});

test("CRM diagnostics preserves the seed runtime contract", async () => {
  let captured: any;
  const diagnostics = {
    checked_at: "2026-08-27T12:00:00.000Z",
    runtime_contract: {
      crm_schema_contract_version: 1,
      server_build: {
        source: "package-metadata",
        build_id: null,
        package_version: "0.45.26",
      },
      feature_flags: {
        crm_visible: true,
        crm_mutations_enabled: false,
      },
    },
  };
  const { program, output } = setup({
    getDiagnostics: async (opts: any) => {
      captured = opts;
      return diagnostics;
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "diagnostics",
    "--limit",
    "25",
  ]);
  assert.deepEqual(captured, {
    limit: 25,
    reason: "Review CRM diagnostics",
  });
  assert.deepEqual((output() as any).data, diagnostics);
});

test("CRM export writes sensitive data to the requested private file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-crm-export-"));
  const outputFile = join(directory, "customer.json");
  const exported = {
    schema_version: 1,
    sensitive: true,
    organizations: [{ organization: { customer_number: "CRM-2026-000001" } }],
  };
  const { program, output } = setup({
    exportData: async () => exported,
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "export",
    "--organization",
    "CRM-2026-000001",
    "--output-file",
    outputFile,
    "--reason",
    "review customer export",
  ]);
  assert.deepEqual(JSON.parse(await readFile(outputFile, "utf8")), exported);
  assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
  assert.deepEqual((output() as any).data, {
    ...exported,
    organizations: undefined,
    output: outputFile,
  });
});

test("outreach show includes durable provider and engagement evidence", async () => {
  const calls: string[] = [];
  const delivery = {
    id: "33333333-3333-4333-8333-333333333333",
    zendesk_ticket_id: 999999,
  };
  const { program, output } = setup({
    getOutreachDelivery: async () => {
      calls.push("delivery");
      return delivery;
    },
    listOutreachProviderOperations: async () => {
      calls.push("operations");
      return { operations: [{ id: "operation-1" }], truncated: false };
    },
    listOutreachEngagementEvents: async () => {
      calls.push("engagement");
      return { events: [{ id: "view-1" }], truncated: false };
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "outreach",
    "show",
    delivery.id,
    "--reason",
    "review outreach provider recovery evidence",
  ]);

  assert.deepEqual(calls.sort(), ["delivery", "engagement", "operations"]);
  assert.deepEqual((output() as any).data, {
    delivery,
    provider_operations: {
      operations: [{ id: "operation-1" }],
      truncated: false,
    },
    engagement: { events: [{ id: "view-1" }], truncated: false },
    support_show_command: "cocalc admin support show 999999",
  });
});

test("outreach help exposes the shared runbook and operations families", () => {
  const { program } = setup({});
  const admin = program.commands.find((command) => command.name() === "admin");
  const crm = admin?.commands.find((command) => command.name() === "crm");
  const outreach = crm?.commands.find(
    (command) => command.name() === "outreach",
  );
  assert.ok(outreach);
  let help = "";
  outreach.configureOutput({ writeOut: (text) => (help += text) });
  outreach.outputHelp();
  assert.match(help, /docs show admin\/crm-outreach --include-admin/);
  for (const family of [
    "draft",
    "batch",
    "delivery",
    "templates",
    "suppressions",
    "followups",
    "engagement",
    "limits",
    "diagnostics",
  ]) {
    assert.ok(outreach.commands.some((command) => command.name() === family));
  }

  const batch = outreach.commands.find((command) => command.name() === "batch");
  assert.ok(batch);
  for (const action of [
    "list",
    "show",
    "create",
    "update",
    "add",
    "edit",
    "remove",
    "preview",
    "approve",
    "queue",
    "pause",
    "resume",
    "cancel",
  ]) {
    assert.ok(batch.commands.some((command) => command.name() === action));
  }
  let batchHelp = "";
  batch.configureOutput({ writeOut: (text) => (batchHelp += text) });
  batch.outputHelp();
  assert.match(batchHelp, /create, add, preview, approve, then queue/);
  assert.match(batchHelp, /commits sequentially rather than atomically/);
});

test("outreach batch edit previews exact replacement content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-outreach-edit-"));
  const bodyFile = join(directory, "body.md");
  await writeFile(bodyFile, "Updated reviewed body\n");
  let payload: any;
  const { program } = setup({
    updateOutreachRecipient: async (opts: any) => {
      payload = opts;
      return {
        preview: true,
        action: "outreach.recipient.update",
        expected_version: 4,
        idempotency_key: "edit-preview-key",
      };
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "outreach",
    "batch",
    "edit",
    "batch-1",
    "delivery-1",
    "--subject",
    "Updated subject",
    "--body-file",
    bodyFile,
    "--reason",
    "Correct reviewed draft wording",
  ]);

  assert.equal(payload.batch, "batch-1");
  assert.equal(payload.delivery, "delivery-1");
  assert.equal(payload.subject, "Updated subject");
  assert.equal(payload.body_markdown, "Updated reviewed body\n");
  assert.equal(payload.commit, false);
  assert.equal(payload.idempotency_key, undefined);
});

test("outreach edit keys distinguish revisions while preserving retries and explicit keys", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-outreach-edit-keys-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bodyFile = join(directory, "body.md");
  await writeFile(bodyFile, "Same reviewed content");
  async function request(extra: string[]) {
    let payload: any;
    const { program } = setup({
      updateOutreachRecipient: async (opts: any) => {
        payload = opts;
        return { preview: !opts.commit };
      },
    });
    await program.parseAsync([
      "node",
      "test",
      "admin",
      "crm",
      "outreach",
      "batch",
      "edit",
      "batch-1",
      "delivery-1",
      "--subject",
      "Same subject",
      "--body-file",
      bodyFile,
      "--reason",
      "Same reviewed reason",
      ...extra,
    ]);
    return payload;
  }
  const first = await request(["--commit", "--expected-version", "4"]);
  const retry = await request(["--commit", "--expected-version", "4"]);
  const later = await request(["--commit", "--expected-version", "6"]);
  assert.equal(first.idempotency_key, retry.idempotency_key);
  assert.notEqual(first.idempotency_key, later.idempotency_key);
  assert.equal(first.expected_version, 4);
  for (const extra of [[], ["--commit", "--expected-version", "4"]]) {
    assert.equal(
      (await request([...extra, "--idempotency-key", "reviewed-key"]))
        .idempotency_key,
      "reviewed-key",
    );
  }
});

test("organization-first outreach draft previews only batch creation", async () => {
  let createPayload: any;
  let recipientCalls = 0;
  const batchPreview = {
    preview: true,
    action: "outreach.batch.create",
    expected_version: 0,
    idempotency_key: "batch-preview-key",
  };
  const { program, output } = setup({
    getOrganization: async (opts: any) => ({
      organization: {
        customer_number: opts.organization,
        display_name: "Example University",
      },
    }),
    createOutreachBatch: async (opts: any) => {
      createPayload = opts;
      return batchPreview;
    },
    addOutreachRecipient: async () => {
      recipientCalls += 1;
      return {};
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "outreach",
    "draft",
    "CRM-2026-000123",
    "--person",
    "ada@example.edu",
    "--opportunity",
    "opportunity-1",
    "--template",
    "adoption-pilot",
    "--reason",
    "prepare one reviewed prospect conversation",
  ]);

  assert.equal(createPayload.commit, false);
  assert.equal(createPayload.owner_account_id, ACCOUNT_ID);
  assert.equal(createPayload.name, "Example University adoption pilot");
  assert.equal(
    createPayload.purpose,
    "prepare one reviewed prospect conversation",
  );
  assert.equal(createPayload.kind, "adoption_pilot");
  assert.equal(recipientCalls, 0);
  assert.deepEqual((output() as any).data, {
    mode: "organization_first",
    step: "preview_batch_creation",
    batch: batchPreview,
    recipient: {
      preview: false,
      note: "The recipient cannot be rendered until the reviewed batch exists. No recipient mutation was attempted.",
    },
  });
});

test("organization-first draft commit creates a batch but only previews its recipient", async () => {
  const batchId = "44444444-4444-4444-8444-444444444444";
  let createPayload: any;
  let recipientPayload: any;
  const { program, output } = setup({
    getOrganization: async (opts: any) => ({
      organization: {
        customer_number: opts.organization,
        display_name: "Example University",
      },
    }),
    createOutreachBatch: async (opts: any) => {
      createPayload = opts;
      return {
        preview: false,
        action: "outreach.batch.create",
        replayed: false,
        result: { id: batchId },
      };
    },
    addOutreachRecipient: async (opts: any) => {
      recipientPayload = opts;
      return {
        preview: true,
        action: "outreach.recipient.add",
        expected_version: 1,
        idempotency_key: opts.idempotency_key,
      };
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "outreach",
    "draft",
    "CRM-2026-000123",
    "--person",
    "ada@example.edu",
    "--name",
    "Example University adoption pilot",
    "--purpose",
    "Offer a reviewed adoption pilot",
    "--kind",
    "adoption-pilot",
    "--owner",
    "owner@example.edu",
    "--template",
    "adoption-pilot",
    "--reason",
    "prepare one reviewed prospect conversation",
    "--expected-version",
    "0",
    "--idempotency-key",
    "reviewed-batch-key",
    "--commit",
  ]);

  assert.equal(createPayload.commit, true);
  assert.equal(createPayload.expected_version, 0);
  assert.equal(createPayload.idempotency_key, "reviewed-batch-key");
  assert.equal(recipientPayload.batch, batchId);
  assert.equal(recipientPayload.person, "ada@example.edu");
  assert.equal(recipientPayload.organization, "CRM-2026-000123");
  assert.equal(recipientPayload.commit, false);
  assert.equal(recipientPayload.expected_version, undefined);
  assert.notEqual(recipientPayload.idempotency_key, "reviewed-batch-key");
  assert.equal(
    (output() as any).data.step,
    "batch_created_recipient_previewed",
  );
  assert.equal((output() as any).data.recipient.preview, true);
});

test("batch recipient JSONL import previews deterministic bounded rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-outreach-import-"));
  const input = join(directory, "recipients.jsonl");
  await writeFile(
    input,
    [
      JSON.stringify({
        person: "ada@example.edu",
        organization: "CRM-2026-000123",
      }),
      JSON.stringify({
        person: "grace@example.edu",
        organization: "CRM-2026-000123",
        subject: "A reviewed custom subject",
        body_markdown: "A reviewed custom message.",
      }),
    ].join("\n"),
  );
  const calls: any[] = [];
  const { program, output } = setup({
    getOutreachLimits: async () => ({ max_recipients_per_batch: 25 }),
    getOutreachBatch: async () => ({ batch: { recipient_count: 2 } }),
    addOutreachRecipient: async (opts: any) => {
      calls.push(opts);
      return {
        preview: true,
        expected_version: 7,
        idempotency_key: opts.idempotency_key,
        proposed: { normalized_email: opts.person },
      };
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "outreach",
    "batch",
    "add",
    "OUT-2026-000001",
    "--file",
    input,
    "--reason",
    "review two institutional pilot contacts",
  ]);

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.commit === false));
  assert.equal(calls[0].person, "ada@example.edu");
  assert.equal(calls[1].body_markdown, "A reviewed custom message.");
  assert.match(calls[0].idempotency_key, /:row:001$/);
  assert.match(calls[1].idempotency_key, /:row:002$/);
  const result = (output() as any).data;
  assert.equal(result.mode, "preview");
  assert.equal(result.atomic, false);
  assert.equal(result.row_count, 2);
  assert.equal(result.configured_batch_limit, 25);
  assert.equal(result.existing_batch_recipients, 2);
  assert.equal(result.remaining_batch_capacity, 23);
  assert.equal(result.expected_version, 7);
  assert.match(
    result.idempotency_key,
    /^cli:outreach\.batch\.recipient-import:/,
  );
});

test("batch recipient file commit previews and commits each row sequentially", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-outreach-commit-"));
  const input = join(directory, "recipients.json");
  await writeFile(
    input,
    JSON.stringify([
      { person: "ada@example.edu", organization: "CRM-2026-000123" },
      { person: "grace@example.edu", organization: "CRM-2026-000123" },
    ]),
  );
  const limits = async () => ({ max_recipients_per_batch: 500 });
  const previewSetup = setup({
    getOutreachLimits: limits,
    getOutreachBatch: async () => ({ batch: { recipient_count: 0 } }),
    addOutreachRecipient: async (opts: any) => ({
      preview: true,
      expected_version: 7,
      idempotency_key: opts.idempotency_key,
    }),
  });
  const baseArgs = [
    "node",
    "test",
    "admin",
    "crm",
    "outreach",
    "batch",
    "add",
    "OUT-2026-000001",
    "--file",
    input,
    "--reason",
    "review deterministic recipient import",
  ];
  await previewSetup.program.parseAsync(baseArgs);
  const preview = (previewSetup.output() as any).data;

  let version = 7;
  const calls: any[] = [];
  const commitSetup = setup({
    getOutreachLimits: limits,
    getOutreachBatch: async () => ({ batch: { recipient_count: 0 } }),
    addOutreachRecipient: async (opts: any) => {
      calls.push(opts);
      if (!opts.commit) {
        return {
          preview: true,
          expected_version: version,
          idempotency_key: opts.idempotency_key,
        };
      }
      assert.equal(opts.expected_version, version);
      version += 1;
      return {
        preview: false,
        action: "outreach.recipient.add",
        replayed: false,
        result: { id: `delivery-${version}` },
      };
    },
  });
  await commitSetup.program.parseAsync([
    ...baseArgs,
    "--expected-version",
    `${preview.expected_version}`,
    "--idempotency-key",
    preview.idempotency_key,
    "--commit",
  ]);

  assert.deepEqual(
    calls.map((call) => call.commit),
    [false, true, false, true],
  );
  assert.deepEqual(
    calls.filter((call) => call.commit).map((call) => call.expected_version),
    [7, 8],
  );
  assert.equal((commitSetup.output() as any).data.mode, "sequential_commit");
  assert.equal((commitSetup.output() as any).data.results.length, 2);
});

test("batch recipient import enforces the configured row bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-outreach-bound-"));
  const input = join(directory, "recipients.json");
  await writeFile(
    input,
    JSON.stringify(
      Array.from({ length: 4 }, (_, index) => ({
        person: `person-${index}@example.edu`,
      })),
    ),
  );
  const { program } = setup({
    getOutreachLimits: async () => ({ max_recipients_per_batch: 3 }),
    getOutreachBatch: async () => ({ batch: { recipient_count: 0 } }),
  });
  await assert.rejects(
    program.parseAsync([
      "node",
      "test",
      "admin",
      "crm",
      "outreach",
      "batch",
      "add",
      "OUT-2026-000001",
      "--file",
      input,
      "--reason",
      "review bounded recipient import",
    ]),
    /contains 4 recipients; the effective limit is 3/,
  );
});

test("individual outreach delivery cancellation uses the delivery mutation API", async () => {
  let captured: any;
  const { program } = setup({
    mutateOutreachDelivery: async (opts: any) => {
      captured = opts;
      return { preview: true, expected_version: 4 };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "crm",
    "outreach",
    "delivery",
    "cancel",
    "delivery-1",
    "--reason",
    "cancel the reviewed unsent prospect message",
  ]);
  assert.equal(captured.delivery, "delivery-1");
  assert.equal(captured.action, "cancel");
  assert.equal(captured.commit, false);
  assert.match(captured.idempotency_key, /^cli:outreach\.delivery\.cancel:/);
});
