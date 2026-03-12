import { act, render, screen, waitFor } from "@testing-library/react";
import { useCodexPaymentSource } from "../use-codex-payment-source";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        system: {
          getCodexPaymentSource: jest.fn(),
        },
      },
    },
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function TestComponent({ projectId }: { projectId?: string }) {
  const { paymentSource, error, loading } = useCodexPaymentSource({
    projectId,
    enabled: true,
    pollMs: 60_000,
  });
  return (
    <div>
      <span data-testid="source">{paymentSource?.source ?? ""}</span>
      <span data-testid="error">{error}</span>
      <span data-testid="loading">{loading ? "yes" : "no"}</span>
    </div>
  );
}

describe("useCodexPaymentSource", () => {
  const getCodexPaymentSourceMock = webapp_client.conat_client.hub.system
    .getCodexPaymentSource as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("clears the old project source while a new project is loading", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    getCodexPaymentSourceMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(<TestComponent projectId="project-1" />);

    await act(async () => {
      first.resolve({ source: "subscription" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("source").textContent).toBe("subscription");
    });

    rerender(<TestComponent projectId="project-2" />);

    expect(screen.getByTestId("source").textContent).toBe("");
    expect(screen.getByTestId("error").textContent).toBe("");

    await act(async () => {
      second.resolve({ source: "project-api-key" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("source").textContent).toBe("project-api-key");
    });
  });
});
