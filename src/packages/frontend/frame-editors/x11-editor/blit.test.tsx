/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Blit } from "./blit";
import { BLIT_APP_ID, INSTALL_GRAPHICAL_APPS_COMMAND } from "./blit-app";
import userEvent from "@testing-library/user-event";

const execMock = jest.fn();
const getProjectAppOpenUrlMock = jest.fn();
const ensureRunningMock = jest.fn();
const stopAppMock = jest.fn();
const upsertAppSpecMock = jest.fn();

jest.mock("@cocalc/frontend/frame-editors/generic/client", () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));

jest.mock("@cocalc/frontend/project/app-server-open", () => ({
  getProjectAppOpenUrl: (...args: unknown[]) =>
    getProjectAppOpenUrlMock(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectApi: () => ({
        apps: {
          ensureRunning: (...args: unknown[]) => ensureRunningMock(...args),
          stopApp: (...args: unknown[]) => stopAppMock(...args),
          upsertAppSpec: (...args: unknown[]) => upsertAppSpecMock(...args),
        },
      }),
    },
  },
}));

describe("Blit graphical application setup", () => {
  beforeEach(() => {
    execMock.mockReset();
    ensureRunningMock.mockReset();
    getProjectAppOpenUrlMock.mockReset();
    stopAppMock.mockReset();
    upsertAppSpecMock.mockReset();
  });

  it.each(["is_current", "is_visible", "tab_is_visible"])(
    "disconnects hidden clients when %s changes without stopping applications",
    async (visibility) => {
      execMock.mockResolvedValue({ exit_code: 0, stderr: "", stdout: "" });
      upsertAppSpecMock.mockResolvedValue({ spec: { id: BLIT_APP_ID } });
      ensureRunningMock.mockResolvedValue({
        id: BLIT_APP_ID,
        state: "running",
      });
      getProjectAppOpenUrlMock.mockResolvedValue("https://example.test/blit/");
      const user = userEvent.setup();
      const view = (active: boolean) => (
        <>
          <Blit
            is_current
            project_id="project-id"
            {...{ [visibility]: active }}
          />
          <input aria-label="Chat message" />
        </>
      );
      const { rerender } = render(view(true));
      const iframe = await screen.findByTitle("Blit graphical applications");
      const src = iframe.getAttribute("src");
      iframe.focus();
      expect(iframe).toHaveFocus();

      rerender(view(false));
      expect(iframe).not.toBeInTheDocument();
      expect(screen.queryByTitle("Blit graphical applications")).toBeNull();
      const input = screen.getByRole("textbox", { name: "Chat message" });
      await user.click(input);
      await user.keyboard("Still typing in chat");
      expect(input).toHaveFocus();
      expect(input).toHaveValue("Still typing in chat");

      rerender(view(true));
      const reconnected = screen.getByTitle("Blit graphical applications");
      expect(reconnected).not.toBe(iframe);
      expect(reconnected).toHaveAttribute("src", src);
      expect(stopAppMock).not.toHaveBeenCalled();
      expect(ensureRunningMock).toHaveBeenCalledTimes(1);
      expect(upsertAppSpecMock).toHaveBeenCalledTimes(1);
    },
  );

  it("offers a keyboard-focusable package install when dependencies are missing", async () => {
    execMock
      .mockResolvedValueOnce({
        exit_code: 21,
        stderr: "",
        stdout: "missing-package:xwayland\n",
      })
      .mockImplementationOnce(() => new Promise(() => {}));

    render(<Blit is_current project_id="project-id" />);

    const install = await screen.findByRole("button", {
      name: "Install graphical application support",
    });
    install.focus();
    expect(install).toHaveFocus();
    fireEvent.click(install);

    await waitFor(() => expect(execMock).toHaveBeenCalledTimes(2));
    expect(execMock.mock.calls[1][0]).toMatchObject({
      args: ["-lc", INSTALL_GRAPHICAL_APPS_COMMAND],
      command: "bash",
      project_id: "project-id",
    });
  });

  it("restarts an existing compositor after installing new prerequisites", async () => {
    execMock
      .mockResolvedValueOnce({
        exit_code: 21,
        stderr: "",
        stdout: "missing-package:pipewire\n",
      })
      .mockResolvedValueOnce({ exit_code: 0, stderr: "", stdout: "" })
      .mockResolvedValueOnce({ exit_code: 0, stderr: "", stdout: "" });
    upsertAppSpecMock.mockResolvedValue({
      spec: {
        id: BLIT_APP_ID,
        kind: "service",
        proxy: { open_mode: "proxy" },
      },
    });
    stopAppMock.mockResolvedValue(undefined);
    ensureRunningMock.mockResolvedValue({
      id: BLIT_APP_ID,
      state: "running",
      url: "http://127.0.0.1:1234",
    });
    getProjectAppOpenUrlMock.mockResolvedValue("https://example.test/blit/");

    render(<Blit is_current project_id="project-id" />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Install graphical application support",
      }),
    );

    await waitFor(() => expect(stopAppMock).toHaveBeenCalledWith(BLIT_APP_ID));
    expect(upsertAppSpecMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: BLIT_APP_ID }),
    );
    expect(
      await screen.findByTitle("Blit graphical applications"),
    ).toBeInTheDocument();
  });

  it("stops the shared managed app and closes its iframe", async () => {
    execMock.mockResolvedValue({ exit_code: 0, stderr: "", stdout: "" });
    upsertAppSpecMock.mockResolvedValue({
      spec: {
        id: BLIT_APP_ID,
        kind: "service",
        proxy: { open_mode: "proxy" },
      },
    });
    ensureRunningMock.mockResolvedValue({
      id: BLIT_APP_ID,
      state: "running",
      url: "http://127.0.0.1:1234",
    });
    getProjectAppOpenUrlMock.mockResolvedValue("https://example.test/blit/");
    stopAppMock.mockResolvedValue(undefined);

    render(<Blit is_current project_id="project-id" />);

    expect(
      await screen.findByTitle("Blit graphical applications"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Shut down" }));
    const confirmation = await screen.findByRole("tooltip");
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Shut down" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByTitle("Blit graphical applications"),
      ).not.toBeInTheDocument(),
    );
    expect(upsertAppSpecMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        wake: expect.objectContaining({ enabled: false }),
      }),
    );
    await waitFor(() => expect(stopAppMock).toHaveBeenCalledWith(BLIT_APP_ID));
    expect(
      await screen.findByText("Graphical applications are shut down"),
    ).toBeVisible();
    expect(
      screen.queryByTitle("Blit graphical applications"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start graphical applications" }),
    ).toBeEnabled();
  });
});
