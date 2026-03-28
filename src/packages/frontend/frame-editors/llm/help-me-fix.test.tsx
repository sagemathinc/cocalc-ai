import { render, screen, waitFor } from "@testing-library/react";
import HelpMeFix from "./help-me-fix";

let languageModelEnabled = true;

jest.mock("antd", () => {
  const Div = ({ children }: any) => <div>{children}</div>;
  return {
    Alert: Div,
    Space: Div,
  };
});

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
  submitNavigatorPromptInWorkspaceChat: jest.fn(),
}));

jest.mock("./help-me-fix-button", () => ({
  __esModule: true,
  default: ({ mode, inputText }: any) => (
    <div data-testid={mode}>{String(inputText)}</div>
  ),
}));

jest.mock("./help-me-fix-utils", () => ({
  createMessage: ({ error, isHint }: any) =>
    `${isHint ? "hint" : "solution"}:${error}`,
  createNavigatorIntentMessage: jest.fn(),
  getHelp: jest.fn(),
}));

describe("HelpMeFix", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    languageModelEnabled = true;
  });

  it("recomputes visible prompts when rendering is temporarily disabled", async () => {
    const { rerender } = render(<HelpMeFix error="first error" />);

    languageModelEnabled = false;
    rerender(<HelpMeFix error="first error" />);

    languageModelEnabled = true;
    rerender(<HelpMeFix error="second error" />);

    await waitFor(() => {
      expect(screen.getByTestId("solution").textContent).toBe(
        "solution:second error",
      );
      expect(screen.getByTestId("hint").textContent).toBe("hint:second error");
    });
  });
});
