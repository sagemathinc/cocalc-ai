/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import api from "@cocalc/frontend/client/api";
import SupportNew from "../new-view";

jest.mock("@cocalc/frontend/client/api", () => jest.fn());
jest.mock(
  "../recent-files",
  () =>
    function RecentFilesMock() {
      return <div>Recent files picker</div>;
    },
);

const mockedApi = api as jest.Mock;

describe("SupportNew", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/support/new");
    (global as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    mockedApi.mockReset();
    mockedApi.mockImplementation(async (endpoint: string) => {
      if (endpoint === "accounts/profile") {
        return { profile: {} };
      }
      return {};
    });
  });

  it("renders a richer zendesk-backed support form", async () => {
    render(
      <SupportNew
        config={{
          help_email: "help@example.com",
          policy_pages: "sagemathinc",
          site_name: "Launchpad",
          support_video_call: "https://example.com/call",
          zendesk: true,
        }}
        onNavigate={jest.fn()}
      />,
    );

    expect(screen.getByText("Create a New Support Ticket")).not.toBeNull();
    expect(
      screen.getByText("Something is not working the way I think it should."),
    ).not.toBeNull();
    expect(screen.getByText("Helpful links")).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Trust materials" }),
    ).toHaveAttribute("href", "/policies/trust");
    expect(
      screen.getByRole("link", { name: "Privacy policy" }),
    ).toHaveAttribute("href", "/policies/privacy");
    expect(screen.getByText("Relevant files")).not.toBeNull();
    expect(await screen.findByText("Recent files picker")).not.toBeNull();
    expect(screen.getByText("Enter a valid email address")).not.toBeNull();
    expect(screen.getByLabelText("Your email address")).not.toBeNull();
    expect(screen.getByLabelText("Subject")).not.toBeNull();
    expect(
      screen.getByRole("radiogroup", { name: "Support request type" }),
    ).not.toBeNull();
    expect(screen.getByLabelText("What did you do exactly?")).not.toBeNull();
    expect(screen.getByLabelText("What happened?")).not.toBeNull();
    expect(
      screen.getByLabelText("How did this differ from what you expected?"),
    ).not.toBeNull();
  });

  it("gives every support-request body variant a programmatic label", () => {
    render(
      <SupportNew
        config={{ site_name: "Launchpad", zendesk: true }}
        onNavigate={jest.fn()}
      />,
    );

    expect(screen.queryByText(/billing, functionality, teaching/i)).toBeNull();
    fireEvent.click(
      screen.getByRole("radio", {
        name: /I have a question about billing, functionality/i,
      }),
    );
    expect(screen.getByLabelText("Question details")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("radio", {
        name: /I need help installing or configuring software/i,
      }),
    );
    expect(screen.getByLabelText("What software do you need?")).not.toBeNull();
    expect(
      screen.getByLabelText("How do you plan to use this software?"),
    ).not.toBeNull();
    expect(
      screen.getByLabelText(
        "How can we test that the software is properly installed?",
      ),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("radio", {
        name: /I have a question about pricing or purchasing/i,
      }),
    );
    expect(
      screen.getByLabelText("Pricing or purchasing details"),
    ).not.toBeNull();

    fireEvent.click(
      screen.getByRole("radio", {
        name: /I would like to schedule a video chat/i,
      }),
    );
    expect(screen.getByLabelText("Video chat request details")).not.toBeNull();
  });

  it("keeps trust context on the email-only contact fallback", () => {
    render(
      <SupportNew
        config={{
          help_email: "help@example.com",
          policy_pages: "sagemathinc",
          site_name: "Launchpad",
          zendesk: false,
        }}
        onNavigate={jest.fn()}
      />,
    );

    expect(
      screen.getByText(
        "This site is not accepting support tickets directly here. Use the support page or email CoCalc, and include the context below if it applies to your request.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "trust materials" }),
    ).toHaveAttribute("href", "/policies/trust");
    expect(
      screen.getByRole("link", { name: "the privacy policy" }),
    ).toHaveAttribute("href", "/policies/privacy");
  });

  it("prefills the email field for signed-in users", async () => {
    mockedApi.mockImplementation(async (endpoint: string) => {
      if (endpoint === "accounts/profile") {
        return { profile: { email_address: "signed-in@example.com" } };
      }
      return {};
    });

    render(
      <SupportNew
        config={{ site_name: "Launchpad", zendesk: true }}
        onNavigate={jest.fn()}
      />,
    );

    expect(
      await screen.findByDisplayValue("signed-in@example.com"),
    ).not.toBeNull();
  });

  it("uses query string values to prefill the public form", () => {
    window.history.replaceState(
      {},
      "",
      "/support/new?type=purchase&subject=Need%20pricing&title=Ask%20CoCalc%20about%20pricing&body=Tell%20me%20more%20about%20pricing&context=pricing-hosted-plans",
    );

    render(
      <SupportNew
        config={{ site_name: "Launchpad", zendesk: true }}
        onNavigate={jest.fn()}
      />,
    );

    expect(screen.getByText("Ask CoCalc about pricing")).not.toBeNull();
    expect(screen.getByDisplayValue("Need pricing")).not.toBeNull();
    expect(
      screen.getByDisplayValue("Tell me more about pricing"),
    ).not.toBeNull();
    expect(
      screen.getByText("Helpful context for pricing or purchasing"),
    ).not.toBeNull();
    expect(
      screen.getByText(/Which CoCalc path you are considering/),
    ).not.toBeNull();
    expect(screen.getByText(/who would operate it/)).not.toBeNull();
    expect(screen.getByText(/data-ownership/)).not.toBeNull();
    expect(screen.getByPlaceholderText(/who will operate it/)).not.toBeNull();
  });

  it("passes prefilled purchase context to the support ticket", async () => {
    window.history.replaceState(
      {},
      "",
      "/support/new?type=purchase&subject=CoCalc%20Rocket&title=Talk%20with%20CoCalc%20about%20Rocket&body=I%20want%20to%20talk%20about%20Rocket%20deployment%20planning.&context=product-cocalc-rocket",
    );
    mockedApi.mockImplementation(async (endpoint: string) => {
      if (endpoint === "accounts/profile") {
        return { profile: {} };
      }
      if (endpoint === "support/create-ticket") {
        return { url: "https://example.zendesk.com/requests/456" };
      }
      return {};
    });

    render(
      <SupportNew
        config={{ site_name: "CoCalc", zendesk: true }}
        onNavigate={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Email address..."), {
      target: { value: "buyer@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create support ticket" }),
    );

    await waitFor(() =>
      expect(mockedApi).toHaveBeenCalledWith(
        "support/create-ticket",
        expect.objectContaining({
          options: expect.objectContaining({
            body: "I want to talk about Rocket deployment planning.",
            email: "buyer@example.com",
            subject: "CoCalc Rocket",
            type: "purchase",
            info: expect.objectContaining({
              context: "product-cocalc-rocket",
            }),
          }),
        }),
      ),
    );
  });

  it("preserves request context when direct ticket creation is unavailable", () => {
    window.history.replaceState(
      {},
      "",
      "/support/new?type=purchase&subject=CoCalc%20Rocket&title=Talk%20with%20CoCalc%20about%20Rocket&body=I%20want%20to%20talk%20about%20Rocket%20deployment%20planning.&context=product-cocalc-rocket",
    );

    render(
      <SupportNew
        config={{ help_email: "help@example.com", site_name: "CoCalc" }}
        onNavigate={jest.fn()}
      />,
    );

    expect(screen.getByText("Talk with CoCalc about Rocket")).not.toBeNull();
    expect(screen.getByText("CoCalc Rocket")).not.toBeNull();
    expect(
      screen.getByText("I want to talk about Rocket deployment planning."),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Open support page" }),
    ).not.toBeNull();
    expect(screen.getByRole("link", { name: "Email CoCalc" })).toHaveAttribute(
      "href",
      expect.stringContaining("mailto:help@example.com?"),
    );
    expect(mockedApi).not.toHaveBeenCalled();
  });

  it("shows a success alert after creating a ticket", async () => {
    mockedApi.mockImplementation(async (endpoint: string) => {
      if (endpoint === "accounts/profile") {
        return { profile: {} };
      }
      if (endpoint === "support/create-ticket") {
        return { url: "https://example.zendesk.com/requests/123" };
      }
      return {};
    });

    render(
      <SupportNew
        config={{ site_name: "Launchpad", zendesk: true }}
        onNavigate={jest.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText("Email address..."), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Summarize what this is about..."),
      {
        target: { value: "Notebook problem" },
      },
    );
    fireEvent.change(
      screen.getByPlaceholderText(
        "Describe exactly what you did before the problem happened.",
      ),
      {
        target: { value: "I opened a notebook and hit run several times." },
      },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Create support ticket" }),
    );

    expect(
      await screen.findByText("Successfully created support ticket"),
    ).not.toBeNull();
    expect(
      screen.getByText("https://example.zendesk.com/requests/123"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "View my tickets" }),
    ).not.toBeNull();
    expect(
      screen.getByPlaceholderText("Email address...").hasAttribute("disabled"),
    ).toBe(true);
  });
});
