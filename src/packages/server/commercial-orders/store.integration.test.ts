/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";

import type * as Store from "./store";
import type { CommercialOrderCreateRequest } from "@cocalc/conat/hub/api/commercial-orders";

const describePglite =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const actor = randomUUID();

function request(
  overrides: Partial<CommercialOrderCreateRequest> = {},
): CommercialOrderCreateRequest {
  return {
    account_id: actor,
    reason: "accepted institutional pilot",
    source: "cli" as const,
    idempotency_key: `test-create-${randomUUID()}`,
    organization_name: "Integration Test University",
    collection_mode: "manual_invoice" as const,
    agreed_subtotal: "3900",
    agreed_total: "3900",
    next_action: "Approve agreement",
    next_action_due_at: new Date(Date.now() + 86_400_000).toISOString(),
    items: [
      {
        description: "Campus-wide adoption pilot",
        quantity: "1",
        unit_amount: "3900",
        subtotal: "3900",
        product_kind: "site_license",
      },
    ],
    contacts: [
      {
        role: "billing" as const,
        name_snapshot: "Accounts Payable",
        email_snapshot: "ap@example.edu",
      },
    ],
    ...overrides,
  };
}

describePglite("commercial order store", () => {
  const originalEnv = {
    COCALC_BAY_ID: process.env.COCALC_BAY_ID,
    COCALC_DB: process.env.COCALC_DB,
    COCALC_PGLITE_DATA_DIR: process.env.COCALC_PGLITE_DATA_DIR,
  };
  let store: typeof Store;
  let pool: Awaited<
    ReturnType<(typeof import("@cocalc/database/pool"))["default"]>
  >;

  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "commercial-orders-test-bay";
    process.env.COCALC_DB = "pglite";
    process.env.COCALC_PGLITE_DATA_DIR = "memory://";
    const getPool = (await import("@cocalc/database/pool")).default;
    pool = getPool();
    store = await import("./store");
    const { SCHEMA } = await import("@cocalc/util/db-schema");
    const { syncSchema } =
      await import("@cocalc/database/postgres/schema/sync");
    const commercialOrderSchema = Object.fromEntries(
      Object.entries(SCHEMA).filter(([name]) => name.startsWith("commercial_")),
    );
    await syncSchema(commercialOrderSchema);
    await getPool().query("DELETE FROM commercial_provider_operations");
    await getPool().query("DELETE FROM commercial_stripe_events");
    await getPool().query("DELETE FROM commercial_order_events");
    await getPool().query("DELETE FROM commercial_payments");
    await getPool().query("DELETE FROM commercial_invoices");
    await getPool().query("DELETE FROM commercial_order_documents");
    await getPool().query("DELETE FROM commercial_quotes");
    await getPool().query("DELETE FROM commercial_order_contacts");
    await getPool().query("DELETE FROM commercial_order_items");
    await getPool().query("DELETE FROM commercial_orders");
  });

  afterAll(async () => {
    const { closePglite } = await import("@cocalc/database/pglite");
    await closePglite();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("previews normalized create terms without writing an order", async () => {
    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM commercial_orders",
    );
    const preview = store.previewCommercialOrderCreate(
      request({
        agreed_subtotal: "3900.00",
        next_action_due_at: "2026-09-01T00:00:00Z",
        contacts: [],
      }),
    );
    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM commercial_orders",
    );

    expect(after.rows[0].count).toBe(before.rows[0].count);
    expect(preview.normalized_request.agreed_subtotal).toBe("3900.0000000000");
    expect(preview.normalized_request.next_action_due_at).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(preview.normalized_request.account_id).toBeUndefined();
    expect(preview.approval_ready).toBe(false);
    expect(preview.approval_blockers).toEqual([
      "exactly one billing contact is required before approval",
    ]);

    expect(() =>
      store.previewCommercialOrderCreate(
        request({ next_action: "Call Alice about the PO" as any }),
      ),
    ).toThrow("next_action is invalid");
    expect(() =>
      store.previewCommercialOrderCreate(
        request({ next_action_due_at: "not-a-date" }),
      ),
    ).toThrow("next_action_due_at must be an ISO-8601 timestamp");
    expect(() =>
      store.previewCommercialOrderCreate(request({ items: [] })),
    ).toThrow("at least one line item is required");
  });

  it("creates an idempotent seed-global order and immutable event", async () => {
    const opts = request();
    const first = await store.createCommercialOrder(opts);
    const replay = await store.createCommercialOrder(opts);
    expect(replay.id).toBe(first.id);
    expect(first.order_number).toMatch(/^AR-\d{4}-[A-F0-9]{8}$/);
    expect(first.items).toHaveLength(1);
    const events = await store.listCommercialOrderEvents({
      id: first.id,
      reason: "verify audit timeline",
    });
    expect(events.events.map(({ event_type }) => event_type)).toEqual([
      "order-created",
    ]);
    expect(events.truncated).toBe(false);
    expect(events.result_bytes).toBeGreaterThan(2);
  });

  it("binds event idempotency keys to action, order, and payload", async () => {
    const createKey = `bound-create-${randomUUID()}`;
    const original = request({ idempotency_key: createKey });
    const created = await store.createCommercialOrder(original);
    await expect(
      store.createCommercialOrder({
        ...original,
        organization_name: "Different University",
      }),
    ).rejects.toThrow("different action, order, or payload");

    const noteKey = `bound-note-${randomUUID()}`;
    const noted = await store.addCommercialOrderNote({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "record customer context",
      idempotency_key: noteKey,
      note: "Original note",
    });
    await expect(
      store.addCommercialOrderNote({
        account_id: actor,
        id: created.id,
        expected_version: noted.version,
        reason: "record customer context",
        idempotency_key: noteKey,
        note: "Changed note",
      }),
    ).rejects.toThrow("different action, order, or payload");
    await expect(
      store.assignCommercialOrder({
        account_id: actor,
        id: created.id,
        expected_version: noted.version,
        reason: "attempt cross-action replay",
        idempotency_key: noteKey,
        next_action: "Contact customer",
      }),
    ).rejects.toThrow("different action, order, or payload");

    const other = await store.createCommercialOrder(request());
    await expect(
      store.addCommercialOrderNote({
        account_id: actor,
        id: other.id,
        expected_version: other.version,
        reason: "record customer context",
        idempotency_key: noteKey,
        note: "Original note",
      }),
    ).rejects.toThrow("different action, order, or payload");
  });

  it("enforces optimistic versions and keeps fulfillment independent", async () => {
    const created = await store.createCommercialOrder(request());
    await expect(
      store.updateCommercialOrder({
        account_id: actor,
        id: created.id,
        expected_version: created.version + 1,
        reason: "stale browser update",
        changes: { next_action: "Contact customer" },
      }),
    ).rejects.toThrow("current version");
    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "terms reviewed",
    });
    const paid = await store.recordManualCommercialPayment({
      account_id: actor,
      id: approved.id,
      expected_version: approved.version,
      reason: "wire confirmed by bank",
      amount: "3900",
      currency: "usd",
      method: "wire",
      evidence_reference: "bank-reference-test-1",
    });
    expect(paid.collection_state).toBe("paid");
    expect(paid.fulfillment_state).toBe("not_provisioned");
    expect(paid.workflow_state).toBe("awaiting_payment");
    expect(paid.payments).toHaveLength(1);
  });

  it("supports bounded queue filtering", async () => {
    const result = await store.listCommercialOrders({
      reason: "review open receivables",
      needs_action: true,
      organization: "Integration Test",
      limit: 2,
      max_bytes: 100_000,
    });
    expect(result.orders.length).toBeGreaterThan(0);
    expect(
      result.orders.every(({ organization_name }) =>
        organization_name.includes("Integration Test"),
      ),
    ).toBe(true);
    expect(result.result_bytes).toBeLessThanOrEqual(100_000);
  });

  it("filters stale follow-up work by next-action due date in SQL", async () => {
    const organization = `Due Filter University ${randomUUID()}`;
    await store.createCommercialOrder(
      request({ organization_name: organization }),
    );
    const future = await store.listCommercialOrders({
      reason: "review stale next actions",
      organization,
      next_action_due_before: new Date(
        Date.now() + 2 * 86_400_000,
      ).toISOString(),
    });
    const past = await store.listCommercialOrders({
      reason: "review stale next actions",
      organization,
      next_action_due_before: new Date(
        Date.now() - 2 * 86_400_000,
      ).toISOString(),
    });
    expect(future.orders).toHaveLength(1);
    expect(past.orders).toHaveLength(0);
  });

  it("freezes approved terms and atomically resets approval on revision", async () => {
    const created = await store.createCommercialOrder(request());
    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "approve reviewed terms",
    });
    await expect(
      store.updateCommercialOrder({
        account_id: actor,
        id: approved.id,
        expected_version: approved.version,
        reason: "attempt silent price change",
        changes: { agreed_total: "4100" },
      }),
    ).rejects.toThrow("approved terms are frozen");

    const revised = await store.reviseCommercialOrder({
      account_id: actor,
      id: approved.id,
      expected_version: approved.version,
      reason: "customer accepted revised price",
      changes: {
        agreed_subtotal: "4100",
        agreed_total: "4100",
      },
      items: [
        {
          description: "Revised campus-wide adoption pilot",
          quantity: "1",
          unit_amount: "4100",
          subtotal: "4100",
          product_kind: "site_license",
        },
      ],
    });
    expect(revised.workflow_state).toBe("draft");
    expect(revised.collection_state).toBe("not_invoiced");
    expect(revised.approved_at).toBeNull();
    expect(revised.approved_by_account_id).toBeNull();
    expect(revised.agreed_total).toBe("4100.0000000000");
    expect(revised.next_action).toBe("Review agreement");
  });

  it("enforces terminal and fulfillment transition invariants", async () => {
    const unapproved = await store.createCommercialOrder(request());
    await expect(
      store.setCommercialFulfillment({
        account_id: actor,
        id: unapproved.id,
        expected_version: unapproved.version,
        reason: "attempt premature provisioning",
        fulfillment_state: "provisioned",
      }),
    ).rejects.toThrow("must be approved before fulfillment");

    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: unapproved.id,
      expected_version: unapproved.version,
      reason: "approve reviewed terms",
    });
    await expect(
      store.setCommercialFulfillment({
        account_id: actor,
        id: approved.id,
        expected_version: approved.version,
        reason: "attempt invalid service ending",
        fulfillment_state: "ended",
      }),
    ).rejects.toThrow("cannot end before");

    const cancelled = await store.cancelCommercialOrder({
      account_id: actor,
      id: approved.id,
      expected_version: approved.version,
      reason: "customer withdrew agreement",
    });
    await expect(
      store.recordManualCommercialPayment({
        account_id: actor,
        id: cancelled.id,
        expected_version: cancelled.version,
        reason: "attempt cancelled payment",
        amount: "3900",
        currency: "usd",
        method: "wire",
        evidence_reference: "cancelled-order-wire",
      }),
    ).rejects.toThrow("not allowed on a cancelled order");
    await expect(
      store.setCommercialFulfillment({
        account_id: actor,
        id: cancelled.id,
        expected_version: cancelled.version,
        reason: "attempt cancelled provisioning",
        fulfillment_state: "provisioned",
      }),
    ).rejects.toThrow("cancelled order");
    await expect(
      store.updateCommercialOrder({
        account_id: actor,
        id: cancelled.id,
        expected_version: cancelled.version,
        reason: "attempt cancelled reopening",
        changes: { workflow_state: "draft" },
      }),
    ).rejects.toThrow("not allowed on a cancelled order");

    const completionDraft = await store.createCommercialOrder(request());
    const completionApproved = await store.approveCommercialOrder({
      account_id: actor,
      id: completionDraft.id,
      expected_version: completionDraft.version,
      reason: "approve completion fixture",
    });
    const provisioned = await store.setCommercialFulfillment({
      account_id: actor,
      id: completionApproved.id,
      expected_version: completionApproved.version,
      reason: "provision completion fixture",
      fulfillment_state: "provisioned",
    });
    await expect(
      store.cancelCommercialOrder({
        account_id: actor,
        id: provisioned.id,
        expected_version: provisioned.version,
        reason: "attempt cancellation with active service",
      }),
    ).rejects.toThrow("end active fulfillment");
    const complete = await store.recordManualCommercialPayment({
      account_id: actor,
      id: provisioned.id,
      expected_version: provisioned.version,
      reason: "settle completion fixture",
      amount: "3900",
      currency: "usd",
      method: "wire",
      evidence_reference: "completion-wire",
    });
    expect(complete.workflow_state).toBe("complete");
    await expect(
      store.updateCommercialOrder({
        account_id: actor,
        id: complete.id,
        expected_version: complete.version,
        reason: "attempt complete reopening",
        changes: { workflow_state: "draft" },
      }),
    ).rejects.toThrow("not allowed on a complete order");
  });

  it("records a due manual invoice before collecting payment", async () => {
    const created = await store.createCommercialOrder(request());
    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "approve manual invoice terms",
    });
    const issueRequest = {
      account_id: actor,
      id: approved.id,
      expected_version: approved.version,
      reason: "manual invoice sent by finance",
      idempotency_key: `manual-invoice-${randomUUID()}`,
      invoice_reference: "FIN-2026-0042",
      issued_at: "2026-08-01T00:00:00.000Z",
      due_at: "2026-08-22T00:00:00.000Z",
      document_url: "https://billing.example.edu/invoices/42",
      evidence_reference: "finance-ledger-42",
    };
    const issued = await store.issueManualCommercialInvoice(issueRequest);
    const replay = await store.issueManualCommercialInvoice(issueRequest);
    expect(replay.id).toBe(issued.id);
    expect(issued.collection_state).toBe("overdue");
    expect(issued.workflow_state).toBe("awaiting_payment");
    expect(issued.invoices).toHaveLength(1);
    expect(issued.invoices[0]).toMatchObject({
      provider: "manual",
      status: "open",
      total: "3900.0000000000",
      amount_due: "3900.0000000000",
      sent_at: "2026-08-01T00:00:00.000Z",
    });
  });

  it("issues one-time links, rotates and revokes them without changing the quote", async () => {
    const created = await store.createCommercialOrder(request());
    const quoted = await store.issueCommercialQuote({
      id: created.id,
      account_id: actor,
      expected_version: created.version,
      reason: "prepare downloadable quote",
      idempotency_key: randomUUID(),
    });
    const quote = quoted.quotes[0];
    const linkRequest = {
      id: quoted.id,
      account_id: actor,
      commercial_quote_id: quote.id,
      expected_version: quoted.version,
      idempotency_key: randomUUID(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      reason: "share quote with customer",
    };
    const shared = await store.issueCommercialQuoteLink(linkRequest);
    expect(shared.path).toMatch(
      /^\/commercial\/quotes\/download#[a-f0-9]{64}$/,
    );
    const token = shared.path!.split("#")[1];
    const flags = await import("./feature-flags");
    const enabled = jest
      .spyOn(flags, "assertCommercialReceivablesCapability")
      .mockResolvedValue(undefined);
    const { downloadPublicQuote } = await import("./public-quote");
    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, () => downloadPublicQuote(token)),
    );
    expect(
      attempts.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(20);
    await expect(downloadPublicQuote(token)).rejects.toMatchObject({
      code: 404,
    });
    await pool.query(
      "UPDATE commercial_quotes SET download_window_at=NOW()-INTERVAL '2 minutes' WHERE id=$1",
      [quote.id],
    );
    await expect(downloadPublicQuote(token)).resolves.toHaveProperty(
      "content_base64",
    );
    const stored = (
      await pool.query(
        "SELECT download_token_hash FROM commercial_quotes WHERE id=$1",
        [quote.id],
      )
    ).rows[0];
    expect(stored.download_token_hash).not.toBe(token);
    expect(JSON.stringify(shared.order)).not.toContain(token);
    expect(JSON.stringify(shared.order)).not.toContain(
      stored.download_token_hash,
    );
    const replay = await store.issueCommercialQuoteLink(linkRequest);
    expect(replay.path).toBeNull();
    expect(replay.order.version).toBe(shared.order.version);
    const rotated = await store.issueCommercialQuoteLink({
      ...linkRequest,
      expected_version: shared.order.version,
      idempotency_key: randomUUID(),
    });
    expect(rotated.path).not.toBe(shared.path);
    await expect(downloadPublicQuote(token)).rejects.toMatchObject({
      code: 404,
    });
    const revoked = await store.revokeCommercialQuoteLink({
      ...linkRequest,
      expected_version: rotated.order.version,
      idempotency_key: randomUUID(),
    });
    expect(revoked.quotes[0].status).toBe("issued");
    await expect(
      downloadPublicQuote(rotated.path!.split("#")[1]),
    ).rejects.toMatchObject({ code: 404 });
    expect(
      (
        await pool.query(
          "SELECT download_token_hash FROM commercial_quotes WHERE id=$1",
          [quote.id],
        )
      ).rows[0].download_token_hash,
    ).toBeNull();
    await expect(
      store.issueCommercialQuoteLink({
        ...linkRequest,
        expected_version: revoked.version,
        idempotency_key: randomUUID(),
        expires_at: "2000-01-01",
      }),
    ).rejects.toThrow("expiration");
    const fresh = await store.issueCommercialQuoteLink({
      ...linkRequest,
      expected_version: revoked.version,
      idempotency_key: randomUUID(),
    });
    const freshToken = fresh.path!.split("#")[1];
    await pool.query(
      "UPDATE commercial_quotes SET download_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
      [quote.id],
    );
    await expect(downloadPublicQuote(freshToken)).rejects.toMatchObject({
      code: 404,
    });
    await pool.query(
      "UPDATE commercial_quotes SET download_expires_at=NOW()+INTERVAL '1 hour' WHERE id=$1",
      [quote.id],
    );
    const voided = await store.voidCommercialQuote({
      ...linkRequest,
      expected_version: fresh.order.version,
      idempotency_key: randomUUID(),
    });
    await expect(downloadPublicQuote(freshToken)).rejects.toMatchObject({
      code: 404,
    });
    await expect(
      store.issueCommercialQuoteLink({
        ...linkRequest,
        expected_version: voided.version,
        idempotency_key: randomUUID(),
      }),
    ).rejects.toThrow("only retained");
    const events = await pool.query(
      "SELECT * FROM commercial_order_events WHERE commercial_order_id=$1",
      [quoted.id],
    );
    expect(JSON.stringify(events.rows)).not.toContain(token);
    expect(JSON.stringify(events.rows)).not.toContain(
      stored.download_token_hash,
    );
    enabled.mockRestore();
  });

  it("voids and reissues a manual invoice idempotently", async () => {
    const created = await store.createCommercialOrder(request());
    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "approve manual correction fixture",
    });
    const issued = await store.issueManualCommercialInvoice({
      account_id: actor,
      id: approved.id,
      expected_version: approved.version,
      reason: "issue original manual invoice",
      idempotency_key: `manual-original-${randomUUID()}`,
      invoice_reference: "FIN-ORIGINAL",
    });
    const voidRequest = {
      account_id: actor,
      id: issued.id,
      commercial_invoice_id: issued.invoices[0].id,
      expected_version: issued.version,
      reason: "correct recipient on manual invoice",
      idempotency_key: `manual-void-${randomUUID()}`,
    };
    const voided = await store.voidManualCommercialInvoice(voidRequest);
    const replay = await store.voidManualCommercialInvoice(voidRequest);
    expect(replay.version).toBe(voided.version);
    expect(voided.collection_state).toBe("void");
    expect(voided.workflow_state).toBe("ready_to_invoice");
    expect(voided.invoices[0]).toMatchObject({
      provider: "manual",
      status: "void",
      amount_due: "0.0000000000",
    });

    const reissued = await store.issueManualCommercialInvoice({
      account_id: actor,
      id: voided.id,
      expected_version: voided.version,
      reason: "issue corrected manual invoice",
      idempotency_key: `manual-reissue-${randomUUID()}`,
      invoice_reference: "FIN-CORRECTED",
    });
    expect(reissued.invoices).toHaveLength(2);
    expect(reissued.invoices.map(({ status }) => status).sort()).toEqual([
      "open",
      "void",
    ]);
  });

  it("uses collection-mode-specific approval transitions", async () => {
    const complimentary = await store.createCommercialOrder(
      request({
        collection_mode: "complimentary",
        terms_snapshot: { fulfillment_required: false },
      }),
    );
    const completed = await store.approveCommercialOrder({
      account_id: actor,
      id: complimentary.id,
      expected_version: complimentary.version,
      reason: "approve no-fulfillment complimentary order",
    });
    expect(completed.collection_state).toBe("waived");
    expect(completed.workflow_state).toBe("complete");
    expect(completed.next_action).toBe("Complete");

    const provisionedLater = await store.createCommercialOrder(
      request({
        collection_mode: "complimentary",
        terms_snapshot: { fulfillment_required: true },
      }),
    );
    const ready = await store.approveCommercialOrder({
      account_id: actor,
      id: provisionedLater.id,
      expected_version: provisionedLater.version,
      reason: "approve complimentary fulfillment order",
    });
    expect(ready.collection_state).toBe("waived");
    expect(ready.workflow_state).toBe("ready_to_invoice");
    expect(ready.next_action).toBe("Provision service");
  });

  it("requires one deterministic invoice recipient", async () => {
    const created = await store.createCommercialOrder(
      request({
        contacts: [
          {
            role: "billing",
            name_snapshot: "First Billing Contact",
            email_snapshot: "first@example.edu",
          },
          {
            role: "billing",
            name_snapshot: "Second Billing Contact",
            email_snapshot: "second@example.edu",
          },
        ],
      }),
    );
    await expect(
      store.approveCommercialOrder({
        account_id: actor,
        id: created.id,
        expected_version: created.version,
        reason: "attempt ambiguous invoice recipient",
      }),
    ).rejects.toThrow("exactly one billing contact");
  });

  it("issues, stores, downloads, and voids immutable quote PDFs", async () => {
    const created = await store.createCommercialOrder(
      request({
        terms_snapshot: {
          invoice: {
            memo: "Campus-wide CoCalc adoption pilot",
            billing_address: {
              line1: "100 College Avenue",
              city: "Example",
              state: "PA",
              postal_code: "19000",
              country: "US",
            },
          },
        },
      }),
    );
    const issueRequest = {
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "send formal procurement quote",
      idempotency_key: `quote-issue-${randomUUID()}`,
      valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    const issued = await store.issueCommercialQuote(issueRequest);
    const replay = await store.issueCommercialQuote(issueRequest);
    expect(replay.version).toBe(issued.version);
    expect(issued.quotes).toHaveLength(1);
    expect(issued.quotes[0]).toMatchObject({
      status: "issued",
      currency: "usd",
      total: "3900.0000000000",
      document_mime_type: "application/pdf",
    });
    expect(issued.quotes[0].quote_number).toMatch(/^Q-\d{4}-[A-F0-9]{8}-01$/);
    expect(issued.quotes[0].document_sha256).toMatch(/^[0-9a-f]{64}$/);

    const document = await store.getCommercialQuoteDocument({
      id: issued.id,
      commercial_quote_id: issued.quotes[0].id,
      reason: "verify generated quote document",
    });
    expect(
      Buffer.from(document.content_base64, "base64").subarray(0, 4),
    ).toEqual(Buffer.from("%PDF"));
    expect(document.quote.snapshot).toMatchObject({
      order_version: created.version,
      organization_name: "Integration Test University",
      billing_address: { line1: "100 College Avenue" },
    });

    const voided = await store.voidCommercialQuote({
      account_id: actor,
      id: issued.id,
      commercial_quote_id: issued.quotes[0].id,
      expected_version: issued.version,
      reason: "customer requested revised quote",
      idempotency_key: `quote-void-${randomUUID()}`,
    });
    expect(voided.quotes[0].status).toBe("void");
    const retained = await store.getCommercialQuoteDocument({
      id: voided.id,
      commercial_quote_id: voided.quotes[0].id,
      reason: "verify voided quote retention",
    });
    expect(retained.content_base64).toBe(document.content_base64);
  });

  it("persists and reconciles a Stripe quote intent without using local void", async () => {
    const created = await store.createCommercialOrder(request());
    const intentRequest = {
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "create reviewed Stripe quote",
      source: "cli" as const,
      idempotency_key: `stripe-quote-${randomUUID()}`,
      valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    const intent = await store.createCommercialStripeQuoteIntent(intentRequest);
    const replay = await store.createCommercialStripeQuoteIntent(intentRequest);
    expect(replay.quote.id).toBe(intent.quote.id);
    expect(intent.quote).toMatchObject({
      provider: "stripe",
      status: "draft",
      provider_status: null,
    });

    const draft = await store.updateCommercialQuoteProvider({
      quote_id: intent.quote.id,
      status: "draft",
      provider_quote_id: "qt_store_integration",
      provider_status: "draft",
      provider_snapshot: {
        id: "qt_store_integration",
        status: "draft",
      },
      actor_account_id: actor,
      event_type: "stripe-quote-draft-created",
      event_source: "cli",
      event_reason: "attach Stripe draft identity",
      event_idempotency_key: `stripe-quote-attached-${randomUUID()}`,
    });
    expect(draft.quotes[0]).toMatchObject({
      provider_quote_id: "qt_store_integration",
      provider_status: "draft",
    });
    await expect(
      store.updateCommercialBillingDetails({
        account_id: actor,
        id: draft.id,
        expected_version: draft.version,
        reason: "attempt billing correction with active quote",
        billing_contacts: [
          {
            role: "billing",
            name_snapshot: "Replacement Billing",
            email_snapshot: "replacement@example.edu",
          },
        ],
      }),
    ).rejects.toThrow("cancel it first");

    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: draft.id,
      expected_version: draft.version,
      reason: "approve active Stripe quote fixture",
    });
    await expect(
      store.reviseCommercialOrder({
        account_id: actor,
        id: approved.id,
        expected_version: approved.version,
        reason: "attempt revision with active Stripe quote",
        changes: {
          agreed_subtotal: "4100",
          agreed_total: "4100",
        },
        items: [
          {
            description: "Revised adoption pilot",
            quantity: "1",
            unit_amount: "4100",
            subtotal: "4100",
            product_kind: "site_license",
          },
        ],
      }),
    ).rejects.toThrow("cancel it first");

    await expect(
      store.voidCommercialQuote({
        account_id: actor,
        id: approved.id,
        commercial_quote_id: intent.quote.id,
        expected_version: approved.version,
        reason: "attempt local void on provider quote",
      }),
    ).rejects.toThrow("Stripe quotes must be canceled");

    const pdf = Buffer.from("%PDF-1.4\nStripe quote\n%%EOF\n");
    const { createHash } = await import("node:crypto");
    const issued = await store.updateCommercialQuoteProvider({
      quote_id: intent.quote.id,
      status: "issued",
      provider_quote_id: "qt_store_integration",
      provider_status: "open",
      provider_snapshot: {
        id: "qt_store_integration",
        status: "open",
      },
      issued_at: new Date().toISOString(),
      document_filename: "QT-TEST.pdf",
      document_sha256: createHash("sha256").update(pdf).digest("hex"),
      document_data: pdf,
      actor_account_id: actor,
      event_type: "stripe-quote-finalized",
      event_source: "cli",
      event_reason: "retain finalized Stripe quote",
      event_idempotency_key: `stripe-quote-finalized-${randomUUID()}`,
    });
    expect(issued.quotes[0]).toMatchObject({
      status: "issued",
      provider_status: "open",
      document_filename: "QT-TEST.pdf",
    });
    const document = await store.getCommercialQuoteDocument({
      id: issued.id,
      commercial_quote_id: intent.quote.id,
      reason: "verify retained Stripe quote",
    });
    expect(Buffer.from(document.content_base64, "base64")).toEqual(pdf);

    const operation = await store.reserveCommercialProviderOperation({
      order_id: issued.id,
      quote_id: intent.quote.id,
      operation: "quote_reconcile",
      expected_version: issued.version,
      idempotency_key: `stripe-quote-operation-${randomUUID()}`,
    });
    expect(operation.operation.commercial_quote_id).toBe(intent.quote.id);
  });

  async function issuedTaxQuoteAcceptance(
    status: "remote_started" | "indeterminate",
  ) {
    const created = await store.createCommercialOrder(
      request({
        collection_mode: "stripe_invoice",
        agreed_total: "4680",
        terms_snapshot: {
          invoice: {
            automatic_tax: true,
            tax_code: "txcd_10103000",
            billing_address: { country: "GB" },
          },
        },
      }),
    );
    const intent = await store.createCommercialStripeQuoteIntent({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "Reviewed taxable quote",
      idempotency_key: `tax-quote-${randomUUID()}`,
      valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: intent.order.version,
      reason: "Approve reviewed taxable quote",
    });
    const pdf = Buffer.from("%PDF-1.4\nTaxable Stripe quote\n%%EOF\n");
    const quoteId = `qt_${randomUUID().replaceAll("-", "")}`;
    const issued = await store.updateCommercialQuoteProvider({
      quote_id: intent.quote.id,
      status: "issued",
      provider_quote_id: quoteId,
      provider_status: "open",
      provider_snapshot: {},
      issued_at: new Date().toISOString(),
      document_filename: "taxable.pdf",
      document_data: pdf,
      document_sha256: createHash("sha256").update(pdf).digest("hex"),
      actor_account_id: actor,
      event_type: "stripe-quote-finalized",
      event_source: "cli",
      event_reason: "Retain reviewed taxable quote",
      event_idempotency_key: `issue-tax-${randomUUID()}`,
    });
    const invoice = await store.createCommercialInvoiceIntent({
      order_id: issued.id,
      actor_account_id: actor,
      expected_version: issued.version,
      reason: "Adopt accepted taxable quote",
      idempotency_key: `accept-tax-invoice-${randomUUID()}`,
    });
    const { operation } = await store.reserveCommercialProviderOperation({
      order_id: issued.id,
      quote_id: intent.quote.id,
      invoice_id: invoice.invoice.id,
      operation: "quote_accept",
      expected_version: invoice.order.version,
      idempotency_key: `accept-tax-operation-${randomUUID()}`,
    });
    await store.setCommercialProviderOperationStatus({
      id: operation.id,
      status,
    });
    const update: Store.CommercialQuoteAcceptanceUpdate = {
      operation_id: operation.id,
      quote_id: intent.quote.id,
      invoice_id: invoice.invoice.id,
      provider_quote_id: quoteId,
      provider_invoice_id: `in_${randomUUID().replaceAll("-", "")}`,
      provider_customer_id: "cus_tax_test",
      quote_provider_snapshot: { status: "accepted" },
      invoice_provider_snapshot: {
        automatic_tax: { enabled: true, status: "complete" },
      },
      acceptance_source:
        status === "indeterminate"
          ? "provider_reconciliation"
          : "operator_confirmed",
      subtotal: "3900",
      tax: "780",
      total: "4680",
      amount_due: "4680",
      actor_account_id: actor,
      event_source: "cli",
      event_reason: "Record accepted taxable invoice",
      event_idempotency_key: `tax-accepted-${randomUUID()}`,
    };
    return { orderId: issued.id, update };
  }

  it.each(["remote_started", "indeterminate"] as const)(
    "completes positive-tax quote acceptance from %s and replays once",
    async (status) => {
      const { orderId, update } = await issuedTaxQuoteAcceptance(status);
      const accepted = await store.completeCommercialQuoteAcceptance(update);
      expect(accepted.collection_state).toBe("draft_invoice");
      expect(accepted.quotes[0].status).toBe("accepted");
      expect(accepted.invoices).toHaveLength(1);
      expect(accepted.invoices[0]).toMatchObject({
        status: "draft",
        subtotal: "3900.0000000000",
        tax: "780.0000000000",
        total: "4680.0000000000",
        amount_due: "4680.0000000000",
      });
      const replay = await store.completeCommercialQuoteAcceptance(update);
      expect(replay.version).toBe(accepted.version);
      expect(replay.invoices).toHaveLength(1);
      const result = await pool.query(
        "SELECT status FROM commercial_provider_operations WHERE id=$1",
        [update.operation_id],
      );
      expect(result.rows[0].status).toBe("succeeded");
      const events = await pool.query(
        "SELECT id FROM commercial_order_events WHERE commercial_order_id=$1 AND event_type='stripe-quote-accepted'",
        [orderId],
      );
      expect(events.rows).toHaveLength(1);
    },
  );

  it.each([
    { tax: "0" },
    { tax: "779.99" },
    { tax: "780.01" },
    { tax: "-780" },
    { subtotal: "3899.99", tax: "780.01" },
    { total: "4680.01", tax: "780.01", amount_due: "4680.01" },
    { amount_due: "3900" },
  ])("rolls back mismatched taxable acceptance %j", async (changes) => {
    const { orderId, update } = await issuedTaxQuoteAcceptance("indeterminate");
    await expect(
      store.completeCommercialQuoteAcceptance({ ...update, ...changes }),
    ).rejects.toThrow("does not match local terms");
    const unchanged = await store.getCommercialOrder(orderId);
    expect(unchanged.quotes[0].status).toBe("issued");
    expect(unchanged.invoices[0].status).toBe("creating");
    const result = await pool.query(
      "SELECT status FROM commercial_provider_operations WHERE id=$1",
      [update.operation_id],
    );
    expect(result.rows[0].status).toBe("indeterminate");
  });

  it("attaches, downloads, and voids immutable purchase-order PDFs", async () => {
    const created = await store.createCommercialOrder(request());
    const content = Buffer.from("%PDF-1.4\nPurchase order 5874860\n%%EOF\n");
    const uploadRequest = {
      account_id: actor,
      id: created.id,
      document_kind: "purchase_order" as const,
      document_filename: "upenn-po-5874860.pdf",
      document_reference: "5874860",
      note: "Received from Penn procurement",
      content_base64: content.toString("base64"),
      expected_version: created.version,
      reason: "attach received purchase order",
      idempotency_key: `document-upload-${randomUUID()}`,
    };
    const attached = await store.uploadCommercialOrderDocument(uploadRequest);
    const replay = await store.uploadCommercialOrderDocument(uploadRequest);
    expect(replay.version).toBe(attached.version);
    expect(attached.po_number).toBe("5874860");
    expect(attached.documents).toHaveLength(1);
    expect(attached.documents[0]).toMatchObject({
      document_kind: "purchase_order",
      status: "active",
      document_reference: "5874860",
      document_filename: "upenn-po-5874860.pdf",
      document_size: content.length,
    });
    expect(attached.documents[0].document_sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      store.uploadCommercialOrderDocument({
        ...uploadRequest,
        expected_version: attached.version,
        document_reference: "DIFFERENT-PO",
        idempotency_key: `document-conflict-${randomUUID()}`,
      }),
    ).rejects.toThrow("conflicts with existing PO number 5874860");
    await expect(
      store.uploadCommercialOrderDocument({
        ...uploadRequest,
        expected_version: attached.version,
        idempotency_key: `document-duplicate-${randomUUID()}`,
      }),
    ).rejects.toThrow("already attached");

    const downloaded = await store.getCommercialOrderDocument({
      id: attached.id,
      commercial_order_document_id: attached.documents[0].id,
      reason: "verify stored purchase order",
    });
    expect(Buffer.from(downloaded.content_base64, "base64")).toEqual(content);
    expect(downloaded.document).not.toHaveProperty("document_data");

    const voided = await store.voidCommercialOrderDocument({
      account_id: actor,
      id: attached.id,
      commercial_order_document_id: attached.documents[0].id,
      expected_version: attached.version,
      reason: "replace superseded purchase order",
      idempotency_key: `document-void-${randomUUID()}`,
    });
    expect(voided.documents[0].status).toBe("void");
    expect(voided.documents[0].voided_by_account_id).toBe(actor);
    const retained = await store.getCommercialOrderDocument({
      id: voided.id,
      commercial_order_document_id: voided.documents[0].id,
      reason: "verify voided purchase order retention",
    });
    expect(retained.content_base64).toBe(downloaded.content_base64);
  });

  it("corrects billing details after fulfillment but before invoicing", async () => {
    const created = await store.createCommercialOrder(
      request({
        contacts: [
          {
            role: "primary",
            name_snapshot: "Faculty Sponsor",
            email_snapshot: "sponsor@example.edu",
          },
          {
            role: "billing",
            name_snapshot: "Original Billing",
            email_snapshot: "old-ap@example.edu",
          },
        ],
      }),
    );
    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "approve billing correction fixture",
    });
    const provisioned = await store.setCommercialFulfillment({
      account_id: actor,
      id: approved.id,
      expected_version: approved.version,
      reason: "provision before procurement correction",
      fulfillment_state: "provisioned",
    });
    const corrected = await store.updateCommercialBillingDetails({
      account_id: actor,
      id: provisioned.id,
      expected_version: provisioned.version,
      reason: "procurement supplied accounts payable contact",
      idempotency_key: `billing-correction-${randomUUID()}`,
      billing_contacts: [
        {
          role: "billing",
          name_snapshot: "Correct Accounts Payable",
          email_snapshot: "correct-ap@example.edu",
        },
      ],
      procurement_contacts: [
        {
          role: "procurement",
          name_snapshot: "Procurement Reviewer",
          email_snapshot: "procurement@example.edu",
        },
      ],
      billing_address: {
        line1: "200 Finance Way",
        city: "Example",
        state: "PA",
        postal_code: "19001",
        country: "US",
      },
    });
    expect(corrected.approved_at).toBe(approved.approved_at);
    expect(corrected.fulfillment_state).toBe("provisioned");
    expect(
      corrected.contacts.find(({ role }) => role === "primary")?.email_snapshot,
    ).toBe("sponsor@example.edu");
    expect(
      corrected.contacts.find(({ role }) => role === "billing")?.email_snapshot,
    ).toBe("correct-ap@example.edu");
    expect(corrected.terms_snapshot).toMatchObject({
      invoice: { billing_address: { line1: "200 Finance Way" } },
    });

    const invoiced = await store.issueManualCommercialInvoice({
      account_id: actor,
      id: corrected.id,
      expected_version: corrected.version,
      reason: "issue invoice to corrected recipient",
      idempotency_key: `billing-correction-invoice-${randomUUID()}`,
      invoice_reference: "FIN-CORRECTED-CONTACT",
    });
    await expect(
      store.updateCommercialBillingDetails({
        account_id: actor,
        id: invoiced.id,
        expected_version: invoiced.version,
        reason: "attempt correction after invoice",
        billing_contacts: [
          {
            role: "billing",
            name_snapshot: "Too Late",
            email_snapshot: "too-late@example.edu",
          },
        ],
      }),
    ).rejects.toThrow("billing details are locked after an invoice");
  });

  it("changes the approved collection route after fulfillment but before invoicing", async () => {
    const created = await store.createCommercialOrder(request());
    await expect(
      store.updateCommercialCollectionMode({
        account_id: actor,
        id: created.id,
        expected_version: created.version,
        reason: "attempt collection change before approval",
        collection_mode: "stripe_invoice",
      }),
    ).rejects.toThrow("must be approved");

    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "approve collection transition fixture",
    });
    const provisioned = await store.setCommercialFulfillment({
      account_id: actor,
      id: approved.id,
      expected_version: approved.version,
      reason: "provision before selecting Stripe collection",
      fulfillment_state: "provisioned",
    });
    const transitioned = await store.updateCommercialCollectionMode({
      account_id: actor,
      id: provisioned.id,
      expected_version: provisioned.version,
      reason: "collect the approved order with a hosted Stripe invoice",
      idempotency_key: `collection-mode-${randomUUID()}`,
      collection_mode: "stripe_invoice",
    });

    expect(transitioned.collection_mode).toBe("stripe_invoice");
    expect(transitioned.collection_state).toBe("not_invoiced");
    expect(transitioned.approved_at).toBe(approved.approved_at);
    expect(transitioned.fulfillment_state).toBe("provisioned");
    expect(transitioned.workflow_state).toBe("ready_to_invoice");
    const events = await store.listCommercialOrderEvents({
      id: transitioned.id,
      reason: "verify collection transition audit event",
    });
    expect(events.events[0]).toMatchObject({
      event_type: "collection-mode-updated",
      metadata: {
        previous_collection_mode: "manual_invoice",
        collection_mode: "stripe_invoice",
      },
    });
  });

  it("locks collection routing after invoice history and for complimentary orders", async () => {
    const created = await store.createCommercialOrder(request());
    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "approve invoice history fixture",
    });
    const invoiced = await store.issueManualCommercialInvoice({
      account_id: actor,
      id: approved.id,
      expected_version: approved.version,
      reason: "create invoice history before collection transition",
      invoice_reference: "LOCK-COLLECTION-MODE",
    });
    await expect(
      store.updateCommercialCollectionMode({
        account_id: actor,
        id: invoiced.id,
        expected_version: invoiced.version,
        reason: "attempt collection transition after invoicing",
        collection_mode: "stripe_invoice",
      }),
    ).rejects.toThrow("collection has started");

    const complimentary = await store.createCommercialOrder(
      request({ collection_mode: "complimentary" }),
    );
    const complimentaryApproved = await store.approveCommercialOrder({
      account_id: actor,
      id: complimentary.id,
      expected_version: complimentary.version,
      reason: "approve complimentary fixture",
    });
    await expect(
      store.updateCommercialCollectionMode({
        account_id: actor,
        id: complimentaryApproved.id,
        expected_version: complimentaryApproved.version,
        reason: "attempt to convert complimentary terms",
        collection_mode: "stripe_invoice",
      }),
    ).rejects.toThrow("only transition between");
  });

  it("fails closed when collection routing is no longer safe to change", async () => {
    const staleCreated = await store.createCommercialOrder(request());
    const staleApproved = await store.approveCommercialOrder({
      account_id: actor,
      id: staleCreated.id,
      expected_version: staleCreated.version,
      reason: "approve stale-version collection fixture",
    });
    await expect(
      store.updateCommercialCollectionMode({
        account_id: actor,
        id: staleApproved.id,
        expected_version: staleApproved.version - 1,
        reason: "attempt collection transition from stale state",
        collection_mode: "stripe_invoice",
      }),
    ).rejects.toThrow("current version");

    const paidCreated = await store.createCommercialOrder(request());
    const paidApproved = await store.approveCommercialOrder({
      account_id: actor,
      id: paidCreated.id,
      expected_version: paidCreated.version,
      reason: "approve paid collection fixture",
    });
    const paid = await store.recordManualCommercialPayment({
      account_id: actor,
      id: paidApproved.id,
      expected_version: paidApproved.version,
      reason: "record paid collection fixture",
      amount: "3900",
      currency: "usd",
      method: "wire",
      evidence_reference: `paid-collection-${randomUUID()}`,
    });
    await expect(
      store.updateCommercialCollectionMode({
        account_id: actor,
        id: paid.id,
        expected_version: paid.version,
        reason: "attempt collection transition after payment",
        collection_mode: "stripe_invoice",
      }),
    ).rejects.toThrow("collection has started");

    const terminalCreated = await store.createCommercialOrder(request());
    const terminalApproved = await store.approveCommercialOrder({
      account_id: actor,
      id: terminalCreated.id,
      expected_version: terminalCreated.version,
      reason: "approve terminal collection fixture",
    });
    const cancelled = await store.cancelCommercialOrder({
      account_id: actor,
      id: terminalApproved.id,
      expected_version: terminalApproved.version,
      reason: "cancel terminal collection fixture",
    });
    await expect(
      store.updateCommercialCollectionMode({
        account_id: actor,
        id: cancelled.id,
        expected_version: cancelled.version,
        reason: "attempt collection transition on cancelled order",
        collection_mode: "stripe_invoice",
      }),
    ).rejects.toThrow("not allowed on a cancelled order");

    const providerCreated = await store.createCommercialOrder(request());
    const providerApproved = await store.approveCommercialOrder({
      account_id: actor,
      id: providerCreated.id,
      expected_version: providerCreated.version,
      reason: "approve provider-operation collection fixture",
    });
    const reservation = await store.reserveCommercialProviderOperation({
      order_id: providerApproved.id,
      operation: "collection-mode-fixture",
      expected_version: providerApproved.version,
      idempotency_key: `collection-provider-${randomUUID()}`,
    });
    await expect(
      store.updateCommercialCollectionMode({
        account_id: actor,
        id: providerApproved.id,
        expected_version: providerApproved.version,
        reason: "attempt collection transition during provider work",
        collection_mode: "stripe_invoice",
      }),
    ).rejects.toThrow("provider operation collection-mode-fixture");
    await store.setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "failed",
    });

    const quoteCreated = await store.createCommercialOrder(request());
    const quoteIntent = await store.createCommercialStripeQuoteIntent({
      account_id: actor,
      id: quoteCreated.id,
      expected_version: quoteCreated.version,
      reason: "create active quote collection fixture",
      idempotency_key: `collection-quote-${randomUUID()}`,
      valid_until: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const quoteApproved = await store.approveCommercialOrder({
      account_id: actor,
      id: quoteCreated.id,
      expected_version: quoteIntent.order.version,
      reason: "approve active quote collection fixture",
    });
    await expect(
      store.updateCommercialCollectionMode({
        account_id: actor,
        id: quoteApproved.id,
        expected_version: quoteApproved.version,
        reason: "attempt collection transition with active quote",
        collection_mode: "stripe_invoice",
      }),
    ).rejects.toThrow("cancel it first");
  });

  it("blocks cancellation during provider work and after collection", async () => {
    const created = await store.createCommercialOrder(request());
    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "approve cancellation safety fixture",
    });
    const reservation = await store.reserveCommercialProviderOperation({
      order_id: approved.id,
      operation: "provision-site-license",
      expected_version: approved.version,
      idempotency_key: `provision-race-${randomUUID()}`,
    });
    await expect(
      store.cancelCommercialOrder({
        account_id: actor,
        id: approved.id,
        expected_version: approved.version,
        reason: "attempt cancellation during provisioning",
      }),
    ).rejects.toThrow("provider operation provision-site-license");
    await store.setCommercialProviderOperationStatus({
      id: reservation.operation.id,
      status: "failed",
    });

    const paid = await store.recordManualCommercialPayment({
      account_id: actor,
      id: approved.id,
      expected_version: approved.version,
      reason: "collect cancellation safety fixture",
      amount: "3900",
      currency: "usd",
      method: "wire",
      evidence_reference: "paid-cancellation-safety",
    });
    await expect(
      store.cancelCommercialOrder({
        account_id: actor,
        id: paid.id,
        expected_version: paid.version,
        reason: "attempt cancellation after collection",
      }),
    ).rejects.toThrow("resolve collected funds");
  });

  it("deduplicates provider payments only through explicit provider linkage", async () => {
    const created = await store.createCommercialOrder(
      request({ collection_mode: "stripe_invoice" }),
    );
    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "approve Stripe invoice terms",
    });
    const intent = await store.createCommercialInvoiceIntent({
      order_id: approved.id,
      actor_account_id: actor,
      expected_version: approved.version,
      reason: "create invoice for payment test",
      idempotency_key: `payment-intent-${randomUUID()}`,
      due_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const open = await store.updateCommercialInvoiceProvider({
      invoice_id: intent.invoice.id,
      status: "open",
      provider_customer_id: "cus_test",
      provider_invoice_id: "in_test",
      subtotal: "3900",
      tax: "0",
      total: "3900",
      amount_due: "3900",
      amount_paid: "0",
      due_at: intent.invoice.due_at,
      provider_snapshot: {},
      collection_state: "open",
      event_type: "invoice-opened-test",
      event_source: "reconciler",
      event_reason: "test provider invoice opened",
      event_idempotency_key: `provider-open-${randomUUID()}`,
    });
    const manual = await store.recordManualCommercialPayment({
      account_id: actor,
      id: open.id,
      expected_version: open.version,
      reason: "record linked out of band payment",
      amount: "1000",
      currency: "usd",
      method: "wire",
      evidence_reference: "wire-evidence-1000",
      provider_payment_id: "inpay_linked",
    });
    const reconciled = await store.updateCommercialInvoiceProvider({
      invoice_id: intent.invoice.id,
      status: "open",
      provider_customer_id: "cus_test",
      provider_invoice_id: "in_test",
      subtotal: "3900",
      tax: "0",
      total: "3900",
      amount_due: "1900",
      amount_paid: "2000",
      due_at: intent.invoice.due_at,
      provider_snapshot: {},
      provider_payments: [
        {
          id: "inpay_linked",
          amount: "1000",
          currency: "usd",
          status: "succeeded",
          received_at: new Date().toISOString(),
          method: "other",
        },
        {
          id: "inpay_distinct_same_amount",
          amount: "1000",
          currency: "usd",
          status: "succeeded",
          received_at: new Date().toISOString(),
          method: "card",
        },
      ],
      collection_state: "partially_paid",
      event_type: "invoice-payment-reconciled-test",
      event_source: "reconciler",
      event_reason: "test provider payment reconciliation",
      event_idempotency_key: `provider-payments-${randomUUID()}`,
    });
    expect(manual.payments).toHaveLength(1);
    expect(reconciled.payments).toHaveLength(2);
    expect(
      reconciled.payments.find(
        ({ provider_payment_id }) => provider_payment_id === "inpay_linked",
      ),
    ).toMatchObject({
      provider: "manual",
      method: "wire",
      evidence_reference: "wire-evidence-1000",
    });
    expect(
      reconciled.payments.some(
        ({ provider_payment_id }) =>
          provider_payment_id === "inpay_distinct_same_amount",
      ),
    ).toBe(true);
  });

  it("reconciles unchanged provider state without invalidating an operator version", async () => {
    const created = await store.createCommercialOrder(
      request({ collection_mode: "stripe_invoice" }),
    );
    const approved = await store.approveCommercialOrder({
      account_id: actor,
      id: created.id,
      expected_version: created.version,
      reason: "approve no-op reconciliation fixture",
    });
    const intent = await store.createCommercialInvoiceIntent({
      order_id: approved.id,
      actor_account_id: actor,
      expected_version: approved.version,
      reason: "create no-op reconciliation invoice",
      idempotency_key: `noop-intent-${randomUUID()}`,
      due_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const providerSnapshot = {
      id: "in_noop",
      status: "open",
      payments: [
        {
          id: "inpay_pending",
          status: "open",
          amount_requested: 390000,
        },
      ],
    };
    const opened = await store.updateCommercialInvoiceProvider({
      invoice_id: intent.invoice.id,
      status: "open",
      provider_customer_id: "cus_noop",
      provider_invoice_id: "in_noop",
      subtotal: "3900",
      tax: "0",
      total: "3900",
      amount_due: "3900",
      amount_paid: "0",
      due_at: intent.invoice.due_at,
      sent_at: "2026-08-23T00:00:00.000Z",
      hosted_invoice_url: "https://invoice.stripe.test/first-token",
      provider_snapshot: providerSnapshot,
      collection_state: "open",
      event_type: "invoice-opened-noop-test",
      event_source: "reconciler",
      event_reason: "record initial provider state",
      event_idempotency_key: `provider-noop-open-${randomUUID()}`,
    });
    const eventsBefore = await store.listCommercialOrderEvents({
      id: opened.id,
      reason: "count events before no-op reconciliation",
    });

    const reconciled = await store.updateCommercialInvoiceProvider({
      invoice_id: intent.invoice.id,
      status: "open",
      provider_customer_id: "cus_noop",
      provider_invoice_id: "in_noop",
      subtotal: "3900",
      tax: "0",
      total: "3900",
      amount_due: "3900",
      amount_paid: "0",
      due_at: intent.invoice.due_at,
      sent_at: "2026-08-23T00:00:00.000Z",
      hosted_invoice_url: "https://invoice.stripe.test/rotated-token",
      provider_snapshot: providerSnapshot,
      provider_payments: [],
      collection_state: "open",
      event_type: "invoice-reconciled-noop-test",
      event_source: "reconciler",
      event_reason: "verify unchanged provider state",
      event_idempotency_key: `provider-noop-reconcile-${randomUUID()}`,
      skip_if_unchanged: true,
    });
    const eventsAfter = await store.listCommercialOrderEvents({
      id: opened.id,
      reason: "count events after no-op reconciliation",
    });

    expect(reconciled.version).toBe(opened.version);
    expect(eventsAfter.events).toHaveLength(eventsBefore.events.length);
    expect(reconciled.invoices[0].hosted_invoice_url).toBe(
      "https://invoice.stripe.test/first-token",
    );
    const invoiceRow = (
      await pool.query(
        "SELECT reconcile_attempt_count,last_reconciled_at FROM commercial_invoices WHERE id=$1",
        [intent.invoice.id],
      )
    ).rows[0];
    expect(Number(invoiceRow.reconcile_attempt_count)).toBe(2);
    expect(invoiceRow.last_reconciled_at).toBeTruthy();
  });

  it("uses a stable event cursor tuple and enforces the event byte cap", async () => {
    const created = await store.createCommercialOrder(request());
    let current = created;
    for (let index = 0; index < 3; index++) {
      current = await store.addCommercialOrderNote({
        account_id: actor,
        id: current.id,
        expected_version: current.version,
        reason: "add pagination fixture note",
        note: `pagination note ${index}`,
      });
    }
    await pool.query(
      "UPDATE commercial_order_events SET created_at='2026-08-23T12:00:00Z' WHERE commercial_order_id=$1",
      [created.id],
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listCommercialOrderEvents({
        id: created.id,
        reason: "verify tuple event pagination",
        limit: 1,
        cursor,
      });
      seen.push(...page.events.map(({ id }) => id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);

    current = await store.addCommercialOrderNote({
      account_id: actor,
      id: current.id,
      expected_version: current.version,
      reason: "add oversized audit fixture",
      note: "x".repeat(15_000),
    });
    const capped = await store.listCommercialOrderEvents({
      id: current.id,
      reason: "verify audit response cap",
      max_bytes: 10_000,
    });
    expect(capped.truncated).toBe(true);
    expect(capped.result_bytes).toBeLessThanOrEqual(10_000);
  });

  it("updates provider status with explicit SQL types and returns actionable diagnostics", async () => {
    const created = await store.createCommercialOrder(request());
    const reserved = await store.reserveCommercialProviderOperation({
      order_id: created.id,
      operation: "diagnostic-test",
      expected_version: created.version,
      idempotency_key: `provider-operation-${randomUUID()}`,
      request: { fixture: true },
    });
    await store.setCommercialProviderOperationStatus({
      id: reserved.operation.id,
      status: "remote_started",
    });
    await store.setCommercialProviderOperationStatus({
      id: reserved.operation.id,
      status: "indeterminate",
      error: "ambiguous provider response",
    });
    await pool.query(
      `INSERT INTO commercial_stripe_events
        (event_id,event_type,livemode,commercial_order_id,status,payload,
         attempt_count,next_attempt_at,last_error,created_at,updated_at)
       VALUES ($1,'invoice.payment_failed',false,$2,'failed','{}',3,NOW(),
         'test webhook failure',NOW(),NOW())`,
      [`evt_${randomUUID()}`, created.id],
    );
    await pool.query(
      `INSERT INTO commercial_invoices
        (id,commercial_order_id,provider,provider_invoice_id,status,currency,subtotal,tax,total,
         amount_due,amount_paid,idempotency_key,provider_snapshot,
         last_reconciled_at,created_at,updated_at)
       VALUES ($1,$2,'stripe',$3,'open','usd',3900,0,3900,3900,0,$4,
         $5,NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour',NOW())`,
      [
        randomUUID(),
        created.id,
        `in_${randomUUID()}`,
        `diagnostic-invoice-${randomUUID()}`,
        {
          status: "paid",
          currency: "usd",
          subtotal: 390000,
          total: 390000,
          amount_remaining: 0,
          amount_paid: 390000,
        },
      ],
    );
    await pool.query(`CREATE TABLE IF NOT EXISTS site_licenses (
      id uuid PRIMARY KEY, metadata jsonb NOT NULL DEFAULT '{}',
      expires_at timestamptz, updated timestamptz
    )`);
    const diagnostics = await store.getCommercialOrderDiagnostics();
    expect(diagnostics.review_queues.indeterminate_provider_operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: reserved.operation.id,
          commercial_order_id: created.id,
          operation: "diagnostic-test",
          status: "indeterminate",
          attempt_count: 1,
          last_error: "ambiguous provider response",
          updated_at: expect.any(String),
        }),
      ]),
    );
    expect(diagnostics.review_queues.failed_stripe_events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commercial_order_id: created.id,
          event_type: "invoice.payment_failed",
          status: "failed",
          attempt_count: 3,
          last_error: "test webhook failure",
          next_attempt_at: expect.any(String),
        }),
      ]),
    );
    expect(
      diagnostics.reconciliation.provider_local_mismatch_count,
    ).toBeGreaterThanOrEqual(1);
    expect(
      diagnostics.reconciliation.oldest_reconciliation_lag_seconds,
    ).toBeGreaterThanOrEqual(3_500);
  });

  it("audits idempotent manual retry of a failed Stripe event", async () => {
    const created = await store.createCommercialOrder(request());
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    await pool.query(
      `INSERT INTO commercial_stripe_events
        (event_id,event_type,livemode,commercial_order_id,status,payload,
         attempt_count,next_attempt_at,last_error,processed_at,created_at,updated_at)
       VALUES ($1,'invoice.updated',false,$2,'dead_letter','{}',8,NOW(),
         'review required',NOW(),NOW(),NOW())`,
      [eventId, created.id],
    );
    const retryRequest = {
      account_id: actor,
      event_id: eventId,
      reason: "operator corrected event identity",
      source: "cli" as const,
      idempotency_key: `retry-event-${randomUUID()}`,
    };
    const first = await store.retryCommercialStripeEvent(retryRequest);
    const replay = await store.retryCommercialStripeEvent(retryRequest);
    expect(replay).toEqual(first);
    const { rows } = await pool.query(
      "SELECT status,attempt_count,last_error FROM commercial_stripe_events WHERE event_id=$1",
      [eventId],
    );
    expect(rows[0]).toMatchObject({
      status: "pending",
      attempt_count: 0,
      last_error: null,
    });
    const events = await store.listCommercialOrderEvents({
      id: created.id,
      reason: "verify Stripe retry audit",
      limit: 500,
    });
    expect(
      events.events.filter(
        ({ event_type }) => event_type === "stripe-event-retry-requested",
      ),
    ).toHaveLength(1);
  });

  it("previews and idempotently imports canonical historical site-license accounting", async () => {
    const siteLicenseId = randomUUID();
    const input = {
      account_id: actor,
      reason: "import reconciled historical site license",
      source: "cli" as const,
      idempotency_key: `historical-site-license-${randomUUID()}`,
      candidates: [
        {
          organization_name: "Historical University",
          site_license_id: siteLicenseId,
          agreed_total: "1200",
          next_action: "Create invoice" as const,
          service_starts_at: "2025-01-01T00:00:00.000Z",
          service_ends_at: "2026-01-01T00:00:00.000Z",
          billing_contact: {
            role: "billing" as const,
            name_snapshot: "Historical Accounts Payable",
            email_snapshot: "accounts-payable@historical.example",
          },
          provenance: {
            source: "legacy-site-license-spreadsheet",
            reference: "legacy-row-42",
          },
          invoice: {
            reference: "LEGACY-INV-42",
            issued_at: "2024-12-15T00:00:00.000Z",
            due_at: "2025-01-15T00:00:00.000Z",
            evidence_reference: "archived invoice LEGACY-INV-42",
          },
          payment: {
            amount: "1200",
            received_at: "2025-01-10T00:00:00.000Z",
            method: "wire" as const,
            evidence_reference: "legacy bank reconciliation row 42",
          },
        },
      ],
    };
    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM commercial_orders",
    );
    const preview = await store.backfillCommercialOrders(input);
    const afterPreview = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM commercial_orders",
    );
    expect(afterPreview.rows[0].count).toBe(before.rows[0].count);
    expect(preview).toMatchObject({
      preview: true,
      created: [],
      skipped: [],
      planned: [
        {
          index: 0,
          organization_name: "Historical University",
          site_license_id: siteLicenseId,
          provenance: {
            source: "legacy-site-license-spreadsheet",
            reference: "legacy-row-42",
          },
          actions: ["create", "approve", "issue_invoice", "record_payment"],
          ready: true,
          blockers: [],
        },
      ],
    });

    const committed = await store.backfillCommercialOrders({
      ...input,
      commit: true,
    });
    const replay = await store.backfillCommercialOrders({
      ...input,
      commit: true,
    });
    expect(committed.created).toHaveLength(1);
    expect(replay.created[0].id).toBe(committed.created[0].id);
    expect(committed.created[0]).toMatchObject({
      workflow_state: "complete",
      collection_mode: "manual_invoice",
      collection_state: "paid",
      site_license_id: siteLicenseId,
      terms_snapshot: {
        fulfillment_required: false,
        legacy_import: {
          source: "legacy-site-license-spreadsheet",
          reference: "legacy-row-42",
        },
      },
      invoices: [
        expect.objectContaining({
          provider: "manual",
          status: "paid",
          sent_at: "2024-12-15T00:00:00.000Z",
        }),
      ],
      payments: [
        expect.objectContaining({
          amount: "1200.0000000000",
          received_at: "2025-01-10T00:00:00.000Z",
          status: "succeeded",
        }),
      ],
    });
    const events = await store.listCommercialOrderEvents({
      id: committed.created[0].id,
      reason: "verify historical import audit",
    });
    expect(events.events.map(({ event_type }) => event_type).sort()).toEqual(
      [
        "manual-invoice-issued",
        "manual-payment-recorded",
        "order-approved",
        "order-created",
      ].sort(),
    );
  });

  it("reports historical backfill blockers without mutating", async () => {
    const input = {
      account_id: actor,
      reason: "preview invalid historical site license",
      source: "cli" as const,
      idempotency_key: `invalid-historical-site-license-${randomUUID()}`,
      candidates: [
        {
          organization_name: "Incomplete Historical University",
          site_license_id: randomUUID(),
          agreed_total: "500",
          next_action: "Create invoice" as const,
          provenance: { source: "legacy-sheet", reference: "row-99" },
        },
      ],
    };
    const preview = await store.backfillCommercialOrders(input);
    expect(preview.planned[0]).toMatchObject({
      ready: false,
      actions: ["create", "approve", "issue_invoice"],
      blockers: expect.arrayContaining([
        "service_starts_at and service_ends_at are required for a historical site license",
        "billing_contact is required for a historical site license",
        "invoice is required for a historical site license",
      ]),
    });
    await expect(
      store.backfillCommercialOrders({ ...input, commit: true }),
    ).rejects.toThrow("backfill candidate 0 is invalid");
  });

  it("rejects duplicate historical candidates before writing", async () => {
    const siteLicenseId = randomUUID();
    const candidate = {
      organization_name: "Duplicate Historical University",
      site_license_id: siteLicenseId,
      agreed_total: "800",
      next_action: "Create invoice" as const,
      service_starts_at: "2024-01-01T00:00:00.000Z",
      service_ends_at: "2025-01-01T00:00:00.000Z",
      billing_contact: {
        role: "billing" as const,
        name_snapshot: "Accounts Payable",
        email_snapshot: "ap@duplicate-historical.example",
      },
      provenance: { source: "legacy-sheet", reference: "duplicate-row" },
      invoice: {
        reference: "DUPLICATE-INV",
        issued_at: "2023-12-15T00:00:00.000Z",
      },
    };
    const input = {
      account_id: actor,
      reason: "reject duplicate historical import rows",
      source: "cli" as const,
      idempotency_key: `duplicate-historical-site-license-${randomUUID()}`,
      candidates: [candidate, { ...candidate }],
    };
    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM commercial_orders",
    );
    const preview = await store.backfillCommercialOrders(input);
    expect(preview.planned[0].ready).toBe(true);
    expect(preview.planned[1]).toMatchObject({
      ready: false,
      blockers: ["duplicates candidate 0 in this backfill"],
    });
    await expect(
      store.backfillCommercialOrders({ ...input, commit: true }),
    ).rejects.toThrow("backfill candidate 1 is invalid");
    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM commercial_orders",
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
