import { render, screen } from "@testing-library/react";
import { AccountPreferencesAI } from "../account-preferences-ai";

const useTypedRedux = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (...args: any[]) => useTypedRedux(...args),
}));

jest.mock("antd", () => ({
  Alert: ({ children }: any) => <div>{children}</div>,
  Typography: {
    Title: ({ children }: any) => <div>{children}</div>,
    Paragraph: ({ children }: any) => <div>{children}</div>,
  },
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("../other-settings", () => ({
  OtherSettings: () => <div>OtherSettings</div>,
}));

jest.mock("../codex-credentials-panel", () => ({
  CodexCredentialsPanel: () => <div>CodexCredentialsPanel</div>,
}));

jest.mock("../codex-defaults-panel", () => ({
  CodexDefaultsPanel: () => <div>CodexDefaultsPanel</div>,
}));

jest.mock("../lite-ai-settings", () => ({
  __esModule: true,
  default: () => <div>LiteAISettings</div>,
}));

jest.mock("@cocalc/frontend/misc/llm-cost-estimation", () => ({
  LLMUsageStatus: () => <div>LLMUsageStatus</div>,
}));

describe("AccountPreferencesAI", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTypedRedux.mockImplementation((store: string, key: string) => {
      if (store === "account" && key === "other_settings") {
        return {};
      }
      if (store === "account" && key === "stripe_customer") {
        return null;
      }
      if (store === "customize" && key === "kucalc") {
        return "launchpad";
      }
      return undefined;
    });
  });

  it("shows LLM usage in non-lite AI preferences", () => {
    render(<AccountPreferencesAI />);

    expect(screen.getByText("LLM usage")).toBeTruthy();
    expect(
      screen.getByText(
        /These limits apply even when you use CoCalc's shared API access/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText("LLMUsageStatus")).toBeTruthy();
  });
});
