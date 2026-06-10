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
});
