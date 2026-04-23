import { fireEvent, render, screen } from "@testing-library/react";
import {
  CodexQuotaHelp,
  classifyCodexAuthErrorMessage,
  isCodexUsageLimitMessage,
} from "../codex-quota-help";

jest.mock("@cocalc/frontend/account/membership-purchase-modal", () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="membership-purchase-modal" /> : null,
}));

jest.mock("@cocalc/frontend/account/codex-credentials-panel", () => ({
  CodexCredentialsPanel: ({
    defaultProjectId,
  }: {
    defaultProjectId?: string;
  }) => (
    <div data-testid="codex-credentials-panel">{defaultProjectId ?? ""}</div>
  ),
}));

const originalGetComputedStyle = window.getComputedStyle;

beforeAll(() => {
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    value: () =>
      ({
        getPropertyValue: () => "",
      }) as unknown as CSSStyleDeclaration,
  });
});

afterAll(() => {
  Object.defineProperty(window, "getComputedStyle", {
    configurable: true,
    value: originalGetComputedStyle,
  });
});

describe("isCodexUsageLimitMessage", () => {
  it("detects the standardized usage limit text", () => {
    expect(
      isCodexUsageLimitMessage(
        "**LLM usage limit reached**\n\nYou have reached your 5-hour LLM usage limit.",
      ),
    ).toBe(true);
  });

  it("ignores unrelated chat content", () => {
    expect(isCodexUsageLimitMessage("Normal assistant reply")).toBe(false);
  });
});

describe("classifyCodexAuthErrorMessage", () => {
  it("detects expired ChatGPT auth", () => {
    expect(
      classifyCodexAuthErrorMessage(
        "unexpected status 401 Unauthorized: Provided authentication token is expired. Please try signing in again. auth error code: token_expired",
      ),
    ).toMatchObject({
      kind: "expired-auth",
      actionLabel: "Sign in again",
    });
  });

  it("detects missing API auth", () => {
    expect(
      classifyCodexAuthErrorMessage(
        "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
      ),
    ).toMatchObject({
      kind: "missing-auth",
      actionLabel: "Configure Codex",
    });
  });
});

describe("CodexQuotaHelp", () => {
  it("renders inline actions only for quota messages", () => {
    const { rerender } = render(<CodexQuotaHelp message="Normal reply" />);
    expect(screen.queryByText("Upgrade membership")).toBeNull();

    rerender(
      <CodexQuotaHelp message="You have reached your 5-hour LLM usage limit. Please try again later or upgrade your membership." />,
    );
    expect(screen.getByText("Upgrade membership")).toBeTruthy();
    expect(screen.getByText("Open AI settings")).toBeTruthy();
  });

  it("opens the membership and settings modals", async () => {
    render(
      <CodexQuotaHelp
        message="You have reached your 5-hour LLM usage limit. Please try again later or upgrade your membership."
        projectId="project-1"
      />,
    );

    fireEvent.click(screen.getByText("Upgrade membership"));
    expect(screen.getByTestId("membership-purchase-modal")).toBeTruthy();

    fireEvent.click(screen.getByText("Open AI settings"));
    expect(screen.getByTestId("codex-credentials-panel").textContent).toContain(
      "project-1",
    );
  });

  it("opens the credentials modal for expired auth errors", () => {
    render(
      <CodexQuotaHelp
        message="Codex authentication expired."
        projectId="project-1"
      />,
    );

    expect(screen.getByText("Sign in again")).toBeTruthy();
    fireEvent.click(screen.getByText("Sign in again"));
    expect(screen.getByTestId("codex-credentials-panel").textContent).toContain(
      "project-1",
    );
  });
});
