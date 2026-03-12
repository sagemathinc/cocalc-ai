import { act, render, screen, waitFor } from "@testing-library/react";
import HelpMeFix from "./help-me-fix";

const getHelpMeFixTokenCounts = jest.fn();

let languageModelEnabled = true;

jest.mock("antd", () => {
  const Div = ({ children }: any) => <div>{children}</div>;
  return {
    Alert: Div,
    Space: Div,
  };
});

jest.mock("@cocalc/frontend/account/useLanguageModelSetting", () => ({
  useLanguageModelSetting: () => ["gpt-5", jest.fn()],
}));

jest.mock("@cocalc/frontend/components", () => ({
  AIAvatar: () => null,
}));

jest.mock("@cocalc/frontend/chat/use-codex-payment-source", () => ({
  useCodexPaymentSource: () => ({
    paymentSource: undefined,
  }),
}));

jest.mock("@cocalc/frontend/frame-editors/frame-tree/frame-context", () => ({
  useFrameContext: () => ({
    actions: { save: jest.fn() },
    path: "test.ipynb",
    project_id: "project-1",
    redux: {
      getStore: (name: string) => {
        if (name === "projects") {
          return {
            getIn: () => undefined,
            hasLanguageModelEnabled: () => languageModelEnabled,
          };
        }
        return {
          getIn: () => undefined,
        };
      },
    },
  }),
}));

jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  dispatchNavigatorPromptIntent: jest.fn(),
  submitNavigatorPromptToCurrentThread: jest.fn(),
}));

jest.mock("./help-me-fix-button", () => ({
  __esModule: true,
  default: ({ mode, tokens }: any) => (
    <div data-testid={mode}>{String(tokens)}</div>
  ),
}));

jest.mock("./help-me-fix-utils", () => ({
  createMessage: ({ error, isHint }: any) =>
    `${isHint ? "hint" : "solution"}:${error}`,
  createNavigatorIntentMessage: jest.fn(),
  getHelp: jest.fn(),
}));

jest.mock("./help-me-fix-tokens", () => ({
  getHelpMeFixTokenCounts: (...args: any[]) => getHelpMeFixTokenCounts(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("HelpMeFix", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    languageModelEnabled = true;
  });

  it("ignores stale token loads after rendering is temporarily disabled", async () => {
    const first = deferred<{ solutionTokens: number; hintTokens: number }>();
    const second = deferred<{ solutionTokens: number; hintTokens: number }>();
    getHelpMeFixTokenCounts
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { rerender } = render(<HelpMeFix error="first error" />);

    languageModelEnabled = false;
    rerender(<HelpMeFix error="first error" />);

    languageModelEnabled = true;
    rerender(<HelpMeFix error="second error" />);

    await act(async () => {
      second.resolve({ solutionTokens: 12, hintTokens: 3 });
      await second.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("solution").textContent).toBe("12");
      expect(screen.getByTestId("hint").textContent).toBe("3");
    });

    await act(async () => {
      first.resolve({ solutionTokens: 999, hintTokens: 888 });
      await first.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("solution").textContent).toBe("12");
      expect(screen.getByTestId("hint").textContent).toBe("3");
    });
  });
});
