/** @jest-environment jsdom */

/*
After a project restart the tab's Jupyter client socket can still look ready
while nothing serves it, until its keepalive notices (up to 75 s).  A kernel
status refresh used to retry on that dead client the whole time, so anything
waiting on it (e.g., clearing a run the restart killed) waited too.
*/

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      registerReconnectResource: jest.fn(() => ({
        requestReconnect: jest.fn(),
        close: jest.fn(),
      })),
      projectConat: jest.fn(),
    },
  },
}));

jest.mock("@cocalc/conat/project/jupyter/run-code", () => ({
  jupyterClient: jest.fn(),
}));

jest.mock("../widgets/manager", () => ({
  WidgetManager: class WidgetManager {},
}));

import { JupyterActions } from "../browser-actions";

describe("refreshing the kernel status", () => {
  it("drops a client whose status request fails and asks a fresh one", async () => {
    const actions: any = new JupyterActions("jupyter-test", {
      getStore: jest.fn(() => undefined),
      removeActions: jest.fn(),
    } as any);
    actions._state = "ready";
    actions.runDebug = jest.fn();
    actions.shouldWaitForProjectForPassiveJupyterWork = () => true;
    actions.waitUntilProjectIsRunning = jest.fn(async () => {});
    const settings: any = {};
    actions.set_runtime_settings = (x: any) => Object.assign(settings, x);

    const dead = {
      socket: { state: "ready" },
      getKernelStatus: jest.fn(async () => {
        throw Error("timeout");
      }),
      close: jest.fn(),
    };
    const fresh = {
      socket: { state: "ready" },
      getKernelStatus: jest.fn(async () => ({
        backend_state: "off",
        kernel_state: "idle",
      })),
      close: jest.fn(),
    };
    actions.jupyterClient = dead;
    actions.getJupyterClient = jest.fn(async () => {
      actions.jupyterClient ??= fresh;
      return actions.jupyterClient;
    });

    await actions.refreshKernelStatus();

    expect(dead.getKernelStatus).toHaveBeenCalledWith({ timeout: 10_000 });
    expect(dead.close).toHaveBeenCalled();
    expect(fresh.getKernelStatus).toHaveBeenCalled();
    expect(settings).toEqual({ backend_state: "off", kernel_state: "idle" });
  });
});
