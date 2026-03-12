import { render, waitFor } from "@testing-library/react";
import { useCodexLog } from "../use-codex-log";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      conat: jest.fn(),
    },
  },
}));

class FakeSubscription {
  private closed = false;
  private wake?: () => void;

  close = jest.fn(() => {
    this.closed = true;
    this.wake?.();
  });

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

function TestComponent({ generating }: { generating: boolean }) {
  useCodexLog({
    enabled: true,
    generating,
    projectId: "project-1",
    logStore: "acp-log",
    logKey: "log-key",
    logSubject: "subject-1",
  });
  return null;
}

describe("useCodexLog", () => {
  const conatMock = webapp_client.conat_client.conat as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("does not subscribe to live events when the turn is idle", async () => {
    const subscribe = jest.fn();
    const get = jest.fn().mockResolvedValue([]);
    conatMock.mockReturnValue({
      subscribe,
      sync: {
        akv: () => ({ get }),
      },
    });

    render(<TestComponent generating={false} />);

    await waitFor(() => {
      expect(get).toHaveBeenCalledWith("log-key");
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("closes the live subscription when generating turns off", async () => {
    const subscription = new FakeSubscription();
    const subscribe = jest.fn().mockResolvedValue(subscription);
    const get = jest.fn().mockResolvedValue([]);
    conatMock.mockReturnValue({
      subscribe,
      sync: {
        akv: () => ({ get }),
      },
    });

    const { rerender } = render(<TestComponent generating={true} />);

    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledWith("subject-1");
    });

    rerender(<TestComponent generating={false} />);

    await waitFor(() => {
      expect(subscription.close).toHaveBeenCalled();
    });
  });
});
