import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type {
  CommercialOrder,
  CommercialQuote,
} from "@cocalc/util/commercial-orders";
import { CommercialQuotesCard } from "./quotes";

const quotePreview = jest.fn();
const getSiteSettings = jest.fn();
const issueQuote = jest.fn();
const quoteDocument = jest.fn();
const voidQuote = jest.fn();
const stripeQuotePreview = jest.fn();
const createStripeQuote = jest.fn();
const finalizeStripeQuote = jest.fn();
const acceptStripeQuote = jest.fn();
const cancelStripeQuote = jest.fn();
const reconcileStripeQuote = jest.fn();
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
  ErrorDisplay: ({ error, title }: { error: string; title?: string }) => (
    <div role="alert">
      <div>{title}</div>
      <div>{error}</div>
    </div>
  ),
  Icon: ({ name }: { name: string }) => <span aria-hidden="true">{name}</span>,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-test-1",
    conat_client: {
      hub: {
        system: {
          getSiteSettings: (...args: unknown[]) => getSiteSettings(...args),
        },
        commercialOrders: {
          quotePreview: (...args: unknown[]) => quotePreview(...args),
          issueQuote: (...args: unknown[]) => issueQuote(...args),
          quoteDocument: (...args: unknown[]) => quoteDocument(...args),
          voidQuote: (...args: unknown[]) => voidQuote(...args),
          stripeQuotePreview: (...args: unknown[]) =>
            stripeQuotePreview(...args),
          createStripeQuote: (...args: unknown[]) => createStripeQuote(...args),
          finalizeStripeQuote: (...args: unknown[]) =>
            finalizeStripeQuote(...args),
          acceptStripeQuote: (...args: unknown[]) => acceptStripeQuote(...args),
          cancelStripeQuote: (...args: unknown[]) => cancelStripeQuote(...args),
          reconcileStripeQuote: (...args: unknown[]) =>
            reconcileStripeQuote(...args),
        },
      },
    },
  },
}));

const order = {
  id: "11111111-1111-4111-8111-111111111111",
  order_number: "AR-2026-000123",
  organization_name: "Example University",
  zendesk_ticket_ids: [],
  workflow_state: "draft",
  collection_mode: "stripe_invoice",
  collection_state: "not_invoiced",
  fulfillment_state: "not_provisioned",
  currency: "usd",
  agreed_subtotal: "3900.00",
  agreed_total: "3900.00",
  terms_snapshot: { fulfillment_required: true },
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
  invoices: [],
  payments: [],
} as CommercialOrder;

const localPreview = {
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

const stripePreview = {
  ...localPreview,
  stripe_mode: "test",
  stripe_customer_id: "cus_test_123",
  collection_method: "send_invoice",
  payment_terms_days: 30,
  description: "Example University adoption pilot",
  header: "CoCalc Commercial Quote",
  footer: "",
  metadata: { flow: "commercial_quote" },
  products: [
    {
      commercial_order_item_id: "item-1",
      product_kind: "site_license",
      quantity: 1,
      unit_amount: 390000,
    },
  ],
  ready: true,
};

function stripeQuote(changes: Partial<CommercialQuote> = {}): CommercialQuote {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    commercial_order_id: order.id,
    quote_number: "Q-2026-000001",
    status: "issued",
    provider: "stripe",
    provider_quote_id: "qt_test_123",
    provider_status: "open",
    currency: "usd",
    subtotal: "3900.00",
    total: "3900.00",
    issued_at: "2026-08-25T12:00:00.000Z",
    valid_until: "2027-09-30T12:00:00.000Z",
    document_filename: "QT-0001.pdf",
    document_mime_type: "application/pdf",
    document_sha256: "abc123",
    document_size: 1024,
    snapshot: {},
    provider_snapshot: { livemode: false },
    created_by_account_id: "22222222-2222-4222-8222-222222222222",
    idempotency_key: "quote-key",
    created_at: "2026-08-24T12:00:00.000Z",
    updated_at: "2026-08-25T12:00:00.000Z",
    ...changes,
  };
}

describe("commercial quote card", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSiteSettings.mockResolvedValue({ settings: [] });
    quotePreview.mockResolvedValue(localPreview);
    stripeQuotePreview.mockResolvedValue(stripePreview);
    issueQuote.mockResolvedValue({ ...order, version: 8 });
    createStripeQuote.mockResolvedValue({ ...order, version: 8 });
    finalizeStripeQuote.mockResolvedValue({ ...order, version: 8 });
    acceptStripeQuote.mockResolvedValue({ ...order, version: 8 });
    cancelStripeQuote.mockResolvedValue({ ...order, version: 8 });
    reconcileStripeQuote.mockResolvedValue({ ...order, version: 8 });
  });

  it("preserves local PDF issuance when Stripe quotes are disabled", async () => {
    const onOrderChanged = jest.fn();
    render(
      <CommercialQuotesCard order={order} onOrderChanged={onOrderChanged} />,
    );

    expect(screen.getByRole("radio", { name: "Local PDF" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Generate quote" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Review and issue quote",
    });
    fireEvent.change(within(dialog).getByLabelText("Audit reason"), {
      target: { value: "Send reviewed local quote" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Issue and store quote (fresh authentication required)",
      }),
    );

    await waitFor(() => expect(issueQuote).toHaveBeenCalledTimes(1));
    expect(stripeQuotePreview).not.toHaveBeenCalled();
    expect(onOrderChanged).toHaveBeenCalled();
  });

  it("defaults to Stripe when quote drafts are enabled", async () => {
    const user = userEvent.setup();
    getSiteSettings.mockResolvedValue({
      settings: [
        { name: "commercial_receivables_stripe_quotes_enabled", value: true },
      ],
    });
    render(<CommercialQuotesCard order={order} onOrderChanged={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Stripe" })).toBeChecked(),
    );
    screen.getByRole("radio", { name: "Stripe" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Local PDF" })).toBeChecked();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Stripe" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Stripe" })).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "Create Stripe quote" }),
    );
    await screen.findByRole("dialog", { name: "Review Stripe quote draft" });
    expect(stripeQuotePreview).toHaveBeenCalledTimes(1);
    expect(quotePreview).not.toHaveBeenCalled();
  });

  it("does not overwrite a manual Local PDF selection when settings arrive late", async () => {
    let resolve!: (value: any) => void;
    getSiteSettings.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<CommercialQuotesCard order={order} onOrderChanged={jest.fn()} />);
    fireEvent.click(screen.getByRole("radio", { name: "Stripe" }));
    fireEvent.click(screen.getByRole("radio", { name: "Local PDF" }));
    await act(async () =>
      resolve({
        settings: [
          { name: "commercial_receivables_stripe_quotes_enabled", value: true },
        ],
      }),
    );
    await waitFor(() => expect(getSiteSettings).toHaveBeenCalled());
    expect(screen.getByRole("radio", { name: "Local PDF" })).toBeChecked();
  });

  it("previews and creates a Stripe draft without finalizing it", async () => {
    const onOrderChanged = jest.fn();
    render(
      <CommercialQuotesCard order={order} onOrderChanged={onOrderChanged} />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Stripe" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Create Stripe quote" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Review Stripe quote draft",
    });
    expect(
      within(dialog).getByText(/does not finalize or email the quote/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("cus_test_123")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Audit reason"), {
      target: { value: "Create reviewed Stripe quote draft" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Create Stripe draft (fresh authentication required)",
      }),
    );

    await waitFor(() => expect(createStripeQuote).toHaveBeenCalledTimes(1));
    expect(createStripeQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: order.id,
        expected_version: 7,
        valid_until: "2026-09-30T12:00:00.000Z",
      }),
    );
    expect(finalizeStripeQuote).not.toHaveBeenCalled();
    expect(onOrderChanged).toHaveBeenCalled();
  });

  it("requires explicit customer acceptance before accepting a Stripe quote", async () => {
    const quote = stripeQuote();
    const onOrderChanged = jest.fn();
    render(
      <CommercialQuotesCard
        order={{
          ...order,
          approved_at: "2026-08-25T10:00:00.000Z",
          approved_by_account_id: "22222222-2222-4222-8222-222222222222",
          quotes: [quote],
        }}
        onOrderChanged={onOrderChanged}
      />,
    );

    expect(screen.getByText("Local: Issued")).toBeVisible();
    expect(screen.getByText("Stripe: Open")).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: `Stripe Dashboard for ${quote.quote_number}`,
      }),
    ).toHaveAttribute(
      "href",
      "https://dashboard.stripe.com/test/quotes/qt_test_123",
    );
    expect(
      screen.getByRole("button", { name: `Cancel ${quote.quote_number}` }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: `Reconcile ${quote.quote_number}` }),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: `Accept ${quote.quote_number}` }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: `Confirm customer acceptance of ${quote.quote_number}`,
    });
    const submit = within(dialog).getByRole("button", {
      name: "Accept quote (fresh authentication required)",
    });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Audit reason"), {
      target: { value: "Customer accepted the exact final quote" },
    });
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: /I confirm that the customer explicitly accepted/i,
      }),
    );
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() => expect(acceptStripeQuote).toHaveBeenCalledTimes(1));
    expect(acceptStripeQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: order.id,
        commercial_quote_id: quote.id,
        customer_acceptance_confirmed: true,
        expected_version: 7,
      }),
    );
    expect(onOrderChanged).toHaveBeenCalled();
  });

  it("does not offer quote acceptance before order approval", () => {
    const quote = stripeQuote();
    render(
      <CommercialQuotesCard
        order={{ ...order, quotes: [quote] }}
        onOrderChanged={jest.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: `Accept ${quote.quote_number}` }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Approve the commercial order before accepting this quote.",
      ),
    ).toBeVisible();
  });

  it("finalizes a Stripe draft through fresh authentication", async () => {
    const quote = stripeQuote({
      status: "draft",
      provider_status: "draft",
      issued_at: null,
      document_filename: null,
      document_mime_type: null,
      document_sha256: null,
      document_size: null,
    });
    render(
      <CommercialQuotesCard
        order={{ ...order, quotes: [quote] }}
        onOrderChanged={jest.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: `Finalize ${quote.quote_number}` }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: `Finalize ${quote.quote_number}`,
    });
    fireEvent.change(within(dialog).getByLabelText("Audit reason"), {
      target: { value: "Finalize reviewed Stripe quote" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Finalize quote (fresh authentication required)",
      }),
    );

    await waitFor(() => expect(finalizeStripeQuote).toHaveBeenCalledTimes(1));
    expect(mockRunFreshAuthAction).toHaveBeenCalled();
  });
});
