import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import type { CommercialOrder } from "@cocalc/util/commercial-orders";
import { ReceivableOrderDetail } from "./detail";

const getOrder = jest.fn();
const getEvents = jest.fn();
const approveOrder = jest.fn();
const updateOrder = jest.fn();
const reviseOrder = jest.fn();
const issueManualInvoice = jest.fn();
const recordManualPayment = jest.fn();
const voidInvoice = jest.fn();
const quotePreview = jest.fn();
const issueQuote = jest.fn();
const voidQuote = jest.fn();
const quoteDocument = jest.fn();
const uploadDocument = jest.fn();
const voidDocument = jest.fn();
const downloadDocument = jest.fn();
const updateBillingDetails = jest.fn();
const showSupportTicket = jest.fn();
const getNames = jest.fn();
const listSiteLicenseOverviews = jest.fn();
const listAssignees = jest.fn();
const userSearch = jest.fn();
const mockRunFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => <div data-testid="fresh-auth-modal" />,
  useFreshAuthAction: () => ({
    runFreshAuthAction: mockRunFreshAuthAction,
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  ErrorDisplay: ({
    error,
    title,
  }: {
    error: string | { message?: string; details?: string };
    title?: string;
  }) => (
    <div>
      <div>{title}</div>
      <div>{typeof error === "string" ? error : error.message}</div>
      {typeof error === "object" && error.details ? (
        <details>
          <summary>Technical details</summary>
          {error.details}
        </details>
      ) : null}
    </div>
  ),
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
}));

jest.mock("@cocalc/frontend/purchases/api", () => ({
  listSiteLicenseOverviews: (...args: unknown[]) =>
    listSiteLicenseOverviews(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-test-1",
    users_client: {
      getNames: (...args: unknown[]) => getNames(...args),
      user_search: (...args: unknown[]) => userSearch(...args),
    },
    conat_client: {
      hub: {
        adminSupport: {
          show: (...args: unknown[]) => showSupportTicket(...args),
        },
        commercialOrders: {
          get: (...args: unknown[]) => getOrder(...args),
          events: (...args: unknown[]) => getEvents(...args),
          approve: (...args: unknown[]) => approveOrder(...args),
          update: (...args: unknown[]) => updateOrder(...args),
          revise: (...args: unknown[]) => reviseOrder(...args),
          issueManualInvoice: (...args: unknown[]) =>
            issueManualInvoice(...args),
          recordManualPayment: (...args: unknown[]) =>
            recordManualPayment(...args),
          voidInvoice: (...args: unknown[]) => voidInvoice(...args),
          quotePreview: (...args: unknown[]) => quotePreview(...args),
          issueQuote: (...args: unknown[]) => issueQuote(...args),
          voidQuote: (...args: unknown[]) => voidQuote(...args),
          quoteDocument: (...args: unknown[]) => quoteDocument(...args),
          uploadDocument: (...args: unknown[]) => uploadDocument(...args),
          voidDocument: (...args: unknown[]) => voidDocument(...args),
          downloadDocument: (...args: unknown[]) => downloadDocument(...args),
          updateBillingDetails: (...args: unknown[]) =>
            updateBillingDetails(...args),
          listAssignees: (...args: unknown[]) => listAssignees(...args),
        },
      },
    },
  },
}));

const order: CommercialOrder = {
  id: "11111111-1111-4111-8111-111111111111",
  order_number: "AR-2026-000123",
  organization_name: "Example University",
  zendesk_ticket_ids: [20529],
  workflow_state: "draft",
  collection_mode: "stripe_invoice",
  collection_state: "open",
  fulfillment_state: "provisioned",
  currency: "usd",
  agreed_subtotal: "3900.00",
  agreed_total: "3900.00",
  terms_snapshot: { fulfillment_required: true },
  next_action: "Approve agreement",
  created_by_account_id: "22222222-2222-4222-8222-222222222222",
  created_at: "2026-08-20T12:00:00.000Z",
  updated_at: "2026-08-22T12:00:00.000Z",
  version: 7,
  items: [
    {
      id: "item-1",
      commercial_order_id: "11111111-1111-4111-8111-111111111111",
      position: 0,
      description: "Campus adoption pilot",
      quantity: "1",
      unit_amount: "3900.00",
      subtotal: "3900.00",
      product_kind: "site_license",
      metadata: {},
      created_at: "2026-08-20T12:00:00.000Z",
      updated_at: "2026-08-20T12:00:00.000Z",
    },
  ],
  contacts: [
    {
      id: "contact-1",
      commercial_order_id: "11111111-1111-4111-8111-111111111111",
      role: "billing",
      name_snapshot: "Billing Contact",
      email_snapshot: "billing@example.edu",
      created_at: "2026-08-20T12:00:00.000Z",
      updated_at: "2026-08-20T12:00:00.000Z",
    },
  ],
  quotes: [],
  documents: [],
  invoices: [
    {
      id: "invoice-1",
      commercial_order_id: "11111111-1111-4111-8111-111111111111",
      provider: "stripe",
      provider_invoice_id: "in_test_123",
      status: "open",
      currency: "usd",
      subtotal: "3900.00",
      tax: "0.00",
      total: "3900.00",
      amount_due: "3900.00",
      amount_paid: "0.00",
      hosted_invoice_url: "https://invoice.stripe.test/example",
      invoice_pdf_url: "https://invoice.stripe.test/example.pdf",
      reconcile_attempt_count: 0,
      idempotency_key: "invoice-key",
      provider_snapshot: {},
      created_at: "2026-08-21T12:00:00.000Z",
      updated_at: "2026-08-21T12:00:00.000Z",
    },
  ],
  payments: [],
};

describe("receivable order detail", () => {
  beforeAll(() => {
    const getComputedStyle = window.getComputedStyle;
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) => getComputedStyle(element));
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getOrder.mockResolvedValue(order);
    getEvents.mockResolvedValue({ events: [] });
    approveOrder.mockResolvedValue({
      ...order,
      workflow_state: "ready_to_invoice",
      version: 8,
    });
    updateOrder.mockResolvedValue({ ...order, version: 8 });
    reviseOrder.mockResolvedValue({ ...order, version: 8 });
    issueManualInvoice.mockResolvedValue({ ...order, version: 8 });
    recordManualPayment.mockResolvedValue({ ...order, version: 8 });
    voidInvoice.mockResolvedValue({ ...order, version: 8 });
    showSupportTicket.mockResolvedValue({
      ticket: {
        id: 20529,
        agent_url: "https://sagemathcloud.zendesk.com/agent/tickets/20529",
        status: "pending",
        tags: [],
        subject: "Institutional adoption pilot",
        description_preview: "",
        description: "",
        images: [],
        created_at: "2026-08-20T12:00:00.000Z",
        updated_at: "2026-08-23T12:00:00.000Z",
        project_ids: [],
        signals: { categories: ["billing"], error_signatures: [] },
      },
      comments: [],
    });
    getNames.mockResolvedValue({});
    listSiteLicenseOverviews.mockResolvedValue([]);
    listAssignees.mockResolvedValue([]);
    userSearch.mockResolvedValue([]);
  });

  it("shows independent warnings and explicit external Stripe links", async () => {
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    expect(
      await screen.findByRole("heading", { name: order.organization_name }),
    ).toBeVisible();
    expect(screen.getByText(order.order_number)).toBeVisible();
    expect(screen.getByLabelText("Commercial order summary")).toBeVisible();
    expect(
      await screen.findByText(
        "Service is provisioned, but collection is not complete",
      ),
    ).toBeVisible();
    const hosted = screen.getByRole("link", {
      name: /Open Stripe hosted invoice \(external\)/,
    });
    expect(hosted).toHaveAttribute("target", "_blank");
    expect(hosted).toHaveAttribute("rel", "noopener noreferrer");
    expect(
      screen.getByRole("link", {
        name: /Open Stripe invoice PDF \(external\)/,
      }),
    ).toHaveAttribute("target", "_blank");
  });

  it("offers a reviewed purchase-order attachment workflow", async () => {
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    expect(
      await screen.findByText("No purchase orders are attached"),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: /Attach purchase order/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Attach purchase order",
    });
    expect(
      within(dialog).getByText(
        "This becomes part of the commercial audit record",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("checkbox", {
        name: /I reviewed the PDF, purchase-order reference, and AR record/,
      }),
    ).not.toBeChecked();
    expect(
      within(dialog).getByRole("button", {
        name: "Attach PDF (fresh authentication required)",
      }),
    ).toBeInTheDocument();
  });

  it("fresh-authenticates approval with the displayed order version", async () => {
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Approve order" }),
    );
    const reason = await screen.findByLabelText("Audit reason");
    await waitFor(() => expect(reason).toHaveFocus());
    fireEvent.change(reason, {
      target: { value: "Reviewed billing contact and line items" },
    });
    const approveButtons = screen.getAllByRole("button", {
      name: "Approve order",
    });
    fireEvent.click(approveButtons.at(-1)!);

    await waitFor(() => expect(approveOrder).toHaveBeenCalledTimes(1));
    expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1);
    expect(approveOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        id: order.id,
        browser_id: "browser-test-1",
        expected_version: 7,
        source: "admin-ui",
        reason: "Reviewed billing contact and line items",
        idempotency_key: `admin-ui:approve:${order.id}:v7`,
      }),
    );
  });

  it("clears a stale mutation error when the order is refreshed", async () => {
    approveOrder.mockRejectedValueOnce(
      Error(
        "commercial order changed: expected version 7, current version is 8",
      ),
    );
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Approve order" }),
    );
    fireEvent.change(await screen.findByLabelText("Audit reason"), {
      target: { value: "Reviewed before another operator changed the order" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: "Approve order" }).at(-1)!,
    );

    expect(
      await screen.findByText("Commercial order action failed"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Refresh order/ }));

    await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText("Commercial order action failed"),
    ).not.toBeInTheDocument();
  });

  it("renders account names for assignees and audit actors", async () => {
    const accountId = "8a52c640-079f-496d-85cb-0147bdf9fd6d";
    getOrder.mockResolvedValue({
      ...order,
      assignee_account_id: accountId,
    });
    getEvents.mockResolvedValue({
      events: [
        {
          id: "event-1",
          commercial_order_id: order.id,
          actor_account_id: accountId,
          event_type: "note_added",
          source: "admin-ui",
          reason: "Reviewed the customer reply",
          metadata: {},
          created_at: "2026-08-23T12:00:00.000Z",
        },
      ],
    });
    getNames.mockResolvedValue({
      [accountId]: {
        display_name: "William Stein",
        first_name: "William",
        last_name: "Stein",
      },
    });

    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    await waitFor(() => {
      const identities = screen.getAllByTitle(accountId);
      expect(identities).toHaveLength(3);
      expect(
        identities.every(
          (identity) => identity.textContent === "William Stein",
        ),
      ).toBe(true);
    });
    expect(getNames).toHaveBeenCalledWith([accountId]);
  });

  it("renders a linked site license as a business record", async () => {
    const siteLicenseId = "949eaca7-9c10-429d-9157-567a20f9b7d1";
    getOrder.mockResolvedValue({ ...order, site_license_id: siteLicenseId });
    listSiteLicenseOverviews.mockResolvedValue([
      {
        site_license: {
          id: siteLicenseId,
          name: "Example University adoption pilot",
          organization_name: "Example University",
          bay_id: "seed",
          allowed_domains: ["example.edu"],
          starts_at: new Date("2026-08-23T00:00:00.000Z"),
          expires_at: new Date("2027-06-30T23:59:59.000Z"),
        },
        pools: [{ seat_count: 5000 }],
        managers: [],
        pending_requests: [],
      },
    ]);

    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    expect(
      await screen.findByText("Example University adoption pilot"),
    ).toBeVisible();
    expect(screen.getByText("5000 seats across 1 pool")).toBeVisible();
    expect(listSiteLicenseOverviews).toHaveBeenCalledWith({ admin: true });
  });

  it("updates an unapproved draft through a reviewed fresh-authenticated action", async () => {
    getOrder.mockResolvedValue({ ...order, invoices: [] });
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    expect(
      await screen.findByRole("button", { name: "Update draft" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Revise reviewed agreement" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update draft" }));

    const title = document.getElementById(`receivables-edit-title-${order.id}`);
    await waitFor(() => expect(title).toHaveFocus());
    const dialog = title?.closest('[role="dialog"]');
    expect(dialog).not.toBeNull();
    fireEvent.change(within(dialog!).getByLabelText("Audit reason"), {
      target: { value: "Updated the customer draft before approval" },
    });
    fireEvent.click(
      within(dialog!).getByRole("button", { name: "Review draft update" }),
    );
    fireEvent.click(
      await within(dialog!).findByRole("button", {
        name: "Apply draft update (fresh authentication required)",
      }),
    );

    await waitFor(() => expect(updateOrder).toHaveBeenCalledTimes(1));
    expect(reviseOrder).not.toHaveBeenCalled();
    expect(updateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        id: order.id,
        expected_version: 7,
        source: "admin-ui",
        reason: "Updated the customer draft before approval",
        changes: expect.objectContaining({
          organization_name: "Example University",
        }),
      }),
    );
  });

  it("loads bounded Zendesk metadata without blocking order detail", async () => {
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    expect(
      await screen.findByRole("heading", {
        name: order.organization_name,
      }),
    ).toBeVisible();
    expect(
      await screen.findByText("Institutional adoption pilot"),
    ).toBeVisible();
    expect(screen.getByText("Pending")).toBeVisible();
    expect(showSupportTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        ticket_id: 20529,
        max_comments: 1,
        max_bytes: 64_000,
      }),
    );
  });

  it("hides duplicate approval and locks the site-license target after approval", async () => {
    getOrder.mockResolvedValue({
      ...order,
      workflow_state: "ready_to_invoice",
      approved_at: "2026-08-23T12:00:00.000Z",
      approved_by_account_id: "22222222-2222-4222-8222-222222222222",
      site_license_id: "33333333-3333-4333-8333-333333333333",
      invoices: [],
    });

    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    await screen.findByText("Ready to invoice");
    expect(
      screen.queryByRole("button", { name: "Approve order" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Revise reviewed agreement" }),
    );
    const title = document.getElementById(`receivables-edit-title-${order.id}`);
    await waitFor(() => expect(title).toHaveFocus());
    const dialog = title?.closest('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(
      within(dialog!).getByText("Reviewed site license target"),
    ).toBeInTheDocument();
    expect(
      within(dialog!).queryByRole("textbox", {
        name: "Existing site license ID",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog!).getByText("33333333-3333-4333-8333-333333333333"),
    ).toBeInTheDocument();
  });

  it("reviews and confirms a manual invoice before invoking the gated API", async () => {
    const manualOrder = {
      ...order,
      workflow_state: "ready_to_invoice" as const,
      collection_mode: "manual_invoice" as const,
      approved_at: "2026-08-23T12:00:00.000Z",
      approved_by_account_id: "22222222-2222-4222-8222-222222222222",
      invoices: [],
    };
    getOrder.mockResolvedValue(manualOrder);
    issueManualInvoice.mockResolvedValue({ ...manualOrder, version: 8 });
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Issue manual invoice" }),
    );
    fireEvent.change(screen.getByLabelText("Invoice reference"), {
      target: { value: "FIN-2026-0042" },
    });
    fireEvent.change(screen.getByLabelText("Due at"), {
      target: { value: "2026-09-15T12:00" },
    });
    fireEvent.change(screen.getByLabelText("Document URL"), {
      target: { value: "https://billing.example.edu/invoices/42" },
    });
    fireEvent.change(screen.getByLabelText("Evidence reference"), {
      target: { value: "ERP record 42" },
    });
    fireEvent.change(screen.getByLabelText("Audit reason"), {
      target: { value: "Reviewed external invoice in the ERP" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review manual invoice" }),
    );

    const reviewTitle = await screen.findByRole("heading", {
      name: "Review manual invoice record",
    });
    await waitFor(() => expect(reviewTitle).toHaveFocus());
    expect(issueManualInvoice).not.toHaveBeenCalled();
    const submit = screen.getByRole("button", {
      name: "Issue reviewed invoice (fresh authentication required)",
    });
    expect(submit).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I reviewed the manual invoice reference/,
      }),
    );
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(issueManualInvoice).toHaveBeenCalledTimes(1));
    expect(issueManualInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        id: order.id,
        invoice_reference: "FIN-2026-0042",
        due_at: new Date("2026-09-15T12:00").toISOString(),
        document_url: "https://billing.example.edu/invoices/42",
        evidence_reference: "ERP record 42",
        expected_version: 7,
      }),
    );
  });

  it("requires a second reviewed confirmation before manual settlement", async () => {
    getOrder.mockResolvedValue({ ...order, invoices: [] });
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Record manual payment" }),
    );
    fireEvent.change(screen.getByLabelText("Evidence reference"), {
      target: { value: "Wire confirmation ABC123" },
    });
    fireEvent.change(screen.getByLabelText("Audit reason"), {
      target: { value: "Verified funds in the bank account" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review payment" }));

    const reviewTitle = await screen.findByRole("heading", {
      name: "Review verified payment",
    });
    await waitFor(() => expect(reviewTitle).toHaveFocus());
    expect(recordManualPayment).not.toHaveBeenCalled();
    const submit = screen.getByRole("button", {
      name: "Record reviewed payment (fresh authentication required)",
    });
    expect(submit).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I verified the funds were received/,
      }),
    );
    fireEvent.click(submit);

    await waitFor(() => expect(recordManualPayment).toHaveBeenCalledTimes(1));
    expect(recordManualPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        id: order.id,
        amount: "3900.00",
        currency: "usd",
        evidence_reference: "Wire confirmation ABC123",
        expected_version: 7,
      }),
    );
  });

  it("shows a friendly payment rejection inside the active modal", async () => {
    recordManualPayment.mockRejectedValueOnce(
      Error(
        "an out-of-band Stripe invoice settlement must equal the remaining balance 0.0000000000 - callHub: subject='hub.account.test.api'",
      ),
    );
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Record manual payment" }),
    );
    fireEvent.change(screen.getByLabelText("Evidence reference"), {
      target: { value: "Wire confirmation ABC123" },
    });
    fireEvent.change(screen.getByLabelText("Audit reason"), {
      target: { value: "Verified funds in the bank account" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review payment" }));
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: /I verified the funds were received/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Record reviewed payment (fresh authentication required)",
      }),
    );

    const paymentDialog = await screen.findByRole("dialog", {
      name: "Record manual payment",
    });
    await waitFor(() => expect(paymentDialog).toBeVisible());
    expect(
      await within(paymentDialog).findByText(
        "This Stripe invoice is already fully paid, so no additional manual payment can be recorded.",
      ),
    ).toBeVisible();
    expect(within(paymentDialog).getByText("Technical details")).toBeVisible();
  });

  it("uses provider-appropriate invoice controls and blocks Stripe actions in manual mode", async () => {
    const manualInvoice = {
      ...order.invoices[0],
      provider: "manual" as const,
      provider_invoice_id: null,
      hosted_invoice_url: "https://billing.example.edu/invoices/42",
      invoice_pdf_url: null,
      provider_snapshot: { invoice_reference: "FIN-2026-0042" },
    };
    getOrder.mockResolvedValue({
      ...order,
      collection_mode: "manual_invoice",
      approved_at: "2026-08-23T12:00:00.000Z",
      approved_by_account_id: "22222222-2222-4222-8222-222222222222",
      invoices: [manualInvoice],
    });
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    expect(
      await screen.findByRole("link", {
        name: /Open manual invoice document \(external\)/,
      }),
    ).toBeVisible();
    expect(screen.getByText("FIN-2026-0042")).toBeVisible();
    expect(
      screen.queryByText("Stripe hosted page not available"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Preview Stripe invoice" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Link existing Stripe invoice" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Void invoice" }));
    const voidDialog = await screen.findByRole("dialog", {
      name: "Void manual invoice record",
    });
    expect(voidDialog).toBeInTheDocument();
    fireEvent.change(within(voidDialog).getByLabelText("Audit reason"), {
      target: { value: "Replaced by corrected external invoice" },
    });
    fireEvent.click(
      within(voidDialog).getByRole("button", { name: "Void invoice" }),
    );
    await waitFor(() => expect(voidInvoice).toHaveBeenCalledTimes(1));
  });

  it("corrects billing details after fulfillment with fresh authentication", async () => {
    const fulfilled = {
      ...order,
      invoices: [],
      approved_at: "2026-08-23T12:00:00.000Z",
      approved_by_account_id: "22222222-2222-4222-8222-222222222222",
    };
    getOrder.mockResolvedValue(fulfilled);
    updateBillingDetails.mockResolvedValue({ ...fulfilled, version: 8 });
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    const correctionButtons = await screen.findAllByRole("button", {
      name: "Correct billing details",
    });
    fireEvent.click(correctionButtons.at(-1)!);
    const dialog = await screen.findByRole("dialog", {
      name: "Correct billing details",
    });
    fireEvent.change(within(dialog).getByLabelText("Billing contact name"), {
      target: { value: "Correct Accounts Payable" },
    });
    fireEvent.change(within(dialog).getByLabelText("Billing contact email"), {
      target: { value: "correct-ap@example.edu" },
    });
    fireEvent.change(within(dialog).getByLabelText("Audit reason"), {
      target: { value: "Procurement supplied the final billing contact" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Save billing details (fresh authentication required)",
      }),
    );

    await waitFor(() => expect(updateBillingDetails).toHaveBeenCalledTimes(1));
    expect(updateBillingDetails).toHaveBeenCalledWith(
      expect.objectContaining({
        id: order.id,
        expected_version: 7,
        billing_contacts: [
          expect.objectContaining({
            role: "billing",
            name_snapshot: "Correct Accounts Payable",
            email_snapshot: "correct-ap@example.edu",
          }),
        ],
      }),
    );
  });

  it("previews and issues an immutable quote with fresh authentication", async () => {
    const quotable = { ...order, invoices: [] };
    const preview = {
      order_id: order.id,
      order_number: order.order_number,
      organization_name: order.organization_name,
      billing_contacts: order.contacts,
      items: order.items,
      currency: "usd",
      subtotal: "3900.00",
      total: "3900.00",
      default_valid_until: "2026-09-30T12:00:00.000Z",
      ready: true,
      blockers: [],
    };
    getOrder.mockResolvedValue(quotable);
    quotePreview.mockResolvedValue(preview);
    issueQuote.mockResolvedValue({ ...quotable, version: 8 });
    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: /Generate quote/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Review and issue quote",
    });
    expect(
      within(dialog).getByText("Quote is ready to issue"),
    ).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Audit reason"), {
      target: { value: "Send formal quote to procurement" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Issue and store quote (fresh authentication required)",
      }),
    );

    await waitFor(() => expect(issueQuote).toHaveBeenCalledTimes(1));
    expect(issueQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: order.id,
        expected_version: 7,
        valid_until: "2026-09-30T12:00:00.000Z",
      }),
    );
  });

  it("removes financial and fulfillment actions from terminal orders", async () => {
    getOrder.mockResolvedValue({
      ...order,
      workflow_state: "complete",
      approved_at: "2026-08-22T12:00:00.000Z",
      completed_at: "2026-08-23T12:00:00.000Z",
    });

    render(<ReceivableOrderDetail id={order.id} onBack={jest.fn()} />);

    expect(await screen.findByText("Terminal order")).toBeVisible();
    for (const name of [
      "Approve order",
      "Cancel order",
      "Revise reviewed agreement",
      "Update draft",
      "Record manual payment",
      "Issue manual invoice",
      "Preview site license fulfillment",
      "End fulfillment",
      "Link existing Stripe invoice",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
