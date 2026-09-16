import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";

import { registerReceivablesCommand } from "./receivables";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE_ID = "22222222-2222-4222-8222-222222222222";

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    order_number: "AR-2026-000123",
    organization_name: "Example University",
    customer_account_id: null,
    stripe_customer_id: "cus_test",
    site_license_id: null,
    zendesk_ticket_ids: [20529],
    workflow_state: "ready_to_invoice",
    collection_mode: "stripe_invoice",
    collection_state: "not_invoiced",
    fulfillment_state: "not_provisioned",
    currency: "usd",
    agreed_subtotal: "3900",
    agreed_total: "3900",
    terms_snapshot: {},
    assignee_account_id: ACCOUNT_ID,
    next_action: "Create invoice",
    created_by_account_id: ACCOUNT_ID,
    created_at: "2026-08-22T10:00:00.000Z",
    updated_at: "2026-08-22T12:00:00.000Z",
    version: 7,
    items: [],
    contacts: [],
    quotes: [],
    documents: [],
    invoices: [],
    payments: [],
    ...overrides,
  };
}

function setup(
  commercialOrders: Record<string, any>,
  { json = true }: { json?: boolean } = {},
) {
  let output: any;
  const program = new Command();
  const admin = program.command("admin");
  registerReceivablesCommand(admin, {
    withContext: async (_command: unknown, _label: string, fn: any) => {
      output = await fn({
        accountId: ACCOUNT_ID,
        globals: { json },
        hub: {
          commercialOrders,
          system: {
            getPublicSiteUrl: async () => ({
              url: "https://billing.example.test",
            }),
          },
        },
      });
      return output;
    },
    resolveAccountByIdentifier: async (_ctx: unknown, identifier: string) => ({
      account_id: identifier === "billing@example.edu" ? ASSIGNEE_ID : null,
    }),
    isValidUUID: (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      ),
  });
  return { program, output: () => output };
}

test("quote links preview without mutation and return a URL only on commit", async () => {
  const calls: any[] = [];
  const client = {
    get: async () => order(),
    issueQuoteLink: async (request: any) => {
      calls.push(request);
      return {
        order: order({ version: 8 }),
        path: "/commercial/quotes/download#" + "a".repeat(64),
      };
    },
    revokeQuoteLink: async (request: any) => {
      calls.push(request);
      return order();
    },
  };
  const args = [
    "admin",
    "receivables",
    "quote",
    "share",
    "AR-2026-000123",
    "--quote-id",
    "44444444-4444-4444-8444-444444444444",
    "--expires-at",
    "2026-10-01",
    "--reason",
    "send reviewed quote",
  ];
  const dry = setup(client);
  await dry.program.parseAsync(args, { from: "user" });
  assert.equal(calls.length, 0);
  assert.equal(dry.output().preview, true);
  const committed = setup(client);
  await committed.program.parseAsync(
    [...args, "--expected-version", "7", "--commit"],
    { from: "user" },
  );
  assert.equal(calls[0].expected_version, 7);
  assert.equal(
    committed.output().url,
    "https://billing.example.test/commercial/quotes/download#" + "a".repeat(64),
  );
  const revoke = [
    "admin",
    "receivables",
    "quote",
    "revoke-link",
    "AR-2026-000123",
    "--quote-id",
    "44444444-4444-4444-8444-444444444444",
    "--reason",
    "revoke reviewed link",
  ];
  await setup(client).program.parseAsync(revoke, { from: "user" });
  assert.equal(calls.length, 1);
  await setup(client).program.parseAsync(
    [...revoke, "--expected-version", "7", "--commit"],
    { from: "user" },
  );
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].commercial_quote_id,
    "44444444-4444-4444-8444-444444444444",
  );
});

test("receivables help points agents to the bundled admin runbook", () => {
  const { program } = setup({});
  const admin = program.commands.find((command) => command.name() === "admin");
  const receivables = admin?.commands.find(
    (command) => command.name() === "receivables",
  );
  assert.ok(receivables);
  let help = "";
  receivables.configureOutput({ writeOut: (text) => (help += text) });
  receivables.outputHelp();
  assert.match(
    help,
    /cocalc docs show admin\/accounts-receivable --include-admin/,
  );
  assert.match(
    help,
    /cocalc docs skill-context --query "accounts receivable" --include-admin/,
  );
});

test("receivables list maps combined states and assignee filters", async () => {
  let captured: any;
  const response = {
    orders: [order()],
    truncated: false,
    result_bytes: 100,
  };
  const { program, output } = setup({
    list: async (opts: any) => {
      captured = opts;
      return response;
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "list",
    "--state",
    "ready-to-invoice,overdue,not-provisioned",
    "--assignee",
    "me",
    "--needs-action",
    "--next-action-due-before",
    "2026-09-01T00:00:00.000Z",
    "--limit",
    "25",
  ]);

  assert.deepEqual(captured.workflow_states, ["ready_to_invoice"]);
  assert.deepEqual(captured.collection_states, ["overdue"]);
  assert.deepEqual(captured.fulfillment_states, ["not_provisioned"]);
  assert.equal(captured.assignee_account_id, ACCOUNT_ID);
  assert.equal(captured.needs_action, true);
  assert.equal(captured.next_action_due_before, "2026-09-01T00:00:00.000Z");
  assert.equal(captured.limit, 25);
  assert.equal(captured.reason, "Review commercial receivables queue");
  assert.equal(output(), response);
});

test("receivables create previews without mutating and commits explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-ar-create-"));
  const file = join(directory, "order.json");
  await writeFile(
    file,
    JSON.stringify({
      organization_name: "Example University",
      agreed_subtotal: "3900",
      next_action: "Create invoice",
      next_action_due_at: "2026-09-01T00:00:00Z",
      items: [
        {
          description: "Campus adoption pilot",
          quantity: "1",
          unit_amount: "3900",
          subtotal: "3900",
          product_kind: "site_license",
        },
      ],
      contacts: [],
    }),
  );
  let calls = 0;
  let previewCalls = 0;
  let captured: any;
  const api = {
    createPreview: async (opts: any) => {
      previewCalls += 1;
      return {
        normalized_request: {
          ...opts,
          agreed_subtotal: "3900.0000000000",
          next_action_due_at: "2026-09-01T00:00:00.000Z",
        },
        approval_ready: false,
        approval_blockers: [
          "exactly one billing contact is required before approval",
        ],
      };
    },
    create: async (opts: any) => {
      calls += 1;
      captured = opts;
      return order();
    },
  };

  const previewRun = setup(api);
  await previewRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "create",
    "--file",
    file,
    "--reason",
    "accepted pilot",
  ]);
  assert.equal(calls, 0);
  assert.equal(previewCalls, 1);
  assert.equal(previewRun.output().preview, true);
  assert.equal(previewRun.output().request.source, "cli");
  assert.equal(
    previewRun.output().request.next_action_due_at,
    "2026-09-01T00:00:00.000Z",
  );
  assert.equal(previewRun.output().approval_ready, false);
  assert.deepEqual(previewRun.output().approval_blockers, [
    "exactly one billing contact is required before approval",
  ]);

  const commitRun = setup(api);
  await commitRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "create",
    "--file",
    file,
    "--reason",
    "accepted pilot",
    "--commit",
  ]);
  assert.equal(calls, 1);
  assert.equal(previewCalls, 1);
  assert.equal(captured.reason, "accepted pilot");
  assert.match(captured.idempotency_key, /^receivables-create-/);
});

test("purchase-order upload previews metadata without exposing PDF content and commits explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-ar-po-"));
  const file = join(directory, "PO-5874860.pdf");
  const content = Buffer.from("%PDF-1.4\n%%EOF\n");
  await writeFile(file, content);
  let calls = 0;
  let captured: any;
  const api = {
    get: async () => order(),
    uploadDocument: async (opts: any) => {
      calls += 1;
      captured = opts;
      return order({ version: 8 });
    },
  };

  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "document",
    "upload",
    "AR-2026-000123",
    "--file",
    file,
    "--reference",
    "5874860",
    "--reason",
    "attach Penn purchase order",
  ]);
  assert.equal(calls, 0);
  assert.equal(dryRun.output().request.document_filename, "PO-5874860.pdf");
  assert.equal(dryRun.output().request.document_reference, "5874860");
  assert.equal(dryRun.output().request.content_base64, undefined);
  assert.equal(dryRun.output().document.bytes, content.length);
  assert.equal(
    dryRun.output().document.sha256,
    createHash("sha256").update(content).digest("hex"),
  );

  const commitRun = setup(api);
  await commitRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "document",
    "upload",
    "AR-2026-000123",
    "--file",
    file,
    "--reference",
    "5874860",
    "--expected-version",
    "7",
    "--reason",
    "attach Penn purchase order",
    "--commit",
  ]);
  assert.equal(calls, 1);
  assert.equal(captured.expected_version, 7);
  assert.equal(captured.content_base64, content.toString("base64"));
  assert.equal(captured.document_kind, "purchase_order");
});

test("purchase-order download verifies integrity and void is preview-first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-ar-po-download-"));
  const outputFile = join(directory, "downloaded.pdf");
  const content = Buffer.from("%PDF-1.4\n%%EOF\n");
  const sha256 = createHash("sha256").update(content).digest("hex");
  let voidCalls = 0;
  const api = {
    get: async () => order(),
    downloadDocument: async () => ({
      document: {
        id: "44444444-4444-4444-8444-444444444444",
        document_reference: "5874860",
        document_filename: "PO-5874860.pdf",
        document_sha256: sha256,
      },
      content_base64: content.toString("base64"),
    }),
    voidDocument: async () => {
      voidCalls += 1;
      return order({ version: 8 });
    },
  };
  const downloadRun = setup(api);
  await downloadRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "document",
    "download",
    "AR-2026-000123",
    "--document-id",
    "44444444-4444-4444-8444-444444444444",
    "--output-file",
    outputFile,
  ]);
  assert.deepEqual(await readFile(outputFile), content);
  assert.equal(downloadRun.output().sha256, sha256);

  const voidRun = setup(api);
  await voidRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "document",
    "void",
    "AR-2026-000123",
    "--document-id",
    "44444444-4444-4444-8444-444444444444",
    "--reason",
    "replace incorrect purchase order",
  ]);
  assert.equal(voidCalls, 0);
  assert.equal(
    voidRun.output().request.commercial_order_document_id,
    "44444444-4444-4444-8444-444444444444",
  );
});

test("receivables billing correction previews and commits explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-ar-billing-"));
  const file = join(directory, "billing.json");
  await writeFile(
    file,
    JSON.stringify({
      billing_contacts: [
        {
          role: "billing",
          name_snapshot: "Accounts Payable",
          email_snapshot: "ap@example.edu",
        },
      ],
      billing_address: {
        line1: "100 College Avenue",
        city: "Example",
        state: "PA",
        postal_code: "19000",
        country: "US",
      },
    }),
  );
  let calls = 0;
  let captured: any;
  const api = {
    get: async () => order({ fulfillment_state: "provisioned" }),
    updateBillingDetails: async (request: any) => {
      calls += 1;
      captured = request;
      return order();
    },
  };

  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "billing",
    "update",
    "AR-2026-000123",
    "--file",
    file,
    "--reason",
    "correct procurement recipient",
  ]);
  assert.equal(calls, 0);
  assert.equal(dryRun.output().operation, "billing-update");
  assert.equal(
    dryRun.output().request.billing_contacts[0].email_snapshot,
    "ap@example.edu",
  );

  const commit = setup(api);
  await commit.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "billing",
    "update",
    "AR-2026-000123",
    "--file",
    file,
    "--reason",
    "correct procurement recipient",
    "--expected-version",
    "7",
    "--commit",
  ]);
  assert.equal(calls, 1);
  assert.equal(captured.expected_version, 7);
  assert.match(captured.idempotency_key, /^receivables-billing-update-/);
});

test("receivables collection mode transition previews and commits explicitly", async () => {
  let calls = 0;
  let captured: any;
  const api = {
    get: async () =>
      order({
        collection_mode: "manual_invoice",
        fulfillment_state: "provisioned",
      }),
    updateCollectionMode: async (request: any) => {
      calls += 1;
      captured = request;
      return order({
        collection_mode: request.collection_mode,
        fulfillment_state: "provisioned",
      });
    },
  };

  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "collection",
    "mode",
    "AR-2026-000123",
    "--mode",
    "stripe_invoice",
    "--reason",
    "use hosted Stripe invoicing",
  ]);
  assert.equal(calls, 0);
  assert.equal(dryRun.output().operation, "collection-mode-update");
  assert.equal(dryRun.output().request.collection_mode, "stripe_invoice");
  assert.match(
    dryRun.output().request.idempotency_key,
    /^receivables-collection-mode-/,
  );

  const commit = setup(api);
  await commit.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "collection",
    "mode",
    "AR-2026-000123",
    "--mode",
    "stripe_invoice",
    "--reason",
    "use hosted Stripe invoicing",
    "--expected-version",
    "7",
    "--commit",
  ]);
  assert.equal(calls, 1);
  assert.equal(captured.collection_mode, "stripe_invoice");
  assert.equal(captured.expected_version, 7);
});

test("receivables quote issue previews inputs and stored PDFs download", async () => {
  const quote = {
    id: "44444444-4444-4444-8444-444444444444",
    quote_number: "Q-2026-000123-01",
    document_filename: "Q-2026-000123-01.pdf",
    document_sha256: "a".repeat(64),
  };
  const quotePreview = {
    order_id: order().id,
    order_number: order().order_number,
    organization_name: order().organization_name,
    billing_contacts: [],
    items: [],
    currency: "usd",
    subtotal: "3900",
    total: "3900",
    default_valid_until: "2026-09-30T00:00:00.000Z",
    ready: true,
    blockers: [],
  };
  let issueCalls = 0;
  const api = {
    get: async () => order(),
    quotePreview: async () => quotePreview,
    issueQuote: async () => {
      issueCalls += 1;
      return order();
    },
    quoteDocument: async () => ({
      quote,
      content_base64: Buffer.from("%PDF-test").toString("base64"),
    }),
  };

  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "quote",
    "issue",
    "AR-2026-000123",
    "--reason",
    "send procurement quote",
  ]);
  assert.equal(issueCalls, 0);
  assert.deepEqual(dryRun.output().quote_preview, quotePreview);

  const commit = setup(api);
  await commit.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "quote",
    "issue",
    "AR-2026-000123",
    "--reason",
    "send procurement quote",
    "--expected-version",
    "7",
    "--commit",
  ]);
  assert.equal(issueCalls, 1);

  const directory = await mkdtemp(join(tmpdir(), "cocalc-ar-quote-"));
  const outputFile = join(directory, "quote.pdf");
  const download = setup(api);
  await download.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "quote",
    "download",
    "AR-2026-000123",
    "--quote-id",
    quote.id,
    "--output-file",
    outputFile,
  ]);
  assert.equal((await readFile(outputFile)).toString(), "%PDF-test");
  assert.equal(download.output().quote_number, quote.quote_number);
});

test("Stripe quote preview and create are dry-run first", async () => {
  const validUntil = "2026-10-01T00:00:00.000Z";
  const stripePreview = {
    order_id: order().id,
    order_number: order().order_number,
    organization_name: order().organization_name,
    billing_contacts: [],
    items: [],
    currency: "usd",
    subtotal: "3900",
    total: "3900",
    default_valid_until: validUntil,
    ready: true,
    blockers: [],
    stripe_mode: "test",
    stripe_customer_id: "cus_test",
    collection_method: "send_invoice",
    payment_terms_days: 30,
    description: "Example University commercial order",
    header: "CoCalc quote",
    footer: "Thank you",
    metadata: { commercial_order_id: order().id },
    products: [],
  };
  const previewRequests: any[] = [];
  const createRequests: any[] = [];
  const api = {
    get: async () => order(),
    stripeQuotePreview: async (request: any) => {
      previewRequests.push(request);
      return stripePreview;
    },
    createStripeQuote: async (request: any) => {
      createRequests.push(request);
      return order({ version: 8 });
    },
  };

  const directPreview = setup(api);
  await directPreview.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "quote",
    "stripe",
    "preview",
    "AR-2026-000123",
    "--valid-until",
    validUntil,
  ]);
  assert.deepEqual(directPreview.output(), stripePreview);
  assert.equal(previewRequests[0].valid_until, validUntil);
  assert.equal(previewRequests[0].reason, "Review commercial quote preview");

  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "quote",
    "stripe",
    "create",
    "AR-2026-000123",
    "--valid-until",
    validUntil,
    "--reason",
    "create reviewed Stripe quote",
  ]);
  assert.equal(createRequests.length, 0);
  assert.equal(dryRun.output().operation, "quote-stripe-create");
  assert.equal(dryRun.output().request.expected_version, 7);
  assert.equal(dryRun.output().request.valid_until, validUntil);
  assert.deepEqual(dryRun.output().stripe_quote_preview, stripePreview);
  assert.match(
    dryRun.output().request.idempotency_key,
    /^receivables-quote-stripe-create-/,
  );

  const unreviewedCommit = setup(api);
  await assert.rejects(
    unreviewedCommit.program.parseAsync([
      "node",
      "test",
      "admin",
      "receivables",
      "quote",
      "stripe",
      "create",
      "AR-2026-000123",
      "--reason",
      "create reviewed Stripe quote",
      "--commit",
    ]),
    /--expected-version or --expected-updated-at is required/,
  );
  assert.equal(createRequests.length, 0);

  const commit = setup(api);
  await commit.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "quote",
    "stripe",
    "create",
    "AR-2026-000123",
    "--valid-until",
    validUntil,
    "--reason",
    "create reviewed Stripe quote",
    "--expected-version",
    "7",
    "--idempotency-key",
    "example-university-stripe-quote-2026",
    "--commit",
  ]);
  assert.equal(createRequests.length, 1);
  assert.equal(createRequests[0].expected_version, 7);
  assert.equal(
    createRequests[0].idempotency_key,
    "example-university-stripe-quote-2026",
  );
  assert.equal(createRequests[0].source, "cli");
});

test("Stripe quote lifecycle mutations preview before committed writes", async () => {
  const quoteId = "44444444-4444-4444-8444-444444444444";
  const calls: Array<{ operation: string; request: any }> = [];
  const api = {
    get: async () => order(),
    finalizeStripeQuote: async (request: any) => {
      calls.push({ operation: "finalize", request });
      return order({ version: 8 });
    },
    acceptStripeQuote: async (request: any) => {
      calls.push({ operation: "accept", request });
      return order({ version: 8 });
    },
    cancelStripeQuote: async (request: any) => {
      calls.push({ operation: "cancel", request });
      return order({ version: 8 });
    },
    reconcileStripeQuote: async (request: any) => {
      calls.push({ operation: "reconcile", request });
      return order({ version: 8 });
    },
  };

  for (const operation of ["finalize", "accept", "cancel", "reconcile"]) {
    const acceptance =
      operation === "accept" ? ["--customer-acceptance-confirmed"] : [];
    const dryRun = setup(api);
    await dryRun.program.parseAsync([
      "node",
      "test",
      "admin",
      "receivables",
      "quote",
      "stripe",
      operation,
      "AR-2026-000123",
      "--quote-id",
      quoteId,
      "--reason",
      `${operation} reviewed Stripe quote`,
      ...acceptance,
    ]);
    assert.equal(calls.length, 0);
    assert.equal(dryRun.output().operation, `quote-stripe-${operation}`);
    assert.equal(dryRun.output().request.commercial_quote_id, quoteId);
    assert.equal(dryRun.output().request.expected_version, 7);
    assert.match(
      dryRun.output().request.idempotency_key,
      new RegExp(`^receivables-quote-stripe-${operation}-`),
    );
    if (operation === "accept") {
      assert.equal(dryRun.output().request.customer_acceptance_confirmed, true);
    }

    const commit = setup(api);
    await commit.program.parseAsync([
      "node",
      "test",
      "admin",
      "receivables",
      "quote",
      "stripe",
      operation,
      "AR-2026-000123",
      "--quote-id",
      quoteId,
      "--reason",
      `${operation} reviewed Stripe quote`,
      "--expected-version",
      "7",
      ...acceptance,
      "--commit",
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, operation);
    assert.equal(calls[0].request.commercial_quote_id, quoteId);
    assert.equal(calls[0].request.expected_version, 7);
    assert.equal(calls[0].request.source, "cli");
    if (operation === "accept") {
      assert.equal(calls[0].request.customer_acceptance_confirmed, true);
    }
    calls.length = 0;
  }
});

test("committed approval requires reviewed optimistic concurrency", async () => {
  let approveCalls = 0;
  const api = {
    get: async () => order(),
    approve: async () => {
      approveCalls += 1;
      return order({ workflow_state: "ready_to_invoice", version: 8 });
    },
  };
  const { program } = setup(api);

  await assert.rejects(
    program.parseAsync([
      "node",
      "test",
      "admin",
      "receivables",
      "approve",
      "AR-2026-000123",
      "--reason",
      "terms approved",
      "--commit",
    ]),
    /--expected-version or --expected-updated-at is required/,
  );
  assert.equal(approveCalls, 0);
});

test("receivables revise previews approved-term reset and commits explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-ar-revise-"));
  const file = join(directory, "revision.json");
  await writeFile(
    file,
    JSON.stringify({
      changes: {
        agreed_total: "4100",
        next_action: "Review agreement",
      },
      items: [
        {
          description: "Campus adoption pilot",
          quantity: "1",
          unit_amount: "4100",
          amount: "4100",
        },
      ],
    }),
  );
  let calls = 0;
  let captured: any;
  const api = {
    get: async () =>
      order({
        workflow_state: "awaiting_payment",
        approved_at: "2026-08-22T11:00:00.000Z",
      }),
    revise: async (opts: any) => {
      calls += 1;
      captured = opts;
      return order({ workflow_state: "draft", version: 8 });
    },
  };

  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "revise",
    "AR-2026-000123",
    "--file",
    file,
    "--reason",
    "customer accepted revised terms",
  ]);
  assert.equal(calls, 0);
  assert.equal(dryRun.output().preview, true);
  assert.equal(dryRun.output().operation, "revise");
  assert.equal(dryRun.output().request.expected_version, 7);
  assert.equal(dryRun.output().request.changes.agreed_total, "4100");
  assert.equal(dryRun.output().request.items.length, 1);
  assert.match(dryRun.output().approval_effect, /resets the order to draft/);
  assert.match(dryRun.output().request.idempotency_key, /^receivables-revise-/);

  const commitRun = setup(api);
  await commitRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "revise",
    "AR-2026-000123",
    "--file",
    file,
    "--reason",
    "customer accepted revised terms",
    "--expected-version",
    "7",
    "--idempotency-key",
    "revision-example-university-2026-08-23",
    "--commit",
  ]);
  assert.equal(calls, 1);
  assert.equal(captured.expected_version, 7);
  assert.equal(
    captured.idempotency_key,
    "revision-example-university-2026-08-23",
  );
  assert.equal(captured.source, "cli");
});

test("invoice reconcile uses server preview and never mutates by default", async () => {
  let reconcileCalls = 0;
  let previewArgs: any;
  const { program, output } = setup({
    get: async () =>
      order({
        invoices: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            status: "open",
          },
        ],
      }),
    reconcilePreview: async (opts: any) => {
      previewArgs = opts;
      return {
        order_id: order().id,
        commercial_invoice_id: "44444444-4444-4444-8444-444444444444",
        local_status: "open",
        local_total: "3900",
        local_amount_due: "3900",
        stale: true,
        ready: true,
        blockers: [],
      };
    },
    reconcileInvoice: async () => {
      reconcileCalls += 1;
      return order();
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "invoice",
    "reconcile",
    "AR-2026-000123",
    "--invoice-id",
    "44444444-4444-4444-8444-444444444444",
    "--reason",
    "verify Stripe state",
  ]);

  assert.equal(reconcileCalls, 0);
  assert.equal(
    previewArgs.commercial_invoice_id,
    "44444444-4444-4444-8444-444444444444",
  );
  assert.equal(output().reconcile_preview.ready, true);
  assert.equal(output().preview, true);
});

test("invoice link previews and commits the reviewed Stripe invoice", async () => {
  let calls = 0;
  let captured: any;
  const api = {
    get: async () => order(),
    linkExistingInvoice: async (opts: any) => {
      calls += 1;
      captured = opts;
      return order({ version: 8 });
    },
  };
  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "invoice",
    "link",
    "AR-2026-000123",
    "--provider-invoice-id",
    "in_test123",
    "--reason",
    "migrate existing invoice",
  ]);
  assert.equal(calls, 0);
  assert.equal(dryRun.output().request.provider_invoice_id, "in_test123");

  const commitRun = setup(api);
  await commitRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "invoice",
    "link",
    "AR-2026-000123",
    "--provider-invoice-id",
    "in_test123",
    "--expected-version",
    "7",
    "--reason",
    "migrate existing invoice",
    "--commit",
  ]);
  assert.equal(calls, 1);
  assert.equal(captured.expected_version, 7);
  assert.equal(captured.provider_invoice_id, "in_test123");
});

test("manual invoice issuance is preview-only until reviewed and committed", async () => {
  let calls = 0;
  let captured: any;
  const api = {
    get: async () =>
      order({
        collection_mode: "manual_invoice",
        workflow_state: "ready_to_invoice",
        approved_at: "2026-08-22T11:00:00.000Z",
      }),
    issueManualInvoice: async (opts: any) => {
      calls += 1;
      captured = opts;
      return order({
        collection_mode: "manual_invoice",
        collection_state: "open",
        workflow_state: "awaiting_payment",
        version: 8,
      });
    },
  };

  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "invoice",
    "issue-manual",
    "AR-2026-000123",
    "--invoice-reference",
    "FIN-2026-0042",
    "--issued-at",
    "2026-08-23T09:00:00Z",
    "--due-at",
    "2026-09-13T09:00:00Z",
    "--document-url",
    "https://billing.example.edu/invoices/42",
    "--evidence-reference",
    "finance-ledger-42",
    "--reason",
    "finance issued reviewed invoice",
  ]);
  assert.equal(calls, 0);
  assert.equal(dryRun.output().preview, true);
  assert.equal(dryRun.output().operation, "invoice-issue-manual");
  assert.equal(dryRun.output().request.invoice_reference, "FIN-2026-0042");
  assert.equal(dryRun.output().request.issued_at, "2026-08-23T09:00:00.000Z");
  assert.equal(
    dryRun.output().request.document_url,
    "https://billing.example.edu/invoices/42",
  );
  assert.match(
    dryRun.output().request.idempotency_key,
    /^receivables-invoice-issue-manual-/,
  );

  const commitRun = setup(api);
  await commitRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "invoice",
    "issue-manual",
    "AR-2026-000123",
    "--invoice-reference",
    "FIN-2026-0042",
    "--expected-version",
    "7",
    "--idempotency-key",
    "manual-invoice-example-university-2026-0042",
    "--reason",
    "finance issued reviewed invoice",
    "--commit",
  ]);
  assert.equal(calls, 1);
  assert.equal(captured.expected_version, 7);
  assert.equal(
    captured.idempotency_key,
    "manual-invoice-example-university-2026-0042",
  );
  assert.equal(captured.source, "cli");
});

test("manual payment requires commit and forwards exact decimal values", async () => {
  let calls = 0;
  let captured: any;
  const api = {
    get: async () => order(),
    recordManualPayment: async (opts: any) => {
      calls += 1;
      captured = opts;
      return order({ collection_state: "paid", version: 8 });
    },
  };
  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "payment",
    "record",
    "AR-2026-000123",
    "--amount",
    "3900.00",
    "--method",
    "bank-transfer",
    "--reference",
    "BANK-2026-08-22",
    "--reason",
    "bank transfer confirmed",
  ]);
  assert.equal(calls, 0);
  assert.equal(dryRun.output().request.amount, "3900.00");
  assert.equal(dryRun.output().request.method, "bank_transfer");

  const commitRun = setup(api);
  await commitRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "payment",
    "record",
    "AR-2026-000123",
    "--amount",
    "3900.00",
    "--method",
    "bank-transfer",
    "--reference",
    "BANK-2026-08-22",
    "--expected-updated-at",
    "2026-08-22T12:00:00Z",
    "--reason",
    "bank transfer confirmed",
    "--commit",
  ]);
  assert.equal(calls, 1);
  assert.equal(captured.expected_version, 7);
  assert.equal(captured.currency, "usd");
});

test("fulfillment provision includes authoritative preview", async () => {
  let calls = 0;
  const { program, output } = setup({
    get: async () => order(),
    fulfillmentPreview: async () => ({
      order_id: order().id,
      adapter: "site_license",
      action: "create",
      ready: true,
      blockers: [],
      planned_changes: [],
    }),
    provision: async () => {
      calls += 1;
      return order({ fulfillment_state: "provisioned" });
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "fulfillment",
    "provision",
    "AR-2026-000123",
    "--allow-before-payment",
    "--reason",
    "approved early activation",
  ]);
  assert.equal(calls, 0);
  assert.equal(output().fulfillment_preview.ready, true);
  assert.equal(output().request.allow_before_payment, true);
});

test("backfill calls server preview before commit and propagates commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cocalc-ar-backfill-"));
  const file = join(directory, "backfill.json");
  await writeFile(
    file,
    JSON.stringify([
      {
        organization_name: "Legacy University",
        agreed_total: "750",
        next_action: "Send invoice",
      },
    ]),
  );
  const captured: any[] = [];
  const api = {
    backfill: async (opts: any) => {
      captured.push(opts);
      return { preview: !opts.commit, created: [], skipped: [] };
    },
  };
  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "backfill",
    "--file",
    file,
    "--reason",
    "migrate legacy receivables",
  ]);
  assert.equal(captured[0].commit, false);

  const commitRun = setup(api);
  await commitRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "backfill",
    "--file",
    file,
    "--reason",
    "migrate legacy receivables",
    "--commit",
  ]);
  assert.equal(captured[1].commit, true);
  assert.match(captured[1].idempotency_key, /^receivables-backfill-/);
});

test("receivables export follows cursors with stable bounded CSV fields", async () => {
  const requests: any[] = [];
  const first = order({ order_number: "AR-2026-000001" });
  const second = order({ order_number: "AR-2026-000002" });
  const { program, output } = setup(
    {
      list: async (opts: any) => {
        requests.push(opts);
        return opts.cursor
          ? {
              orders: [second],
              truncated: false,
              result_bytes: 10,
            }
          : {
              orders: [first],
              next_cursor: "page-2",
              truncated: true,
              result_bytes: 10,
            };
      },
    },
    { json: false },
  );

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "export",
    "--format",
    "csv",
    "--max-rows",
    "2",
    "--state",
    "awaiting-payment,open",
  ]);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].cursor, "page-2");
  assert.equal(requests[0].limit, 2);
  assert.equal(requests[1].limit, 1);
  assert.deepEqual(requests[0].workflow_states, ["awaiting_payment"]);
  assert.deepEqual(requests[0].collection_states, ["open"]);
  const lines = output().trim().split("\n");
  assert.equal(
    lines[0],
    "order_number,id,organization_name,agreed_total,currency,collection_mode,workflow_state,collection_state,fulfillment_state,assignee_account_id,next_action,next_action_due_at,service_starts_at,service_ends_at,po_number,customer_reference,site_license_id,zendesk_ticket_ids,billing_email,latest_invoice_id,latest_invoice_status,latest_invoice_amount_due,latest_invoice_due_at,latest_invoice_sent_at,latest_invoice_created_at,last_activity_at,created_at,updated_at,version",
  );
  assert.match(lines[1], /^AR-2026-000001,/);
  assert.match(lines[2], /^AR-2026-000002,/);
});

test("receivables diagnostics uses the server review-queue report", async () => {
  let captured: any;
  const report = {
    generated_at: "2026-08-23T00:00:00.000Z",
    counts: { overdue: 3 },
    amounts: { overdue: "11700" },
    stale_invoice_ids: [],
    inconsistent_order_ids: [],
  };
  const { program, output } = setup({
    diagnostics: async (opts: any) => {
      captured = opts;
      return report;
    },
  });

  await program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "diagnostics",
    "--reconcile",
    "--reason",
    "review collection queues",
  ]);

  assert.deepEqual(captured, {
    reason: "review collection queues",
    reconcile: true,
  });
  assert.equal(output(), report);
});

test("receivables diagnostics forwards explicit legacy scope and pagination without mutations", async () => {
  let captured: any;
  const { program, output } = setup({
    diagnostics: async (opts: any) => {
      captured = opts;
      return {
        legacy_invoice_scan: {
          invoices: [],
          has_more: true,
          next_cursor: "in_next",
        },
      };
    },
  });
  await program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "diagnostics",
    "--include-legacy-invoices",
    "--legacy-invoice-limit",
    "50",
    "--legacy-invoice-cursor",
    "in_previous",
    "--reason",
    "legacy review",
  ]);
  assert.deepEqual(captured, {
    reason: "legacy review",
    reconcile: undefined,
    include_legacy_invoices: true,
    legacy_invoice_limit: 50,
    legacy_invoice_cursor: "in_previous",
  });
  assert.equal(output().legacy_invoice_scan.next_cursor, "in_next");
});

test("receivables diagnostics rejects invalid legacy scope and limits before calling the API", async () => {
  for (const args of [
    ["--legacy-invoice-limit", "5"],
    ["--include-legacy-invoices", "--legacy-invoice-limit", "NaN"],
    ["--include-legacy-invoices", "--legacy-invoice-limit", "501"],
    ["--include-legacy-invoices", "--legacy-invoice-limit", "0"],
  ]) {
    let called = false;
    const { program } = setup({
      diagnostics: async () => {
        called = true;
      },
    });
    await assert.rejects(
      program.parseAsync([
        "node",
        "test",
        "admin",
        "receivables",
        "diagnostics",
        ...args,
      ]),
    );
    assert.equal(called, false);
  }
});

test("receivables Stripe event retry previews and commits explicitly", async () => {
  const calls: any[] = [];
  const api = {
    retryStripeEvent: async (opts: any) => {
      calls.push(opts);
      return { event_id: opts.event_id, status: "pending" };
    },
  };
  const dryRun = setup(api);
  await dryRun.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "retry-stripe-event",
    "evt_retry123",
    "--reason",
    "operator reviewed dead letter",
  ]);
  assert.equal(calls.length, 0);
  assert.equal((dryRun.output() as any).preview, true);

  const commit = setup(api);
  await commit.program.parseAsync([
    "node",
    "test",
    "admin",
    "receivables",
    "retry-stripe-event",
    "evt_retry123",
    "--reason",
    "operator reviewed dead letter",
    "--commit",
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event_id, "evt_retry123");
  assert.match(calls[0].idempotency_key, /^receivables-stripe-event-retry-/);
});
