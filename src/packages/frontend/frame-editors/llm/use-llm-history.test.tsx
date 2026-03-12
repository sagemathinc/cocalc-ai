import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { EventEmitter } from "events";
import { resetLLMHistoryForTests, useLLMHistory } from "./use-llm-history";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      dstream: jest.fn(),
    },
  },
}));

class FakeDStream extends EventEmitter {
  private entries: { type: string; prompt: string }[] = [];

  getAll() {
    return [...this.entries];
  }

  push(entry: { type: string; prompt: string }) {
    this.entries.push(entry);
    this.emit("change", entry);
  }

  async delete() {
    this.entries = [];
  }

  setMaxListeners(n: number) {
    super.setMaxListeners(n);
    return this;
  }
}

function TestComponent() {
  const { prompts, addPrompt, clearHistory } = useLLMHistory("general");
  return (
    <div>
      <button onClick={() => void addPrompt("alpha")}>add-alpha</button>
      <button onClick={() => void addPrompt("beta")}>add-beta</button>
      <button onClick={() => void clearHistory()}>clear</button>
      <span data-testid="prompts">{prompts.join(",")}</span>
    </div>
  );
}

describe("useLLMHistory", () => {
  const getStoreMock = redux.getStore as jest.Mock;
  const dstreamMock = webapp_client.conat_client.dstream as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    resetLLMHistoryForTests();
    getStoreMock.mockReturnValue({
      async_wait: async () => {},
      get_account_id: () => "account-1",
    });
  });

  it("re-subscribes to a new shared stream after clearing history", async () => {
    const first = new FakeDStream();
    const second = new FakeDStream();
    dstreamMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    render(<TestComponent />);

    await act(async () => {
      fireEvent.click(screen.getByText("add-alpha"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("prompts").textContent).toBe("alpha");
    });

    await act(async () => {
      fireEvent.click(screen.getByText("clear"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("prompts").textContent).toBe("");
    });

    await act(async () => {
      fireEvent.click(screen.getByText("add-beta"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("prompts").textContent).toBe("beta");
    });
  });
});
