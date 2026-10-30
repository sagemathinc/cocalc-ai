import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const projectFunding = jest.fn();
const approveProjectFunding = jest.fn();
const revokeProjectFunding = jest.fn();
const budget = jest.fn();
const keyStatus = jest.fn();
const freshAuth = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});
let me = "00000000-1000-4000-8000-0000000000aa";

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: (action: () => Promise<void>) => freshAuth(action),
    freshAuthModalProps: {},
  }),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: () => me,
}));
jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/",
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        gpu: {
          projectFunding: (...a: any[]) => projectFunding(...a),
          approveProjectFunding: (...a: any[]) => approveProjectFunding(...a),
          revokeProjectFunding: (...a: any[]) => revokeProjectFunding(...a),
          budget: (...a: any[]) => budget(...a),
        },
        system: {
          getGpuProviderKeyStatus: (...a: any[]) => keyStatus(...a),
        },
      },
    },
  },
}));

import { ProjectFundingBanner } from "./project-funding-banner";

const PROJECT = "00000000-1000-4000-8000-000000000001";
const FUNDER = "00000000-1000-4000-8000-0000000000ff";
const REQUEST = {
  project_id: PROJECT,
  request: {
    id: "r1",
    actor_kind: "project",
    actor_account_id: null,
    summary: {
      gpu_type_id: "NVIDIA A100 80GB PCIe",
      gpu_count: 1,
      max_runtime_minutes: 120,
    },
    created: "2026-11-01T00:00:00Z",
    expires_at: "2026-11-08T00:00:00Z",
  },
};
const FUNDED = {
  project_id: PROJECT,
  approval: {
    approval_id: "a1",
    state: "active",
    funder_account_id: FUNDER,
    live_pods: 1,
    display: {
      authorized_usd: "400.0000000000",
      ends_at: "2026-11-08T00:00:00Z",
      agents_allowed: true,
      funder_name: "Prof Ada",
    },
    spend: {
      authorized_usd: "400",
      spent_usd: "80",
      reserved_usd: "7.6",
      available_usd: "312.40",
    },
  },
};

beforeEach(() => {
  for (const f of [
    projectFunding,
    approveProjectFunding,
    revokeProjectFunding,
    budget,
    keyStatus,
  ]) {
    f.mockReset();
  }
  me = "00000000-1000-4000-8000-0000000000aa";
  localStorage.clear();
  budget.mockResolvedValue({ available_usd: "20" });
});

describe("ProjectFundingBanner", () => {
  it("shows a request; a viewer with a key approves it after a fresh sign-in, raising the key budget", async () => {
    projectFunding.mockResolvedValue(REQUEST);
    keyStatus.mockResolvedValue({ entitled: true, connected: true });
    approveProjectFunding.mockResolvedValue({});
    render(<ProjectFundingBanner projectId={PROJECT} />);
    expect(
      await screen.findByText(/GPUs were requested in this project/),
    ).toBeTruthy();
    expect(
      screen.getByText(/from a terminal or code in this project/),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Approve with my RunPod account…" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "$400" }));
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    // the key budget has $20 left: the dialog offers the raise (on)
    expect(
      await screen.findByText(
        /budget has \$20.00 left: also raise it to \$400.00/,
      ),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Approve (you'll sign in again)" }),
    );
    await waitFor(() => expect(approveProjectFunding).toHaveBeenCalled());
    expect(freshAuth).toHaveBeenCalled();
    const arg = approveProjectFunding.mock.calls[0][0];
    expect(arg).toMatchObject({
      project_id: PROJECT,
      terms: {
        provider: "runpod",
        authorized_usd: "400.00",
        days: 7,
        agents_allowed: true,
      },
      raise_key_budget_to: "400",
      browser_id: "browser-1",
    });
    expect(arg.operation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("tells a viewer without a key how to approve, with no approve button", async () => {
    projectFunding.mockResolvedValue(REQUEST);
    keyStatus.mockResolvedValue({ entitled: true, connected: false });
    render(<ProjectFundingBanner projectId={PROJECT} />);
    expect(await screen.findByText(/connect your own RunPod key/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Approve with my RunPod account…" }),
    ).toBeNull();
  });

  it("shows who pays and what's left; only the funder can end it", async () => {
    projectFunding.mockResolvedValue(FUNDED);
    keyStatus.mockResolvedValue({ entitled: true, connected: true });
    const { unmount } = render(<ProjectFundingBanner projectId={PROJECT} />);
    expect(
      await screen.findByText(
        /paid by Prof Ada's RunPod account: \$312.40 of \$400.00 left/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "End this approval…" }),
    ).toBeNull();
    unmount();
    me = FUNDER;
    revokeProjectFunding.mockResolvedValue({});
    render(<ProjectFundingBanner projectId={PROJECT} />);
    expect(await screen.findByText(/paid by your RunPod account/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "End this approval…" }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "End it and terminate its GPUs",
      }),
    );
    await waitFor(() =>
      expect(revokeProjectFunding).toHaveBeenCalledWith({ approval_id: "a1" }),
    );
  });

  it("in project settings, offers to approve even without a request", async () => {
    projectFunding.mockResolvedValue({ project_id: PROJECT });
    keyStatus.mockResolvedValue({ entitled: true, connected: true });
    render(<ProjectFundingBanner projectId={PROJECT} always />);
    expect(
      await screen.findByRole("button", {
        name: "Approve GPU use in this project…",
      }),
    ).toBeTruthy();
  });

  it("shows nothing in the project when nobody asked and nobody pays", async () => {
    projectFunding.mockResolvedValue({ project_id: PROJECT });
    keyStatus.mockResolvedValue({ entitled: true, connected: true });
    const { container } = render(<ProjectFundingBanner projectId={PROJECT} />);
    await waitFor(() => expect(projectFunding).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
