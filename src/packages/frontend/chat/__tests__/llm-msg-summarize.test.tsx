import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SummarizeThread } from "../llm-msg-summarize";

jest.mock("antd", () => ({
  Button: ({ children }: any) => <button type="button">{children}</button>,
  Collapse: ({ items }: any) => <div>{items?.[0]?.children}</div>,
  Switch: ({ checked, onChange }: any) => (
    <button type="button" onClick={() => onChange(!checked)}>
      switch
    </button>
  ),
}));

jest.mock("@cocalc/frontend/account/useLanguageModelSetting", () => ({
  useLanguageModelSetting: () => ["gpt-5", jest.fn()],
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useState: jest.requireActual("react").useState,
}));

jest.mock("@cocalc/frontend/components", () => ({
  Paragraph: ({ children }: any) => <div>{children}</div>,
  RawPrompt: ({ input }: any) => <div data-testid="prompt">{input}</div>,
  Tip: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("@cocalc/frontend/components/ai-avatar", () => () => null);

jest.mock("@cocalc/frontend/components/popconfirm-keyboard", () => ({
  __esModule: true,
  default: ({ onVisibilityChange, description, children }: any) => (
    <div>
      <button type="button" onClick={() => onVisibilityChange(true)}>
        open
      </button>
      <button type="button" onClick={() => onVisibilityChange(false)}>
        close
      </button>
      <div>{description()}</div>
      {children}
    </div>
  ),
}));

jest.mock("@cocalc/frontend/frame-editors/llm/llm-selector", () => ({
  __esModule: true,
  default: () => null,
  modelToName: (model: string) => model,
}));

jest.mock("@cocalc/frontend/misc/llm-cost-estimation", () => ({
  LLMCostEstimation: ({ tokens }: any) => (
    <div data-testid="tokens">{tokens}</div>
  ),
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => ({ project_id: "project-1" }),
}));

jest.mock("../access", () => ({
  field: (message: any, key: string) => message[key],
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("SummarizeThread", () => {
  it("clears and ignores stale summary info after the panel closes", async () => {
    const request = deferred<any>();
    const actions = {
      summarizeThread: jest.fn(() => request.promise),
    } as any;

    render(
      <SummarizeThread
        message={{ thread_id: "thread-1" } as any}
        actions={actions}
      />,
    );

    fireEvent.click(screen.getByText("open"));

    await waitFor(() => {
      expect(actions.summarizeThread).toHaveBeenCalledWith({
        model: "gpt-5",
        thread_id: "thread-1",
        returnInfo: true,
        short: true,
      });
    });

    fireEvent.click(screen.getByText("close"));

    await waitFor(() => {
      expect(screen.getByTestId("tokens").textContent).toBe("0");
      expect(screen.getByTestId("prompt").textContent).toBe("");
    });

    await act(async () => {
      request.resolve({
        tokens: 123,
        truncated: false,
        prompt: "stale prompt",
      });
      await request.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("tokens").textContent).toBe("0");
      expect(screen.getByTestId("prompt").textContent).toBe("");
    });
  });
});
