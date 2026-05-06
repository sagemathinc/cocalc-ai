import { EventEmitter } from "events";
import { act, render } from "@testing-library/react";
import { useProjectActiveOperation } from "./use-project-active-op";

jest.useFakeTimers();

jest.mock("@cocalc/frontend/webapp-client", () => {
  const { EventEmitter } = require("events");
  const conatClient = Object.assign(new EventEmitter(), {
    removeListener: EventEmitter.prototype.removeListener,
    hub: {
      projects: {
        getProjectActiveOperation: jest.fn(),
      },
    },
  });
  return {
    webapp_client: {
      conat_client: conatClient,
    },
  };
});

jest.mock("./use-project-field", () => ({
  createProjectFieldState: jest.fn(() => ({ field: "active_op" })),
  getCachedProjectFieldValue: jest.fn(),
  useProjectField: jest.fn(),
}));

const { webapp_client } = jest.requireMock(
  "@cocalc/frontend/webapp-client",
) as {
  webapp_client: {
    conat_client: EventEmitter & {
      hub: {
        projects: {
          getProjectActiveOperation: jest.Mock;
        };
      };
      removeListener: typeof EventEmitter.prototype.removeListener;
    };
  };
};

const { useProjectField, getCachedProjectFieldValue } = jest.requireMock(
  "./use-project-field",
) as {
  useProjectField: jest.Mock;
  getCachedProjectFieldValue: jest.Mock;
};

const getProjectActiveOperation =
  webapp_client.conat_client.hub.projects.getProjectActiveOperation;

function TestComponent() {
  useProjectActiveOperation("project-1");
  return null;
}

function PollingTestComponent({ pollWhile }: { pollWhile?: boolean }) {
  useProjectActiveOperation("project-1", { pollWhile });
  return null;
}

describe("useProjectActiveOperation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    webapp_client.conat_client.removeAllListeners();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    useProjectField.mockReturnValue({
      value: null,
      refresh: jest.fn(),
      setValue: jest.fn(),
    });
  });

  it("keeps the cached active operation when the hub call fails", async () => {
    getProjectActiveOperation.mockRejectedValue(
      new Error("hub timeout during reconnect"),
    );
    getCachedProjectFieldValue.mockReturnValue({
      kind: "project-start",
      status: "running",
    });

    render(<TestComponent />);

    const [{ fetch }] = useProjectField.mock.calls[0];
    await expect(fetch("project-1")).resolves.toEqual({
      kind: "project-start",
      status: "running",
    });
  });

  it("returns null when there is no cached active operation", async () => {
    getProjectActiveOperation.mockRejectedValue(new Error("hub timeout"));
    getCachedProjectFieldValue.mockReturnValue(undefined);

    render(<TestComponent />);

    const [{ fetch }] = useProjectField.mock.calls[0];
    await expect(fetch("project-1")).resolves.toBeNull();
  });

  it("does not poll while idle", () => {
    const refresh = jest.fn();
    useProjectField.mockReturnValue({
      value: null,
      refresh,
      setValue: jest.fn(),
    });

    render(<PollingTestComponent pollWhile={false} />);
    jest.advanceTimersByTime(12_000);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not poll while the browser tab is hidden", () => {
    const refresh = jest.fn();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    useProjectField.mockReturnValue({
      value: {
        kind: "project-start",
        status: "running",
      },
      refresh,
      setValue: jest.fn(),
    });

    render(<PollingTestComponent pollWhile />);
    jest.advanceTimersByTime(12_000);

    expect(refresh).not.toHaveBeenCalled();
  });

  it("polls while the page asks for active monitoring", () => {
    const refresh = jest.fn();
    useProjectField.mockReturnValue({
      value: null,
      refresh,
      setValue: jest.fn(),
    });

    render(<PollingTestComponent pollWhile />);
    jest.advanceTimersByTime(12_000);

    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("keeps polling while an active operation is cached", () => {
    const refresh = jest.fn();
    useProjectField.mockReturnValue({
      value: {
        kind: "project-start",
        status: "running",
      },
      refresh,
      setValue: jest.fn(),
    });

    render(<PollingTestComponent pollWhile={false} />);
    jest.advanceTimersByTime(8_000);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes once when conat reconnects even if polling is idle", () => {
    const refresh = jest.fn();
    useProjectField.mockReturnValue({
      value: null,
      refresh,
      setValue: jest.fn(),
    });

    render(<PollingTestComponent pollWhile={false} />);
    webapp_client.conat_client.emit("connected");

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on reconnect while the tab is hidden", () => {
    const refresh = jest.fn();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    useProjectField.mockReturnValue({
      value: null,
      refresh,
      setValue: jest.fn(),
    });

    render(<PollingTestComponent pollWhile={false} />);
    webapp_client.conat_client.emit("connected");

    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes once when a hidden tab becomes visible", () => {
    const refresh = jest.fn();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    useProjectField.mockReturnValue({
      value: null,
      refresh,
      setValue: jest.fn(),
    });

    render(<PollingTestComponent pollWhile={false} />);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
