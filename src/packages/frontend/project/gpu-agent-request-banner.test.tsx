import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const agentRequests = jest.fn();
const approveAgentRequest = jest.fn();
const denyAgentRequest = jest.fn();
const revokeAgentGrant = jest.fn();
const budget = jest.fn();
const freshAuth = jest.fn(async (action: () => Promise<void>) => {
  await action();
  return true;
});

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: (action: () => Promise<void>) => freshAuth(action),
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        gpu: {
          agentRequests: (...args: any[]) => agentRequests(...args),
          approveAgentRequest: (...args: any[]) => approveAgentRequest(...args),
          denyAgentRequest: (...args: any[]) => denyAgentRequest(...args),
          revokeAgentGrant: (...args: any[]) => revokeAgentGrant(...args),
          budget: (...args: any[]) => budget(...args),
        },
      },
    },
  },
}));

import { GPU_AGENT_REQUESTS_PROJECT_DETAIL_FIELD } from "@cocalc/conat/hub/api/gpu";
import { GpuAgentRequestBanner } from "./gpu-agent-request-banner";
import { publishProjectDetailInvalidation } from "./use-project-field";

const PENDING = {
  request_id: "11111111-1000-4000-8000-000000000001",
  project_id: "project-1",
  principal_kind: "chat_session",
  operation_id: "cli-abc",
  payload: {
    spec: {
      gpu_type_id: "NVIDIA GeForce RTX 4090",
      gpu_count: 1,
      image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
      max_runtime_minutes: 60,
    },
    hourly_usd: "0.6900000000",
    max_cost_usd: "0.72",
    max_pods: 1,
  },
  payload_hash: "b".repeat(64),
  state: "pending",
  created: "2026-10-28T12:00:00.000Z",
  expires_at: "2026-10-28T12:30:00.000Z",
};
const ACTIVE = {
  ...PENDING,
  request_id: "r-active",
  state: "approved",
  grant: {
    grant_id: "grant-1",
    state: "active",
    expires_at: "2026-10-28T12:30:00.000Z",
    launches_used: 1,
  },
};

describe("GpuAgentRequestBanner", () => {
  beforeEach(() => {
    for (const f of [
      agentRequests,
      approveAgentRequest,
      denyAgentRequest,
      revokeAgentGrant,
      budget,
    ]) {
      f.mockReset();
    }
    freshAuth.mockClear();
    budget.mockResolvedValue({ paused: false, kill_switch: false });
  });

  it("shows nothing when there are no requests", async () => {
    agentRequests.mockResolvedValue([]);
    const { container } = render(
      <GpuAgentRequestBanner projectId="project-1" />,
    );
    await waitFor(() =>
      expect(agentRequests).toHaveBeenCalledWith({ project_id: "project-1" }),
    );
    expect(container.textContent).toBe("");
    // no budget lookup without a request
    expect(budget).not.toHaveBeenCalled();
  });

  it("shows the exact launch and approves exactly it, after a fresh sign-in", async () => {
    agentRequests.mockResolvedValueOnce([PENDING]).mockResolvedValue([]);
    approveAgentRequest.mockResolvedValue({ grant_id: "g", state: "active" });
    render(<GpuAgentRequestBanner projectId="project-1" />);
    const approve = await screen.findByRole("button", {
      name: "Approve this launch",
    });
    expect(screen.getByText("This chat session")).not.toBeNull();
    expect(screen.getByText(/\$0\.72/)).not.toBeNull();
    expect(screen.getByText(/\$0\.69\/hour/)).not.toBeNull();
    // never the session's key
    expect(document.body.textContent).not.toContain("session:");
    fireEvent.click(approve);
    await waitFor(() =>
      expect(approveAgentRequest).toHaveBeenCalledWith({
        request_id: PENDING.request_id,
        expected_hash: PENDING.payload_hash,
        browser_id: "browser-1",
      }),
    );
    expect(freshAuth).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Approve this launch" }),
      ).toBeNull(),
    );
  });

  it("approves nothing when the fresh sign-in is cancelled", async () => {
    agentRequests.mockResolvedValue([PENDING]);
    freshAuth.mockImplementationOnce(async () => false);
    render(<GpuAgentRequestBanner projectId="project-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve this launch" }),
    );
    await waitFor(() => expect(freshAuth).toHaveBeenCalled());
    expect(approveAgentRequest).not.toHaveBeenCalled();
  });

  it("declines without a fresh sign-in", async () => {
    agentRequests.mockResolvedValueOnce([PENDING]).mockResolvedValue([]);
    denyAgentRequest.mockResolvedValue({ state: "denied" });
    render(<GpuAgentRequestBanner projectId="project-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(denyAgentRequest).toHaveBeenCalledWith({
        request_id: PENDING.request_id,
      }),
    );
    expect(freshAuth).not.toHaveBeenCalled();
  });

  it("shows the server's refusal, e.g. a request that changed", async () => {
    agentRequests.mockResolvedValue([PENDING]);
    approveAgentRequest.mockRejectedValue(
      new Error(
        "This request isn't the one you reviewed (it changed). Review it again.",
      ),
    );
    render(<GpuAgentRequestBanner projectId="project-1" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve this launch" }),
    );
    expect(
      await screen.findByText(/isn't the one you reviewed/),
    ).not.toBeNull();
  });

  it("says when the kill switch would refuse even an approved launch", async () => {
    agentRequests.mockResolvedValue([PENDING]);
    budget.mockResolvedValue({ paused: true, kill_switch: true });
    render(<GpuAgentRequestBanner projectId="project-1" />);
    expect(
      await screen.findByText(/paused by your kill switch/),
    ).not.toBeNull();
  });

  it("revokes an active approval after saying it terminates the pod", async () => {
    agentRequests.mockResolvedValueOnce([ACTIVE]).mockResolvedValue([]);
    revokeAgentGrant.mockResolvedValue({ state: "revoked" });
    render(<GpuAgentRequestBanner projectId="project-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(
      await screen.findByText(/CoCalc terminates the pod it launched/),
    ).not.toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke and terminate" }),
    );
    await waitFor(() =>
      expect(revokeAgentGrant).toHaveBeenCalledWith({ grant_id: "grant-1" }),
    );
  });

  it("refetches when told the project's GPU requests changed", async () => {
    agentRequests.mockResolvedValueOnce([]).mockResolvedValue([PENDING]);
    render(<GpuAgentRequestBanner projectId="project-1" />);
    await waitFor(() => expect(agentRequests).toHaveBeenCalledTimes(1));
    act(() => {
      publishProjectDetailInvalidation({
        project_id: "project-1",
        fields: [GPU_AGENT_REQUESTS_PROJECT_DETAIL_FIELD],
      });
    });
    expect(
      await screen.findByRole("button", { name: "Approve this launch" }),
    ).not.toBeNull();
  });
});
