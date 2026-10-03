/** @jest-environment jsdom */
jest.mock("@cocalc/frontend/webapp-client", () => ({ webapp_client: {} }));
jest.mock("../widgets/manager", () => ({ WidgetManager: class {} }));
jest.mock("../download-html", () => ({ downloadHTML: jest.fn() }));
import { JupyterActions } from "../browser-actions";
import { downloadHTML } from "../download-html";
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
    expect(test.target.nbconvertToHtml).toHaveBeenCalledWith("cocalc-pdf");
    expect(test.target.jupyterApi).not.toHaveBeenCalled();
  });
});

describe("local HTML and PDF delivery", () => {
  function actions(overrides: object) {
    return Object.assign(
      new JupyterActions("export-test", {
        getStore: jest.fn(() => undefined),
        removeActions: jest.fn(),
      } as any),
      { isClosed: jest.fn(() => false) },
      overrides,
    );
  }
  afterEach(() => jest.restoreAllMocks());
  it.each(["resolve", "reject"])(
    "abandons printing after closure during HTML %s",
    async (outcome) => {
      let resolve!: (html: string) => void;
      let reject!: (error: Error) => void;
      const popup: any = { close: jest.fn(), print: jest.fn() };
      jest.spyOn(window, "open").mockReturnValue(popup);
      const isClosed = jest.fn(() => false);
      const target = actions({
        isClosed,
        toHTML: jest.fn(
          () =>
            new Promise<string>((yes, no) => {
              resolve = yes;
              reject = no;
            }),
        ),
        setState: jest.fn(),
      });
      const pending = target.nbconvertToHtml("cocalc-pdf");
      isClosed.mockReturnValue(true);
      if (outcome === "resolve") resolve("html");
      else reject(new Error("closed during export"));
      await pending;
      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(popup.print).not.toHaveBeenCalled();
      expect(target.setState).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["resolve", "reject"])(
    "abandons printing after closure during image %s",
    async (outcome) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const popup: any = {
        document: {
          open: jest.fn(),
          write: jest.fn(),
          close: jest.fn(),
          images: [
            {
              naturalWidth: 640,
              decode: () =>
                new Promise<void>((yes, no) => {
                  resolve = yes;
                  reject = no;
                }),
            },
          ],
        },
        close: jest.fn(),
        print: jest.fn(),
      };
      jest.spyOn(window, "open").mockReturnValue(popup);
      const isClosed = jest.fn(() => false);
      const target = actions({
        isClosed,
        toHTML: jest.fn(async () => "html"),
        setState: jest.fn(),
      });
      await target.nbconvertToHtml("cocalc-pdf");
      const pending = popup.onload();
      isClosed.mockReturnValue(true);
      if (outcome === "resolve") resolve();
      else reject(new Error("closed during decode"));
      await pending;
      expect(popup.print).not.toHaveBeenCalled();
      expect(popup.close).toHaveBeenCalledTimes(1);
      expect(popup.onload).toBeNull();
      expect(target.setState).toHaveBeenCalledTimes(1);
    },
  );
  it("routes HTML to a download, not printing or backend conversion", async () => {
    const target = actions({
      path: "/home/user/My notebook.ipynb",
      toHTML: jest.fn(async () => "<html>notebook</html>"),
      setState: jest.fn(),
    });
    const open = jest.spyOn(window, "open");
    await target.nbconvertToHtml("cocalc-html");
    expect(downloadHTML).toHaveBeenCalledWith(
      "<html>notebook</html>",
      "My notebook.html",
    );
    expect(open).not.toHaveBeenCalled();
    expect(target.setState).toHaveBeenLastCalledWith({
      nbconvert: expect.objectContaining({
        state: "done",
        error: "",
        args: ["--to", "cocalc-html"],
      }),
    });
  });
  it("retains the PDF print-window flow", async () => {
    const popup: any = {
      document: {
        open: jest.fn(),
        write: jest.fn(),
        close: jest.fn(),
        images: [],
      },
      print: jest.fn(),
      close: jest.fn(),
    };
    jest.spyOn(window, "open").mockReturnValue(popup);
    const target = actions({
      toHTML: jest.fn(async () => "<html>print</html>"),
      setState: jest.fn(),
    });
    await target.nbconvertToHtml("cocalc-pdf");
    expect(popup.document.write).toHaveBeenCalledWith("<html>print</html>");
    await popup.onload();
    expect(popup.print).toHaveBeenCalledTimes(1);
    popup.onafterprint();
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
  it("waits for embedded plot decoding before printing", async () => {
    let decoded!: () => void;
    const image = {
      complete: true,
      naturalWidth: 640,
      decode: jest.fn(
        () =>
          new Promise<void>((r) => {
            decoded = r;
          }),
      ),
    };
    const popup: any = {
      document: {
        open: jest.fn(),
        write: jest.fn(),
        close: jest.fn(),
        images: [image],
      },
      print: jest.fn(),
      close: jest.fn(),
    };
    jest.spyOn(window, "open").mockReturnValue(popup);
    const target = actions({
      toHTML: jest.fn(
        async () => '<html><img src="data:image/png;base64,plot"></html>',
      ),
      setState: jest.fn(),
    });
    await target.nbconvertToHtml("cocalc-pdf");
    const ready = popup.onload();
    expect(image.decode).toHaveBeenCalledTimes(1);
    expect(popup.print).not.toHaveBeenCalled();
    decoded();
    await ready;
    expect(popup.print).toHaveBeenCalledTimes(1);
  });
  it("handles a popup that loads and finishes printing synchronously", async () => {
    const popup: any = {
      document: {
        open: jest.fn(),
        write: jest.fn(),
        close: jest.fn(() => popup.onload?.()),
        images: [],
      },
      print: jest.fn(() => popup.onafterprint?.()),
      close: jest.fn(),
    };
    jest.spyOn(window, "open").mockReturnValue(popup);
    const target = actions({
      toHTML: jest.fn(async () => "<html>print</html>"),
      setState: jest.fn(),
    });
    await target.nbconvertToHtml("cocalc-pdf");
    await popup.onload();
    expect(popup.print).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
  it("prints an already loaded popup once even if load is delivered later", async () => {
    const popup: any = {
      document: {
        open: jest.fn(),
        write: jest.fn(),
        close: jest.fn(),
        readyState: "complete",
        images: [],
      },
      print: jest.fn(),
      close: jest.fn(),
    };
    jest.spyOn(window, "open").mockReturnValue(popup);
    const target = actions({
      toHTML: jest.fn(async () => "<html>print</html>"),
      setState: jest.fn(),
    });
    await target.nbconvertToHtml("cocalc-pdf");
    expect(popup.print).toHaveBeenCalledTimes(1);
    await popup.onload();
    expect(popup.print).toHaveBeenCalledTimes(1);
  });
  it("surfaces HTML delivery failure in the conversion state", async () => {
    (downloadHTML as jest.Mock).mockImplementationOnce(() => {
      throw Error("delivery failed");
    });
    const target = actions({
      path: "test.ipynb",
      toHTML: jest.fn(async () => "html"),
      setState: jest.fn(),
    });
    await target.nbconvertToHtml("cocalc-html");
    expect(target.setState).toHaveBeenLastCalledWith({
      nbconvert: expect.objectContaining({
        state: "done",
        error: "Error: delivery failed",
      }),
    });
  });
  it("opens the print window before asynchronous HTML generation", async () => {
    let resolve!: (html: string) => void;
    const popup: any = {
      document: {
        open: jest.fn(),
        write: jest.fn(),
        close: jest.fn(),
        images: [],
      },
      close: jest.fn(),
      print: jest.fn(),
    };
    const open = jest.spyOn(window, "open").mockReturnValue(popup);
    const target = actions({
      toHTML: jest.fn(
        () =>
          new Promise<string>((r) => {
            resolve = r;
          }),
      ),
      setState: jest.fn(),
    });
    const pending = target.nbconvertToHtml("cocalc-pdf");
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.document.write).not.toHaveBeenCalled();
    resolve("<html>print</html>");
    await pending;
    await popup.onload();
    expect(popup.print).toHaveBeenCalledTimes(1);
  });
  it("closes the reserved popup when HTML generation fails", async () => {
    const popup: any = { close: jest.fn() };
    jest.spyOn(window, "open").mockReturnValue(popup);
    const target = actions({
      toHTML: jest.fn().mockRejectedValue(new Error("export failed")),
      setState: jest.fn(),
    });
    await target.nbconvertToHtml("cocalc-pdf");
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(target.setState).toHaveBeenLastCalledWith({
      nbconvert: expect.objectContaining({
        error: "Error: export failed",
        state: "done",
      }),
    });
  });
  it("reports decoding failures instead of printing without the image", async () => {
    const popup: any = {
      document: {
        open: jest.fn(),
        write: jest.fn(),
        close: jest.fn(),
        images: [{ decode: () => Promise.reject(Error("bad image")) }],
      },
      close: jest.fn(),
      print: jest.fn(),
    };
    jest.spyOn(window, "open").mockReturnValue(popup);
    const target = actions({
      toHTML: jest.fn(async () => "html"),
      setState: jest.fn(),
    });
    await target.nbconvertToHtml("cocalc-pdf");
    await popup.onload();
    expect(popup.print).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(target.setState).toHaveBeenLastCalledWith({
      nbconvert: expect.objectContaining({
        error: "Error: bad image",
        state: "done",
      }),
    });
  });
});
