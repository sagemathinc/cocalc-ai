import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComputeFundingApi } from "@cocalc/conat/hub/api/compute-funding";
import { ComputeBudget } from "./compute-budget-panel";
import type { CourseVmRecommendationsApi } from "./course-vm-recommendations";
import { template } from "./test/course-vm-template-fixture";

jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("@cocalc/frontend/components/icon", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/account/low-credit-notification-setting", () => ({
  SponsoredComputeReminder: () => <div>Sponsored pool alert</div>,
}));
beforeEach(() => {
  const getComputedStyle = window.getComputedStyle;
  jest
    .spyOn(window, "getComputedStyle")
    .mockImplementation((element) => getComputedStyle(element));
});
afterEach(() => jest.restoreAllMocks());

const account = "11111111-1111-4111-8111-111111111111";
const props = {
  course_project_id: "33333333-3333-4333-8333-333333333333",
  course_instance_id: "44444444-4444-4444-8444-444444444444",
  students: [
    { id: "a", account_id: account, name: "Alice" },
    { id: "b", name: "Pending" },
  ],
};

function api(): jest.Mocked<ComputeFundingApi & CourseVmRecommendationsApi> {
  return {
    audit: jest.fn(),
    getOwnedPools: jest.fn(),
    previewPoolChange: jest.fn(),
    proposePoolChange: jest.fn(),
    getCourseVmRecommendations: jest
      .fn()
      .mockResolvedValue({ templates: [template], version: 2 }),
    setCourseVmRecommendations: jest
      .fn()
      .mockImplementation(async ({ templates }) => ({ templates, version: 3 })),
    getCourseSummary: jest.fn().mockResolvedValue({
      as_of: new Date().toISOString(),
      pools: [],
      sponsorship: { enabled: true, available: true },
    }),
    listSources: jest.fn(),
    previewAllocation: jest.fn().mockImplementation(async ({ terms }) => ({
      terms,
      available_backing_usd: "1000",
      as_of: new Date().toISOString(),
      recipients: [
        { beneficiary_account_id: account, display_name: "Verified Alice" },
      ],
    })),
    proposeAllocation: jest.fn().mockResolvedValue({
      id: "intent",
      status: "pending",
      expires_at: "2030-01-01T00:00:00Z",
      approval_url: "https://approve.example.test/intent",
    }),
    getAllocationStatus: jest.fn(),
  };
}

it("previews by keyboard, focuses the result and requests separate authorization", async () => {
  const service = api();
  const user = userEvent.setup();
  render(<ComputeBudget {...props} api={service} />);
  const select = screen.getByRole("checkbox", { name: "Select Alice" });
  await waitFor(() => expect(select).not.toBeDisabled());
  expect(
    await screen.findByRole("button", { name: "Edit Notebook CPU" }),
  ).toBeVisible();
  expect(service.getCourseVmRecommendations).toHaveBeenCalledWith({
    course_project_id: props.course_project_id,
    course_instance_id: props.course_instance_id,
  });
  expect(service.setCourseVmRecommendations).not.toHaveBeenCalled();
  expect(
    screen.getByRole("checkbox", { name: "Select Pending" }),
  ).toBeDisabled();
  expect(
    screen.getByText("Waiting for student to join the course"),
  ).toBeVisible();
  select.focus();
  await user.keyboard(" ");
  const preview = screen.getByRole("button", { name: "Preview allocation" });
  preview.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Allocation preview" }),
    ).toHaveFocus(),
  );
  expect(screen.getByText("Verified Alice")).toBeVisible();
  expect(service.proposeAllocation).not.toHaveBeenCalled();
  expect(
    screen.getByRole("region", { name: "Allocation preview" })
      .nextElementSibling,
  ).toBe(screen.getByRole("region", { name: "Recommended VM templates" }));

  const retentionHelp = screen.getByRole("button", {
    name: "What happens when the student runs out of money?",
  });
  retentionHelp.focus();
  await user.keyboard("{Enter}");
  const retentionPopover = await screen.findByRole("tooltip");
  expect(
    within(retentionPopover).getByText(
      (_, element) =>
        element?.tagName === "P" &&
        element.textContent?.includes(
          "reserve the full cost of its boot disk for 3 days after compute stops",
        ) === true,
    ),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");

  expect(screen.getByText(/No credit is allocated yet/i)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Authorize" }));
  const link = await screen.findByRole("link", {
    name: "Authorize",
  });
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(
    screen.getByRole("button", { name: "Preview allocation" }),
  ).toBeDisabled();
  expect(service.proposeAllocation).toHaveBeenCalledTimes(1);
});

it.each([
  undefined,
  {
    enabled: false,
    available: false,
    reason: "New course sponsorship is disabled.",
  },
  { enabled: true, available: false, reason: "Writer coverage is unverified." },
])(
  "fails closed for unavailable sponsorship without hiding recommendations",
  async (sponsorship) => {
    const service = api();
    service.getCourseSummary.mockResolvedValue({
      as_of: new Date().toISOString(),
      pools: [],
      sponsorship,
    });
    render(<ComputeBudget {...props} api={service} />);
    await screen.findByRole("button", { name: "Edit Notebook CPU" });
    expect(
      screen.getByRole("checkbox", { name: "Select Alice" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Preview allocation" }),
    ).toBeDisabled();
    expect(service.previewAllocation).not.toHaveBeenCalled();
    expect(service.proposeAllocation).not.toHaveBeenCalled();
  },
);

it("explains when course-funded compute is disabled", async () => {
  const service = api();
  service.getCourseSummary.mockResolvedValue({
    as_of: new Date().toISOString(),
    pools: [],
    sponsorship: {
      enabled: false,
      available: false,
      reason: "New course sponsorship is disabled.",
    },
  });
  render(<ComputeBudget {...props} api={service} />);

  expect(
    await screen.findByText(
      "Course-funded compute is not available on this site",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(/cannot allocate course credit until this service/i),
  ).toBeVisible();
  expect(screen.queryByText("New course sponsorship is disabled.")).toBeNull();
});

it("does not show a stale preview after terms change", async () => {
  const service = api();
  let resolve: (value: any) => void = () => {};
  service.previewAllocation.mockImplementation(
    ({ terms }) =>
      new Promise((done) => {
        resolve = () =>
          done({
            terms,
            available_backing_usd: "1000",
            recipients: [],
            as_of: new Date().toISOString(),
          });
      }),
  );
  render(<ComputeBudget {...props} api={service} />);
  await waitFor(() =>
    expect(
      screen.getByRole("checkbox", { name: "Select Alice" }),
    ).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("checkbox", { name: "Select Alice" }));
  fireEvent.click(screen.getByRole("button", { name: "Preview allocation" }));
  await waitFor(() => expect(service.previewAllocation).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("Credit per student (USD)"), {
    target: { value: "60" },
  });
  resolve(undefined);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Preview allocation" }),
    ).not.toHaveClass("ant-btn-loading"),
  );
  expect(
    screen.queryByRole("heading", { name: "Allocation preview" }),
  ).toBeNull();
});

it("keeps allocation disabled when the authoritative summary is unavailable", async () => {
  const service = api();
  service.getCourseSummary.mockRejectedValue(new Error("Funding unavailable"));
  render(<ComputeBudget {...props} api={service} />);
  expect(await screen.findByText("Funding unavailable")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Preview allocation" }),
  ).toBeDisabled();
  expect(
    await screen.findByRole("button", { name: "Edit Notebook CPU" }),
  ).toBeEnabled();
  expect(service.setCourseVmRecommendations).not.toHaveBeenCalled();
});

it("saves project recommendations even when financial allocation is unavailable", async () => {
  const service = api();
  const user = userEvent.setup();
  service.getCourseSummary.mockRejectedValue(new Error("Funding unavailable"));
  render(<ComputeBudget {...props} api={service} />);
  await user.click(
    await screen.findByRole("button", { name: "Remove Notebook CPU" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Save recommendations" }),
  );
  expect(await screen.findByText("Recommendations saved")).toBeVisible();
  expect(service.setCourseVmRecommendations).toHaveBeenCalledWith({
    course_project_id: props.course_project_id,
    course_instance_id: props.course_instance_id,
    templates: [],
    expected_version: 2,
  });
  expect(service.previewAllocation).not.toHaveBeenCalled();
  expect(service.proposeAllocation).not.toHaveBeenCalled();
});
