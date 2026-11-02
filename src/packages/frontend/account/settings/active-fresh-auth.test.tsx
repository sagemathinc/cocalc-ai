/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { postAuthApi } from "@cocalc/frontend/auth/api";

import ActiveFreshAuth from "./active-fresh-auth";

jest.mock("@cocalc/frontend/auth/api", () => ({
  postAuthApi: jest.fn(),
}));

jest.mock("@cocalc/frontend/control-plane-origin", () => ({
  getControlPlaneOrigin: () => "https://control.example.com",
}));

const HOUR = 3600_000;

describe("ActiveFreshAuth", () => {
  beforeEach(() => {
    jest.mocked(postAuthApi).mockReset();
  });

  it("lists active verifications with the time left and ends one", async () => {
    let sessions = [
      {
        id: "a".repeat(32),
        current: true,
        fresh_auth_until: new Date(
          Date.now() + 72 * HOUR - 30_000,
        ).toISOString(),
        user_agent: "Firefox",
        ip_address: "203.0.113.5",
      },
      {
        id: "b".repeat(32),
        current: false,
        fresh_auth_until: new Date(Date.now() + 20 * 60_000).toISOString(),
        user_agent: "cocalc-cli",
      },
    ];
    jest
      .mocked(postAuthApi)
      .mockImplementation(async ({ endpoint, body }: any) => {
        if (endpoint === "auth/fresh-auth-sessions") {
          return { sessions };
        }
        if (endpoint === "auth/fresh-auth-end") {
          sessions = sessions.filter((s) => s.id !== body.id);
          return { ended: 1 };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      });

    render(<ActiveFreshAuth />);

    await waitFor(() => {
      expect(screen.getByText("71 h 59 min left")).toBeTruthy();
    });
    expect(screen.getByText("This browser")).toBeTruthy();
    expect(screen.getByText("Firefox from 203.0.113.5")).toBeTruthy();
    expect(screen.getByText(/^(19|20) min left$/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /End now/ })[1]);

    await waitFor(() => {
      expect(postAuthApi).toHaveBeenCalledWith({
        endpoint: "auth/fresh-auth-end",
        origin: "https://control.example.com",
        body: { id: "b".repeat(32) },
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("cocalc-cli")).toBeNull();
    });
    expect(screen.getByText("71 h 59 min left")).toBeTruthy();
  });

  it("says so when no verification is active", async () => {
    jest.mocked(postAuthApi).mockResolvedValue({ sessions: [] });
    render(<ActiveFreshAuth />);
    await waitFor(() => {
      expect(screen.getByText("No verification is active.")).toBeTruthy();
    });
  });
});
