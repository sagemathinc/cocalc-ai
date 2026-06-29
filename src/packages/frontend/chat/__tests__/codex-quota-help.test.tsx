import { fireEvent, render, screen } from "@testing-library/react";
import {
  CodexQuotaHelp,
  classifyCodexAuthErrorMessage,
  isCodexSiteAiUnavailableMessage,
  isCodexUsageLimitMessage,
} from "../codex-quota-help";

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
        "**AI usage limit reached**\n\nYou have reached your 5-hour AI usage limit.",
      ),
    ).toBe(true);
  });

  it("detects the zero site AI limit text", () => {
    const message =
      "CoCalc AI usage is not included on this site. To use AI in CoCalc, sign up for a ChatGPT plan at https://chatgpt.com/pricing, then connect it in CoCalc AI settings.";
    expect(isCodexUsageLimitMessage(message)).toBe(true);
    expect(isCodexSiteAiUnavailableMessage(message)).toBe(true);
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

  it("detects invalidated ChatGPT OAuth tokens as expired auth", () => {
    expect(
      classifyCodexAuthErrorMessage(
        "unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, failing request, url: https://chatgpt.com/backend-api/codex/responses, auth error: identity_edge_internal_error",
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
    expect(screen.queryByText("Open AI Settings")).toBeNull();

    rerender(
      <CodexQuotaHelp message="You have reached your 5-hour AI usage limit. Please try again later or upgrade your membership." />,
    );
    expect(screen.queryByText("Upgrade membership")).toBeNull();
    expect(screen.getByText("Open AI Settings")).toBeTruthy();
    expect(screen.getByText("Open ChatGPT Codex Usage")).toBeTruthy();
  });

  it("opens the settings modal for usage limits", async () => {
    render(
      <CodexQuotaHelp
        message="You have reached your 5-hour AI usage limit. Please try again later or upgrade your membership."
        projectId="project-1"
      />,
    );

    fireEvent.click(screen.getByText("Open AI Settings"));
    expect(screen.getByTestId("codex-credentials-panel").textContent).toContain(
      "project-1",
    );
  });

  it("renders ChatGPT-only guidance when site AI usage is unavailable", () => {
    render(
      <CodexQuotaHelp
        message="CoCalc AI usage is not included on this site. To use AI in CoCalc, sign up for a ChatGPT plan at https://chatgpt.com/pricing, then connect it in CoCalc AI settings."
        projectId="project-1"
      />,
    );

    expect(screen.getByText("View ChatGPT plans")).toBeTruthy();
    expect(screen.getByText("Open AI Settings")).toBeTruthy();
    expect(screen.queryByText("Open ChatGPT Codex Usage")).toBeNull();
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
