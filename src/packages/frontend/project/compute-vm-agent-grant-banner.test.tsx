import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const listAgentGrants = jest.fn();
const approveAgentGrant = jest.fn();
const revokeAgentGrant = jest.fn();

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (action: () => Promise<void>) => {
      await action();
      return true;
    },
    freshAuthModalProps: {},
  }),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        compute: {
          listAgentGrants: (...args: any[]) => listAgentGrants(...args),
          approveAgentGrant: (...args: any[]) => approveAgentGrant(...args),
          revokeAgentGrant: (...args: any[]) => revokeAgentGrant(...args),
        },
      },
    },
  },
}));

import { ComputeVmAgentGrantBanner } from "./compute-vm-agent-grant-banner";
import { publishProjectDetailInvalidation } from "./use-project-field";

const pendingGrant = {
  grant_id: "grant-1",
  metadata: {
    pending_request: {
      action: "availability",
      operation: "start-vm",
      vm_id: "12345678-abcd",
      hourly_usd: 0.25,
    },
  },
};

describe("ComputeVmAgentGrantBanner", () => {
  beforeEach(() => {
    listAgentGrants.mockReset();
    approveAgentGrant.mockReset();
    revokeAgentGrant.mockReset();
  });

  it("surfaces and approves a pending grant without visiting the VMs page", async () => {
    listAgentGrants.mockResolvedValueOnce([pendingGrant]).mockResolvedValue([]);
    approveAgentGrant.mockResolvedValue(undefined);

    const { unmount } = render(
      <ComputeVmAgentGrantBanner projectId="project-1" />,
    );
    const allow = await screen.findByRole("button", {
      name: "Allow start/stop for this turn",
    });
    expect(screen.getByText(/\$0.250\/hour maximum/)).not.toBeNull();

    fireEvent.click(allow);

    await waitFor(() =>
      expect(approveAgentGrant).toHaveBeenCalledWith({
        grant_id: "grant-1",
        browser_id: "browser-1",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Allow start/stop for this turn",
        }),
      ).toBeNull(),
    );
    expect(listAgentGrants).toHaveBeenCalledWith({ project_id: "project-1" });
    unmount();
  });

  it("denies a pending grant from the project banner", async () => {
    listAgentGrants.mockResolvedValueOnce([pendingGrant]).mockResolvedValue([]);
    revokeAgentGrant.mockResolvedValue(undefined);

    const { unmount } = render(
      <ComputeVmAgentGrantBanner projectId="project-1" />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    await waitFor(() =>
      expect(revokeAgentGrant).toHaveBeenCalledWith({ grant_id: "grant-1" }),
    );
    unmount();
  });

  it("appears when the account feed invalidates agent grants", async () => {
    listAgentGrants.mockResolvedValueOnce([]).mockResolvedValue([pendingGrant]);

    const { unmount } = render(
      <ComputeVmAgentGrantBanner projectId="project-1" />,
    );
    await waitFor(() => expect(listAgentGrants).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", {
        name: "Allow start/stop for this turn",
      }),
    ).toBeNull();

    act(() => {
      publishProjectDetailInvalidation({
        project_id: "project-1",
        fields: ["compute_agent_grants"],
      });
    });

    expect(
      await screen.findByRole("button", {
        name: "Allow start/stop for this turn",
      }),
    ).not.toBeNull();
    expect(listAgentGrants).toHaveBeenCalledTimes(2);
    unmount();
  });
});
