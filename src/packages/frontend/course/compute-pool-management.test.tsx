import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ComputeFundingApi,
  CourseFundingPoolSummary,
} from "@cocalc/conat/hub/api/compute-funding";
import { ComputePoolManagement } from "./compute-pool-management";
import { poolChangeDraft } from "./compute-pool-management-model";

jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getActions: () => ({ clear_all_handlers: () => {} }) },
}));
beforeEach(() => {
  const original = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((el) => original(el));
});
afterEach(() => jest.restoreAllMocks());
const project = "33333333-3333-4333-8333-333333333333",
  instance = "44444444-4444-4444-8444-444444444444";
const pool: CourseFundingPoolSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  state: "active",
  lane: "prepaid",
  allow_overcommit: false,
  authorized_usd: "100",
  spent_usd: "0",
  reserved_usd: "0",
  released_usd: "0",
  approval_limit_usd: "100",
  approval_starts_at: "2026-01-01T00:00:00Z",
  approval_ends_at: "2030-01-01T00:00:00Z",
  starts_at: "2026-01-01T00:00:00Z",
  ends_at: "2030-01-01T00:00:00Z",
  grants: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      version: 1,
      beneficiary_account_id: "55555555-5555-4555-8555-555555555555",
      state: "active",
      authorized_usd: "100",
      spent_usd: "0",
      reserved_usd: "0",
      released_usd: "0",
    },
  ],
};
const students = [
  { id: "s", account_id: pool.grants[0].beneficiary_account_id, name: "Alice" },
];
function fixture() {
  const api: jest.Mocked<
    Pick<
      ComputeFundingApi,
      "previewPoolChange" | "proposePoolChange" | "getAllocationStatus"
    >
  > = {
    previewPoolChange: jest.fn().mockImplementation(async ({ terms }) => ({
      terms,
      pool: {
        ...pool,
        state: terms.action === "close" ? "closed" : "active",
      },
      requires_financial_approval:
        terms.amount_usd != null && Number(terms.amount_usd) > 100,
      requires_course_access: false,
      as_of: new Date().toISOString(),
    })),
    proposePoolChange: jest.fn().mockImplementation(async ({ terms }) =>
      terms.amount_usd != null && Number(terms.amount_usd) > 100
        ? {
            id: "intent",
            status: "pending",
            approval_url: "https://approve.example.test/pool",
            expires_at: "2030-01-01T00:00:00Z",
          }
        : {
            id: "operation",
            status: "approved",
            pool_id: pool.id,
            expires_at: new Date().toISOString(),
          },
    ),
    getAllocationStatus: jest.fn().mockResolvedValue({
      id: "intent",
      status: "pending",
      expires_at: "2030-01-01T00:00:00Z",
      approval_url: "https://approve.example.test/pool",
    }),
  };
  const onUpdated = jest.fn().mockResolvedValue(undefined);
  const props = {
    pool,
    students,
    api,
    onUpdated,
    course_project_id: project,
    course_instance_id: instance,
    pollIntervalMs: 50,
  };
  return {
    api,
    onUpdated,
    props,
    ...render(<ComputePoolManagement {...props} />),
  };
}

it("adjusts exact pool and student totals through server preview and isolated approval, then refreshes", async () => {
  const f = fixture(),
    user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Adjust budget" }));
  expect(
    screen.getByRole("heading", { name: "Adjust pool budget" }),
  ).toHaveFocus();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Total pool ceiling (USD)" }),
    { target: { value: "120" } },
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Ceiling for Alice (USD)" }),
    { target: { value: "120" } },
  );
  const preview = screen.getByRole("button", { name: "Preview pool change" });
  preview.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Pool change preview" }),
    ).toHaveFocus(),
  );
  expect(f.api.previewPoolChange).toHaveBeenCalledWith({
    terms: expect.objectContaining({
      expected_version: 1,
      amount_usd: "120.0000000000",
      grants: [
        expect.objectContaining({
          grant_id: pool.grants[0].id,
          amount_usd: "120.0000000000",
        }),
      ],
    }),
  });
  expect(f.api.proposePoolChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Authorize" }));
  const link = await screen.findByRole("link", {
    name: "Authorize",
  });
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(screen.getByRole("button", { name: "Close pool" })).toBeDisabled();
  f.api.getAllocationStatus.mockResolvedValue({
    id: "intent",
    status: "approved",
    expires_at: "2030-01-01T00:00:00Z",
  });
  await waitFor(() => expect(f.onUpdated).toHaveBeenCalled());
  expect(await screen.findByText("Pool updated")).toBeVisible();
});

it("revokes selected grants without changing pool backing and supports Escape focus restoration", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const open = screen.getByRole("button", { name: "Revoke grants" });
  await user.click(open);
  await user.click(
    screen.getByRole("checkbox", { name: "Select grant for Alice" }),
  );
  await user.click(screen.getByRole("button", { name: "Preview pool change" }));
  await screen.findByRole("heading", { name: "Pool change preview" });
  expect(f.api.previewPoolChange).toHaveBeenCalledWith({
    terms: {
      course_project_id: project,
      course_instance_id: instance,
      pool_id: pool.id,
      expected_version: 1,
      action: "revise",
      grants: [
        { grant_id: pool.grants[0].id, expected_version: 1, action: "revoke" },
      ],
    },
  });
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Pool management" })).toBeNull();
  expect(open).toHaveFocus();
});

it("closes only through preview and proposal, retaining the same operation ID on retry", async () => {
  const f = fixture(),
    user = userEvent.setup();
  f.api.proposePoolChange.mockRejectedValueOnce(Error("Network unavailable"));
  await user.click(screen.getByRole("button", { name: "Close pool" }));
  await user.click(screen.getByRole("button", { name: "Preview pool change" }));
  await user.click(await screen.findByRole("button", { name: "Save changes" }));
  expect(await screen.findByText("Network unavailable")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(f.onUpdated).toHaveBeenCalled());
  expect(f.api.proposePoolChange.mock.calls[0]).toEqual(
    f.api.proposePoolChange.mock.calls[1],
  );
  expect(f.api.proposePoolChange.mock.calls[0][0].terms).toMatchObject({
    action: "close",
    expected_version: 1,
  });
});

it("discards an in-flight preview after a budget edit and blocks stale pool proposals", async () => {
  const f = fixture(),
    user = userEvent.setup();
  let resolve: (value: any) => void = () => {};
  f.api.previewPoolChange.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await user.click(screen.getByRole("button", { name: "Adjust budget" }));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Total pool ceiling (USD)" }),
    { target: { value: "120" } },
  );
  await user.click(screen.getByRole("button", { name: "Preview pool change" }));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Total pool ceiling (USD)" }),
    { target: { value: "130" } },
  );
  resolve({ terms: {}, pool, as_of: new Date().toISOString() });
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "Pool change preview" }),
    ).toBeNull(),
  );
  f.rerender(
    <ComputePoolManagement {...f.props} pool={{ ...pool, version: 2 }} />,
  );
  expect(
    screen.getByRole("button", { name: "Preview pool change" }),
  ).toBeDisabled();
});

it("retains exact irreversible release history in UI ceilings", () => {
  const terms = poolChangeDraft({
    pool: { ...pool, authorized_usd: "120", released_usd: "20" },
    course_project_id: project,
    course_instance_id: instance,
    action: "revise",
    amount: "110",
    amounts: { [pool.grants[0].id]: "100" },
    starts: "2026-01-01T00:00",
    ends: "2030-01-01T00:00",
    selected: [],
  });
  expect(terms.amount_usd).toBe("110.0000000000");
  expect(terms.grants).toBeUndefined();
});

it("applies a bulk student ceiling and matches the exact pool total", async () => {
  const f = fixture(),
    user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Adjust budget" }));
  await user.click(screen.getByRole("checkbox", { name: "Select all grants" }));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Selected student ceiling (USD)" }),
    { target: { value: "125.25" } },
  );
  await user.click(screen.getByRole("button", { name: "Apply to selected" }));
  await user.click(screen.getByRole("button", { name: "Match student total" }));
  await user.click(screen.getByRole("button", { name: "Preview pool change" }));
  await screen.findByRole("heading", { name: "Pool change preview" });
  expect(f.api.previewPoolChange).toHaveBeenCalledWith({
    terms: expect.objectContaining({
      amount_usd: "125.2500000000",
      grants: [expect.objectContaining({ amount_usd: "125.2500000000" })],
    }),
  });
});

it("does not bypass authorization after an expired expansion intent", async () => {
  const f = fixture(),
    user = userEvent.setup();
  f.api.getAllocationStatus.mockResolvedValue({
    id: "intent",
    status: "expired",
    expires_at: "2026-01-01T00:00:00Z",
  });
  await user.click(screen.getByRole("button", { name: "Adjust budget" }));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Total pool ceiling (USD)" }),
    { target: { value: "120" } },
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Ceiling for Alice (USD)" }),
    { target: { value: "120" } },
  );
  await user.click(screen.getByRole("button", { name: "Preview pool change" }));
  await user.click(await screen.findByRole("button", { name: "Authorize" }));
  expect(await screen.findByText("Authorization expired")).toBeVisible();
  expect(f.onUpdated).not.toHaveBeenCalled();
  expect(screen.queryByRole("link", { name: "Authorize" })).toBeNull();
  expect(screen.getByRole("button", { name: "Adjust budget" })).toBeEnabled();
});
