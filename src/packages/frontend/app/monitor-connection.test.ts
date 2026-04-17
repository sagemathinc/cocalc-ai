import { EventEmitter } from "events";

const alertMessage = jest.fn();
const setConnectionStatus = jest.fn();
const setPing = jest.fn();
const setConnectionQuality = jest.fn();
const setNewVersion = jest.fn();
const requestReconnect = jest.fn();

const webappClient = Object.assign(new EventEmitter(), {
  conat_client: {
    numConnectionAttempts: 0,
    requestReconnect,
  },
});

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: (...args: any[]) => alertMessage(...args),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: webappClient,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: jest.fn(() => ({
      set_connection_status: setConnectionStatus,
      set_ping: setPing,
      set_connection_quality: setConnectionQuality,
      set_new_version: setNewVersion,
    })),
    getStore: jest.fn((name: string) => {
      if (name === "page") {
        return {
          get: jest.fn((key: string) =>
            key === "connection_status" ? "connected" : undefined,
          ),
        };
      }
      return {
        get: jest.fn((key: string) =>
          key === "site_name" ? "CoCalc" : undefined,
        ),
      };
    }),
  },
}));

jest.mock("../feature", () => ({
  isMobile: { any: () => false },
}));

const consoleLog = jest.spyOn(console, "log").mockImplementation(() => {});

describe("monitor connection", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    webappClient.removeAllListeners();
    webappClient.conat_client.numConnectionAttempts = 0;
  });

  afterAll(() => {
    consoleLog.mockRestore();
  });

  it("warns about flaky connections without forcing a reconnect", async () => {
    const { init_connection } = await import("./monitor-connection");
    init_connection();

    webappClient.emit("disconnected");
    webappClient.emit("disconnected");
    webappClient.conat_client.numConnectionAttempts = 10;
    webappClient.emit("connecting");

    await jest.advanceTimersByTimeAsync(5000);

    expect(setConnectionStatus).toHaveBeenCalledWith(
      "connecting",
      expect.any(Date),
    );
    expect(setConnectionQuality).toHaveBeenCalledWith("flaky");
    expect(alertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info" }),
    );
    expect(requestReconnect).not.toHaveBeenCalled();
  });
});
