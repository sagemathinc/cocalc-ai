import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MergeApprovalArtifact } from "./merge-approval-artifact";

const get = jest.fn();
const decide = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        mergeApprovals: {
          get: (...args: any[]) => get(...args),
          decide: (...args: any[]) => decide(...args),
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: async (action: () => Promise<void>) => {
      await action();
      return true;
    },
  }),
}));

const ID = "55555555-5555-4555-8555-555555555555";
const HEAD = "c".repeat(40);

function view(overrides: any = {}) {
  return {
    request: {
      id: ID,
      repo: "sagemathinc/cocalc-ai",
      pr_number: 1430,
      head_sha: HEAD,
      base_ref: "main",
      agent_note: "Please approve [this](https://evil.example)",
      requested_by: { account_id: "a", project_id: "p", agent_label: "ops3" },
      created_at: "2026-10-27T04:00:00Z",
      expires_at: "2026-11-03T04:00:00Z",
      status: "pending",
      github_snapshot: {
        title: "Merge approvals, part 1",
        state: "open",
        draft: false,
        author: "agent",
        base_ref: "main",
        head_ref: "feat/x",
        head_sha: HEAD,
        html_url: "https://github.com/sagemathinc/cocalc-ai/pull/1430",
        additions: 10,
        deletions: 2,
        changed_files: 1,
        files: [{ filename: "a.ts", additions: 10, deletions: 2 }],
        files_truncated: false,
        checks: [{ name: "test", status: "completed", conclusion: "success" }],
        reviews: [],
        read_at: "2026-10-27T04:00:00Z",
      },
      ...overrides,
    },
  };
}

beforeEach(() => {
  get.mockReset().mockResolvedValue([view()]);
  decide.mockReset().mockResolvedValue({});
});

test("shows what the hub recorded and labels the agent's note", async () => {
  render(<MergeApprovalArtifact requestIds={[ID]} />);
  const card = await screen.findByRole("region", {
    name: "Merge approval for sagemathinc/cocalc-ai #1430",
  });
  expect(card).toHaveTextContent("Merge approvals, part 1");
  expect(
    screen.getByRole("link", { name: "sagemathinc/cocalc-ai #1430" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/sagemathinc/cocalc-ai/pull/1430",
  );
  expect(
    screen.getByText("Note from the requesting agent (not checked by CoCalc)"),
  ).toBeInTheDocument();
  // The note is plain text: its Markdown link is not a link.
  expect(
    screen.getByText("Please approve [this](https://evil.example)"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "this" })).toBeNull();
  expect(get).toHaveBeenCalledWith({ request_ids: [ID] });
});

test("approves the exact head with a comment, by keyboard", async () => {
  const user = userEvent.setup();
  render(<MergeApprovalArtifact requestIds={[ID]} />);
  const comment = await screen.findByRole("textbox", {
    name: "Comment for sagemathinc/cocalc-ai #1430",
  });
  await user.click(comment);
  await user.keyboard("looks good");
  await user.tab();
  const approve = screen.getByRole("button", {
    name: `Approve head ${HEAD.slice(0, 12)}`,
  });
  expect(approve).toHaveFocus();
  get.mockResolvedValue([
    {
      ...view({ status: "approved" }),
      decision: {
        id: "d",
        request_id: ID,
        account_id: "a",
        decision: "approve",
        comment: "looks good",
        factor_level: "totp",
        decided_at: "2026-10-27T05:00:00Z",
      },
    },
  ]);
  await user.keyboard("{Enter}");
  expect(decide).toHaveBeenCalledWith({
    request_id: ID,
    decision: "approve",
    comment: "looks good",
  });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /Approve head/ })).toBeNull(),
  );
  expect(screen.getByText("approved")).toBeInTheDocument();
});

test("shows decision errors and keeps the request open", async () => {
  decide.mockRejectedValue(
    new Error("recent two-factor verification is required"),
  );
  render(<MergeApprovalArtifact requestIds={[ID]} />);
  fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
  expect(
    await screen.findByText("recent two-factor verification is required"),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
});

test("offers no decision in read-only or decided cards", async () => {
  render(<MergeApprovalArtifact requestIds={[ID]} readOnly />);
  await screen.findByRole("region");
  expect(screen.queryByRole("button", { name: /Approve head/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
});

test("tells non-approvers they can't see the requests", async () => {
  get.mockRejectedValue(
    new Error("merge approvals are shown to approvers only"),
  );
  render(<MergeApprovalArtifact requestIds={[ID]} />);
  expect(
    await screen.findByText(
      "Only merge approvers can see and decide these requests.",
    ),
  ).toBeInTheDocument();
});
