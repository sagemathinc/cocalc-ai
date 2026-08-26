/** @jest-environment jsdom */

const notificationOpen = jest.fn();
const notificationError = jest.fn();
const trackingLogError = jest.fn();

jest.mock("antd", () => ({
  notification: {
    open: (...args: any[]) => notificationOpen(...args),
    error: (...args: any[]) => notificationError(...args),
    success: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
  },
}));

jest.mock("./webapp-client", () => ({
  webapp_client: {
    tracking_client: {
      log_error: (...args: any[]) => trackingLogError(...args),
    },
  },
}));

describe("alert_message", () => {
  beforeEach(() => {
    jest.resetModules();
    notificationOpen.mockClear();
    notificationError.mockClear();
    trackingLogError.mockClear();
  });

  it("deduplicates identical string alerts within five seconds", async () => {
    const { alert_message } = await import("./alerts");

    alert_message({ type: "default", message: "Unable to load hosts." });
    alert_message({ type: "default", message: "Unable to load hosts." });

    expect(notificationOpen).toHaveBeenCalledTimes(1);
  });

  it("still forwards distinct alerts separately", async () => {
    const { alert_message } = await import("./alerts");

    alert_message({ type: "default", message: "Unable to load hosts." });
    alert_message({ type: "default", message: "Another warning." });

    expect(notificationOpen).toHaveBeenCalledTimes(2);
  });

  it("normalizes backend error text for display but logs the raw message", async () => {
    const { alert_message } = await import("./alerts");
    const raw =
      "Error: Error: not authorized - callHub: subject='hub.account.user', name='projects.start', code='not_authorized'";

    alert_message({ type: "error", message: raw });

    expect(notificationError).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "not authorized",
      }),
    );
    expect(trackingLogError).toHaveBeenCalledWith(raw);
  });
  it("renders a react-element message and logs the plain-text version", async () => {
    const { alert_message } = await import("./alerts");
    const { createElement } = await import("react");
    const node = createElement("div", null, "boom");

    alert_message({
      type: "error",
      title: "paper.tex",
      message: node,
      trackingMessage: "Building the document failed. Runaway argument?",
    });

    expect(notificationError).toHaveBeenCalledTimes(1);
    expect(notificationError.mock.calls[0][0].description).toBe(node);
    expect(trackingLogError).toHaveBeenCalledWith(
      "Building the document failed. Runaway argument?",
    );
  });

  it("deduplicates identical react-element alerts via their tracking text", async () => {
    const { alert_message } = await import("./alerts");
    const { createElement } = await import("react");
    const text =
      "It is not possible to generate a useful PDF file. Runaway argument?";

    for (let i = 0; i < 2; i++) {
      alert_message({
        type: "error",
        title: "paper.tex",
        // a distinct element each time, as two separate builds would produce
        message: createElement("div", null, `boom ${i}`),
        trackingMessage: text,
      });
    }

    expect(notificationError).toHaveBeenCalledTimes(1);
  });

  it("never hands a non-string message to error tracking", async () => {
    const { alert_message } = await import("./alerts");
    const { createElement } = await import("react");

    // no trackingMessage: log_error JSON.stringify()s whatever it gets, which
    // throws on a react element, so it must fall back to the title instead.
    alert_message({
      type: "error",
      title: "paper.tex",
      message: createElement("div", null, "boom"),
    });

    expect(notificationError).toHaveBeenCalledTimes(1);
    expect(trackingLogError).toHaveBeenCalledWith("paper.tex");
  });
});
