import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { message } from "antd";

import { CustomerOutreachCard, OutreachAdmin } from "./outreach";

// rc-util's constant test ID makes the modal title collide with queue controls.
jest.mock("@rc-component/util/lib/hooks/useId", () => ({
  __esModule: true,
  ...jest.requireActual("@rc-component/util/lib/hooks/useId"),
  default: () => jest.requireActual("react").useId(),
}));

const api = {
  listOutreachDeliveries: jest.fn(),
  listOutreachBatches: jest.fn(),
  listOutreachTemplates: jest.fn(),
  listContactSuppressions: jest.fn(),
  listOutreachFollowups: jest.fn(),
  getOutreachLimits: jest.fn(),
  getOutreachDiagnostics: jest.fn(),
  getOutreachBatch: jest.fn(),
  previewOutreachBatch: jest.fn(),
  listOutreachProviderOperations: jest.fn(),
  listOutreachEngagementEvents: jest.fn(),
  getOrganization: jest.fn(),
  getCustomerTimeline: jest.fn(),
  createOutreachBatch: jest.fn(),
  updateOutreachRecipient: jest.fn(),
  removeOutreachRecipient: jest.fn(),
};
const runFreshAuthAction = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => <div data-testid="fresh-auth-modal" />,
  useFreshAuthAction: () => ({
    runFreshAuthAction,
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/components", () => ({
  ErrorDisplay: ({ error, onClose }: any) => (
    <div role="alert">
      {`${error}`}
      <button onClick={onClose}>Dismiss error</button>
    </div>
  ),
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
  TimeAgo: ({ date }: { date: string }) => <span>{date}</span>,
  Tooltip: ({ children }: any) => children,
}));

jest.mock("../receivables/account-selector", () => ({
  AccountSelector: ({
    value,
    onChange,
    accountKind: _accountKind,
    ariaLabel,
    ...props
  }: any) => (
    <input
      {...props}
      aria-label={ariaLabel}
      onChange={(event) => onChange?.(event.target.value)}
      value={value ?? ""}
    />
  ),
}));

jest.mock("../receivables/account-names", () => ({
  AccountIdentity: ({ accountId, names }: any) => (
    <span>{names[accountId] ?? "Unknown account"}</span>
  ),
  useAccountDisplayNames: () => ({
    "account-1": "Morgan Admin",
    "owner-account": "Morgan Admin",
  }),
}));

jest.mock("./selector", () => ({
  CustomerSelector: (props: any) => <input {...props} />,
  OpportunitySelector: (props: any) => <input {...props} />,
  PersonSelector: (props: any) => <input {...props} />,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-test",
    conat_client: {
      hub: {
        adminCrm: {
          listOutreachDeliveries: (...args: unknown[]) =>
            api.listOutreachDeliveries(...args),
          listOutreachBatches: (...args: unknown[]) =>
            api.listOutreachBatches(...args),
          listOutreachTemplates: (...args: unknown[]) =>
            api.listOutreachTemplates(...args),
          listContactSuppressions: (...args: unknown[]) =>
            api.listContactSuppressions(...args),
          listOutreachFollowups: (...args: unknown[]) =>
            api.listOutreachFollowups(...args),
          getOutreachLimits: (...args: unknown[]) =>
            api.getOutreachLimits(...args),
          getOutreachDiagnostics: (...args: unknown[]) =>
            api.getOutreachDiagnostics(...args),
          getOutreachBatch: (...args: unknown[]) =>
            api.getOutreachBatch(...args),
          previewOutreachBatch: (...args: unknown[]) =>
            api.previewOutreachBatch(...args),
          listOutreachProviderOperations: (...args: unknown[]) =>
            api.listOutreachProviderOperations(...args),
          listOutreachEngagementEvents: (...args: unknown[]) =>
            api.listOutreachEngagementEvents(...args),
          getOrganization: (...args: unknown[]) => api.getOrganization(...args),
          getCustomerTimeline: (...args: unknown[]) =>
            api.getCustomerTimeline(...args),
          createOutreachBatch: (...args: unknown[]) =>
            api.createOutreachBatch(...args),
          updateOutreachRecipient: (...args: unknown[]) =>
            api.updateOutreachRecipient(...args),
          removeOutreachRecipient: (...args: unknown[]) =>
            api.removeOutreachRecipient(...args),
        },
        adminSupport: { show: jest.fn() },
      },
    },
  },
}));

const limits = {
  enabled: true,
  mutations_enabled: true,
  delivery_enabled: false,
  webhook_enabled: false,
  max_recipients_per_batch: 25,
  send_per_minute: 5,
  send_per_hour: 50,
  send_per_day: 200,
  send_per_domain_per_day: 20,
  contact_cooldown_days: 90,
  default_followup_days: 7,
  default_max_followups: 2,
  default_final_review_days: 14,
  worker_concurrency: 1,
  worker_batch_size: 5,
  retry_max_attempts: 5,
  retry_base_seconds: 30,
  rolling_usage: { minute: 0, hour: 0, day: 0, by_domain: {} },
  hard_bounds: {},
};

const diagnostics = {
  checked_at: "2026-08-26T10:00:00.000Z",
  configured: {
    submitter_id: true,
    group_id: true,
    form_id: true,
    support_address: true,
    postal_address: true,
    footer: true,
    webhook_secret: true,
    read_receipts_mode: "private_comments",
    read_receipts_identity: true,
  },
  limits,
  counts: {},
  problems: [],
};

const delivery = {
  id: "delivery-id",
  batch_id: "batch-id",
  organization_id: "organization-id",
  person_id: "person-id",
  person_email_id: "person-email-id",
  opportunity_id: "opportunity-id",
  task_id: "task-id",
  kind: "adoption_pilot",
  recipient_name: "Ada Prospect",
  normalized_email: "ada@example.edu",
  recipient_domain: "example.edu",
  subject: "A reviewed adoption pilot",
  body_plain_text: "Hello Ada",
  body_markdown: "Hello Ada",
  rendered_html: "<p>Hello Ada</p>",
  footer: "CoCalc",
  template_snapshot: {},
  state: "notification_requested",
  provider_external_id: "outreach-delivery-id",
  zendesk_ticket_id: 20620,
  opening_zendesk_comment_id: 1,
  last_zendesk_comment_id: 1,
  last_zendesk_status: "open",
  zendesk_sync_metadata: {},
  view_observation_count: 0,
  follow_up_policy: "no_response",
  follow_up_after_days: 7,
  max_followups: 2,
  final_review_after_days: 14,
  notification_requested_at: "2026-08-20T10:00:00.000Z",
  follow_up_due_at: "2026-08-27T10:00:00.000Z",
  follow_up_attempt_count: 0,
  follow_up_suggested_action: "review_and_follow_up",
  next_attempt_at: "2026-08-20T10:00:00.000Z",
  attempt_count: 1,
  opt_out_token_digest: "digest",
  created_by_account_id: "account-1",
  updated_by_account_id: "account-1",
  created_at: "2026-08-20T10:00:00.000Z",
  updated_at: "2026-08-20T10:05:00.000Z",
  version: 3,
};

const customer = {
  organization: {
    id: "organization-id",
    customer_number: "CRM-TEST",
    display_name: "Example University",
    aliases: [],
    organization_type: "university",
    lifecycle_stage: "prospect",
    status: "active",
    created_by_account_id: "account-1",
    updated_by_account_id: "account-1",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    version: 1,
  },
  domains: [],
  people: [
    {
      id: "person-id",
      display_name: "Ada Prospect",
      status: "active",
      created_by_account_id: "account-1",
      updated_by_account_id: "account-1",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
      version: 1,
      emails: [],
      accounts: [],
      organizations: [],
    },
  ],
  relationships: [],
  opportunities: [
    {
      id: "opportunity-id",
      organization_id: "organization-id",
      name: "Fall adoption pilot",
      kind: "adoption_pilot",
      stage: "qualified",
      owner_account_id: "owner-account",
      expected_value: "2500",
      currency: "usd",
      expected_close_date: "2026-09-01",
      source_zendesk_ticket_ids: [],
      created_by_account_id: "account-1",
      updated_by_account_id: "account-1",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
      version: 1,
    },
  ],
  tasks: [
    {
      id: "task-id",
      organization_id: "organization-id",
      person_id: "person-id",
      opportunity_id: "opportunity-id",
      type: "contact",
      state: "open",
      assignee_account_id: "owner-account",
      due_at: "2026-08-27T10:00:00.000Z",
      priority: "high",
      subject: "Follow up with Ada",
      created_by_account_id: "account-1",
      updated_by_account_id: "account-1",
      created_at: "2026-08-20T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
      version: 1,
    },
  ],
  external_references: [],
  activities: [],
  commercial_orders: [],
  site_licenses: [],
  metrics: {},
};

const outreachActivity = {
  id: "activity-id",
  organization_id: "organization-id",
  person_id: "person-id",
  opportunity_id: "opportunity-id",
  task_id: "task-id",
  zendesk_ticket_id: 20620,
  kind: "zendesk",
  source: "crm-outreach",
  source_id: "notification-requested:delivery-id",
  summary: "Zendesk notification requested for Ada Prospect",
  actor_account_id: "owner-account",
  occurred_at: "2026-08-20T10:05:00.000Z",
  metadata: { delivery_id: "delivery-id" },
  created_at: "2026-08-20T10:05:00.000Z",
};

const batch = {
  id: "batch-id",
  outreach_number: "OUT-2026-TEST",
  name: "Internal reviewed pilot",
  purpose: "Test readable CRM context",
  kind: "adoption_pilot",
  state: "draft",
  template_snapshot: {},
  owner_account_id: "owner-account",
  recipient_count: 1,
  approved_recipient_count: 0,
  created_by_account_id: "account-1",
  updated_by_account_id: "account-1",
  created_at: "2026-08-20T10:00:00.000Z",
  updated_at: "2026-08-20T10:00:00.000Z",
  version: 1,
};

describe("CRM outreach admin", () => {
  beforeAll(() => {
    const getComputedStyle = window.getComputedStyle;
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) => getComputedStyle(element));
    jest.spyOn(message, "success").mockImplementation(() => undefined as any);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    api.listOutreachDeliveries.mockResolvedValue({
      deliveries: [],
      truncated: false,
    });
    api.listOutreachBatches.mockResolvedValue({
      batches: [],
      truncated: false,
    });
    api.listOutreachTemplates.mockResolvedValue({
      templates: [],
      truncated: false,
    });
    api.listContactSuppressions.mockResolvedValue({
      suppressions: [],
      truncated: false,
    });
    api.listOutreachFollowups.mockResolvedValue({
      followups: [],
      truncated: false,
    });
    api.getOutreachLimits.mockResolvedValue(limits);
    api.getOutreachDiagnostics.mockResolvedValue(diagnostics);
    api.listOutreachProviderOperations.mockResolvedValue({
      operations: [],
      truncated: false,
    });
    api.listOutreachEngagementEvents.mockResolvedValue({
      events: [],
      truncated: false,
    });
    api.getOrganization.mockResolvedValue(customer);
    api.getCustomerTimeline.mockResolvedValue({
      activities: [],
      truncated: false,
    });
  });

  it("presents the shared queue, runbook, and visible delivery kill switch", async () => {
    render(<OutreachAdmin />);

    expect(
      screen.getByRole("heading", {
        name: "Initiate carefully. Follow up visibly.",
      }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: /UI guide/ })).toHaveAttribute(
      "href",
      "/app-docs/admin/crm-outreach-ui",
    );
    expect(screen.getByRole("link", { name: /Agent runbook/ })).toHaveAttribute(
      "href",
      "/app-docs/admin/crm-outreach",
    );
    expect(
      await screen.findByText("Zendesk delivery kill switch is off"),
    ).toBeVisible();
    expect(screen.getByLabelText("Outreach queue summary")).toBeVisible();
  });

  it("keeps history readable while mutation entry points are disabled", async () => {
    api.getOutreachLimits.mockResolvedValue({
      ...limits,
      mutations_enabled: false,
    });
    render(<OutreachAdmin />);

    expect(await screen.findByText("CRM outreach is read-only")).toBeVisible();
    expect(screen.getByRole("button", { name: /New outreach/ })).toBeDisabled();
    expect(screen.getByLabelText("Outreach queue summary")).toBeVisible();
  });

  it("resolves delivery links, follow-up ownership, and immutable activity", async () => {
    api.listOutreachDeliveries.mockResolvedValue({
      deliveries: [delivery],
      truncated: false,
    });
    api.getCustomerTimeline.mockResolvedValue({
      activities: [outreachActivity],
      truncated: false,
    });
    render(<OutreachAdmin />);

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));

    expect(await screen.findByText("Example University")).toBeVisible();
    expect(screen.getByText("Fall adoption pilot · Qualified")).toBeVisible();
    expect(screen.getAllByText("Follow up with Ada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Morgan Admin").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Zendesk notification requested for Ada Prospect"),
    ).toBeVisible();
    expect(screen.queryByText("organization-id")).not.toBeInTheDocument();
    expect(screen.queryByText("person-id")).not.toBeInTheDocument();
    expect(screen.queryByText("opportunity-id")).not.toBeInTheDocument();
    expect(screen.queryByText("task-id")).not.toBeInTheDocument();
  });

  it.each([
    { action: "Edit", key: "{Enter}", title: "Edit draft recipient" },
    { action: "Remove", key: " ", title: "Remove draft recipient" },
  ])(
    "opens $action by keyboard and restores its focus after Escape",
    async ({ action, key, title }) => {
      const user = userEvent.setup();
      api.listOutreachDeliveries.mockResolvedValue({
        deliveries: [{ ...delivery, state: "draft" }],
        truncated: false,
      });
      render(<OutreachAdmin />);

      const review = await screen.findByRole("button", { name: "Review" });
      const edit = screen.getByRole("button", { name: "Edit" });
      const remove = screen.getByRole("button", { name: "Remove" });
      review.focus();
      await user.tab();
      expect(edit).toHaveFocus();
      if (action === "Remove") {
        await user.tab();
        expect(remove).toHaveFocus();
      }
      const trigger = action === "Edit" ? edit : remove;
      await user.keyboard(key);

      const dialog = await screen.findByRole("dialog", { name: title });
      await waitFor(() => expect(dialog).toHaveFocus());
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toBeEnabled();
      expect(
        within(dialog).getByRole("button", { name: "Review change" }),
      ).toBeEnabled();
      await user.tab();
      expect(
        within(dialog).getByRole("button", { name: "Close" }),
      ).toHaveFocus();
      await user.tab();
      if (action === "Edit") {
        const subject = within(dialog).getByRole("textbox", {
          name: "Exact subject",
        });
        expect(subject).toHaveValue(delivery.subject);
        expect(subject).toHaveFocus();
        await user.tab();
        expect(
          within(dialog).getByRole("textbox", { name: "Markdown body" }),
        ).toHaveFocus();
        await user.tab();
        expect(
          within(dialog).getByRole("textbox", {
            name: "Preflight override reason (optional)",
          }),
        ).toHaveFocus();
        await user.tab();
        expect(
          within(dialog).getByRole("textbox", { name: "Audit reason" }),
        ).toHaveFocus();
      } else {
        expect(within(dialog).getByRole("alert")).toHaveTextContent(
          "Remove Ada Prospect from this draft batch?",
        );
        expect(
          within(dialog).getByRole("textbox", { name: "Audit reason" }),
        ).toHaveFocus();
      }

      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: title }),
        ).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(api.updateOutreachRecipient).not.toHaveBeenCalled();
      expect(api.removeOutreachRecipient).not.toHaveBeenCalled();
      expect(runFreshAuthAction).not.toHaveBeenCalled();
    },
  );

  it.each(["Edit", "Remove"])(
    "%s previews the exact recipient before a fresh-authenticated commit",
    async (action) => {
      const user = userEvent.setup();
      const mutation =
        action === "Edit"
          ? api.updateOutreachRecipient
          : api.removeOutreachRecipient;
      mutation.mockImplementation(async (request) => ({
        preview: !request.commit,
        action: `outreach.recipient.${action === "Edit" ? "update" : "remove"}`,
        expected_version: 4,
        idempotency_key: "recipient-preview-key",
        proposed: request,
        warnings: [],
      }));
      api.listOutreachDeliveries.mockResolvedValue({
        deliveries: [
          {
            ...delivery,
            state: "draft",
            body_markdown: `Reviewed body\n\n${delivery.footer}`,
          },
        ],
        truncated: false,
      });
      render(<OutreachAdmin />);
      await user.click(await screen.findByRole("button", { name: action }));
      const dialog = await screen.findByRole("dialog", {
        name: `${action} draft recipient`,
      });
      if (action === "Edit") {
        expect(
          within(dialog).getByRole("textbox", { name: "Markdown body" }),
        ).toHaveValue("Reviewed body");
      }
      await user.type(
        within(dialog).getByRole("textbox", { name: "Audit reason" }),
        "Reviewed recipient change",
      );
      await user.click(
        within(dialog).getByRole("button", { name: "Review change" }),
      );
      const confirm = await screen.findByRole("button", {
        name: "Confirm with fresh auth",
      });
      const expected = {
        batch: delivery.batch_id,
        delivery: delivery.id,
        ...(action === "Edit"
          ? { subject: delivery.subject, body_markdown: "Reviewed body" }
          : {}),
      };
      expect(mutation).toHaveBeenLastCalledWith(
        expect.objectContaining({ ...expected, commit: false }),
      );
      expect(runFreshAuthAction).not.toHaveBeenCalled();
      await user.click(confirm);
      await waitFor(() => expect(runFreshAuthAction).toHaveBeenCalledTimes(1));
      expect(mutation).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ...expected,
          commit: true,
          expected_version: 4,
          idempotency_key: "recipient-preview-key",
          browser_id: "browser-test",
        }),
      );
    },
  );

  it("disables draft recipient actions in the read-only workspace", async () => {
    const user = userEvent.setup();
    api.getOutreachLimits.mockResolvedValue({
      ...limits,
      mutations_enabled: false,
    });
    api.listOutreachDeliveries.mockResolvedValue({
      deliveries: [{ ...delivery, state: "draft" }],
      truncated: false,
    });
    render(<OutreachAdmin />);

    const review = await screen.findByRole("button", { name: "Review" });
    const edit = screen.getByRole("button", { name: "Edit" });
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(edit).toBeDisabled();
    expect(remove).toBeDisabled();
    review.focus();
    await user.tab();
    expect(edit).not.toHaveFocus();
    expect(remove).not.toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not offer Edit or Remove for a non-draft recipient", async () => {
    api.listOutreachDeliveries.mockResolvedValue({
      deliveries: [delivery],
      truncated: false,
    });
    render(<OutreachAdmin />);

    await screen.findByRole("button", { name: "Review" });
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("shows Customer 360 suppressions and opens their shared workspace", async () => {
    const onOpenOutreach = jest.fn();
    api.listContactSuppressions.mockResolvedValue({
      suppressions: [
        {
          id: "suppression-id",
          scope: "email",
          normalized_scope_value: "ada@example.edu",
          organization_id: "organization-id",
          reason: "manual",
          source: "admin_ui",
          active: true,
          created_at: "2026-08-20T10:00:00.000Z",
          version: 1,
        },
      ],
      truncated: false,
    });
    render(
      <CustomerOutreachCard
        onOpenOutreach={onOpenOutreach}
        organization="organization-id"
      />,
    );

    expect(await screen.findByText("1 active suppression")).toBeVisible();
    expect(screen.getByText(/Email · ada@example.edu/)).toBeVisible();
    const manage = screen.getByRole("button", { name: /Manage suppressions/ });
    manage.focus();
    expect(manage).toHaveFocus();
    fireEvent.click(manage);
    expect(onOpenOutreach).toHaveBeenCalledWith(false, "suppressions");
  });

  it("renders batch recipient CRM context with human names", async () => {
    api.listOutreachBatches.mockResolvedValue({
      batches: [batch],
      truncated: false,
    });
    api.getOutreachBatch.mockResolvedValue({
      batch,
      deliveries: [delivery],
    });
    api.previewOutreachBatch.mockResolvedValue({
      batch,
      deliveries: [{ delivery, blocking_errors: [], warnings: [] }],
      provider_routing: {},
      can_approve: true,
      can_queue: false,
      blocking_errors: [],
      warnings: [],
    });
    render(<OutreachAdmin initialView="batches" />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Review exact messages" }),
    );

    expect(await screen.findByText("Example University")).toBeVisible();
    expect(screen.getByText("Fall adoption pilot · Qualified")).toBeVisible();
    expect(screen.getByText(/Follow-up: Follow up with Ada/)).toBeVisible();
    expect(screen.queryByText("organization-id")).not.toBeInTheDocument();
  });

  it("previews an exact batch mutation before a fresh-authenticated commit", async () => {
    api.createOutreachBatch.mockImplementation(async (request) =>
      request.commit
        ? {
            preview: false,
            action: "outreach.batch.create",
            record: { id: "batch-1" },
          }
        : {
            preview: true,
            action: "outreach.batch.create",
            expected_version: 0,
            idempotency_key: "preview-key",
            proposed: {
              name: request.name,
              purpose: request.purpose,
            },
            warnings: [],
          },
    );
    render(<OutreachAdmin />);

    const newOutreach = screen.getByRole("button", { name: /New outreach/ });
    await waitFor(() => expect(newOutreach).toBeEnabled());
    fireEvent.click(newOutreach);
    fireEvent.change(screen.getByLabelText("Batch name"), {
      target: { value: "Internal adoption pilot test" },
    });
    fireEvent.change(screen.getByLabelText("Reviewed purpose"), {
      target: { value: "Exercise the reviewed outreach workflow" },
    });
    fireEvent.change(screen.getByLabelText("Responsible owner"), {
      target: { value: "account-1" },
    });
    fireEvent.change(screen.getByLabelText("Audit reason"), {
      target: { value: "Review an internal outreach workflow test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));

    expect(
      await screen.findByText("Review the proposed outreach change"),
    ).toBeInTheDocument();
    expect(api.createOutreachBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ commit: false, browser_id: "browser-test" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm with fresh auth" }),
    );
    await waitFor(() => expect(runFreshAuthAction).toHaveBeenCalledTimes(1));
    expect(api.createOutreachBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        commit: true,
        expected_version: 0,
        idempotency_key: "preview-key",
      }),
    );
  });

  it("keeps a commit failure visible inside the active review modal", async () => {
    api.createOutreachBatch
      .mockResolvedValueOnce({
        preview: true,
        action: "outreach.batch.create",
        expected_version: 0,
        idempotency_key: "preview-key",
        proposed: { name: "Test" },
        warnings: [],
      })
      .mockRejectedValueOnce(new Error("Zendesk test provider unavailable"));
    render(<OutreachAdmin />);

    const newOutreach = screen.getByRole("button", { name: /New outreach/ });
    await waitFor(() => expect(newOutreach).toBeEnabled());
    fireEvent.click(newOutreach);
    fireEvent.change(screen.getByLabelText("Batch name"), {
      target: { value: "Internal test" },
    });
    fireEvent.change(screen.getByLabelText("Reviewed purpose"), {
      target: { value: "Validate modal-local error rendering" },
    });
    fireEvent.change(screen.getByLabelText("Responsible owner"), {
      target: { value: "account-1" },
    });
    fireEvent.change(screen.getByLabelText("Audit reason"), {
      target: { value: "Review the internal failure path" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm with fresh auth" }),
    );

    const errorText = await screen.findByText(
      "Error: Zendesk test provider unavailable",
    );
    const error = errorText.closest("[role='alert']");
    expect(error).toHaveTextContent("Zendesk test provider unavailable");
    expect(
      screen.getByRole("button", { name: /Confirm with fresh auth/ }),
    ).toBeInTheDocument();
  });
});
