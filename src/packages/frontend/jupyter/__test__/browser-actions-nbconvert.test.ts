/** @jest-environment jsdom */
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("../widgets/manager", () => ({ WidgetManager: class {} }));
import { JupyterActions } from "../browser-actions";
import { EXPORT_STARTUP_TIMEOUT_MS } from "../export-startup";

function setup(start = jest.fn().mockResolvedValue(undefined)) {
  let state: any;
  const target: any = {
    jupyterApi: jest.fn(async () => ({ start })),
    is_closed: jest.fn(() => false),
    nbconvert_has_started: () => ["start", "run"].includes(state?.get("state")),
    nbconvertToHtml: jest.fn(),
    set_runtime_nbconvert: jest.fn(),
    setState: jest.fn(({ nbconvert }) => {
      state = nbconvert;
    }),
    store: { get: () => state },
    syncdb: {},
    syncdbPath: "notebook.syncdb",
  };
  return {
    target,
    start,
    state: () => state,
    run: () =>
      JupyterActions.prototype.nbconvert.call(target, ["--to", "script"]),
    cancel: () =>
      JupyterActions.prototype.cancel_nbconvert_startup.call(target),
  };
}

describe("JupyterActions nbconvert startup", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it("publishes exactly once only after backend startup", async () => {
    let resolve!: () => void;
    const test = setup(
      jest.fn(
        () =>
          new Promise<void>((r) => {
            resolve = r;
          }),
      ),
    );
    test.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(test.state().get("state")).toBe("start");
    expect(test.target.set_runtime_nbconvert).not.toHaveBeenCalled();
    resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(test.target.set_runtime_nbconvert).toHaveBeenCalledTimes(1);
    expect(test.target.set_runtime_nbconvert).toHaveBeenCalledWith({
      args: ["--to", "script"],
      state: "start",
      error: null,
    });
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each([
    Object.assign(new Error("denied"), { code: 403 }),
    new Error("permission denied"),
  ])("fails immediately on denied access: %s", async (error) => {
    const test = setup(jest.fn().mockRejectedValue(error));
    test.run();
    await jest.advanceTimersByTimeAsync(EXPORT_STARTUP_TIMEOUT_MS);
    expect(test.start).toHaveBeenCalledTimes(1);
    expect(test.state().get("error")).toContain(
      "Check your sign-in and project access",
    );
    expect(test.state().get("state")).toBe("done");
    expect(test.target.set_runtime_nbconvert).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it("bounds repeated unavailable-backend failures and retains the cause", async () => {
    const test = setup(
      jest.fn().mockRejectedValue(new Error("no subscribers")),
    );
    test.run();
    await jest.advanceTimersByTimeAsync(EXPORT_STARTUP_TIMEOUT_MS);
    expect(test.state().get("error")).toContain("timed out");
    expect(test.state().get("error")).toContain("no subscribers");
    expect(test.target.set_runtime_nbconvert).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it("retries transient startup failure before publishing", async () => {
    const test = setup(
      jest
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue(undefined),
    );
    test.run();
    await jest.advanceTimersByTimeAsync(3000);
    expect(test.start).toHaveBeenCalledTimes(2);
    expect(test.target.set_runtime_nbconvert).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each(["timeout", "cancel"])(
    "ignores late responses after %s and permits a fresh attempt",
    async (mode) => {
      let resolve!: () => void;
      const test = setup(
        jest
          .fn()
          .mockImplementationOnce(
            () =>
              new Promise<void>((r) => {
                resolve = r;
              }),
          )
          .mockResolvedValue(undefined),
      );
      test.run();
      await jest.advanceTimersByTimeAsync(0);
      if (mode === "cancel") test.cancel();
      else await jest.advanceTimersByTimeAsync(EXPORT_STARTUP_TIMEOUT_MS);
      expect(test.state().get("state")).toBe("done");
      test.run();
      await jest.advanceTimersByTimeAsync(0);
      resolve();
      await jest.advanceTimersByTimeAsync(EXPORT_STARTUP_TIMEOUT_MS);
      expect(test.target.set_runtime_nbconvert).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it("does not publish after editor closure", async () => {
    const test = setup();
    test.run();
    test.target.is_closed.mockReturnValue(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(test.target.set_runtime_nbconvert).not.toHaveBeenCalled();
  });

  it("does not start a backend when API lookup resolves after the deadline", async () => {
    const test = setup();
    let resolve!: (api: any) => void;
    test.target.jupyterApi.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    test.run();
    await jest.advanceTimersByTimeAsync(EXPORT_STARTUP_TIMEOUT_MS);
    resolve({ start: test.start });
    await jest.advanceTimersByTimeAsync(0);
    expect(test.start).not.toHaveBeenCalled();
    expect(test.target.set_runtime_nbconvert).not.toHaveBeenCalled();
  });
  it("does not cancel already submitted conversions", async () => {
    const test = setup();
    test.run();
    await jest.advanceTimersByTimeAsync(0);
    test.cancel();
    expect(test.state().get("state")).toBe("start");
    expect(test.target.set_runtime_nbconvert).toHaveBeenCalledTimes(1);
  });
  it("reports a disconnected notebook locally", () => {
    const test = setup();
    test.target.syncdb = undefined;
    test.run();
    expect(test.state().get("error")).toContain("not connected");
    expect(test.start).not.toHaveBeenCalled();
  });
  it("leaves browser-print export independent of backend startup", () => {
    const test = setup();
    JupyterActions.prototype.nbconvert.call(test.target, [
      "--to",
      "cocalc-pdf",
    ]);
    expect(test.target.nbconvertToHtml).toHaveBeenCalledTimes(1);
    expect(test.target.jupyterApi).not.toHaveBeenCalled();
  });
});
