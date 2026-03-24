/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";

import api from "@cocalc/frontend/client/api";
import SupportNew from "../new-view";

jest.mock("@cocalc/frontend/client/api", () => jest.fn());

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
  });

  it("renders a richer zendesk-backed support form", () => {
    render(
      <SupportNew
        config={{
          help_email: "help@example.com",
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
    expect(screen.getByText("Enter a valid email address")).not.toBeNull();
  });

  it("uses query string values to prefill the public form", () => {
    window.history.replaceState(
      {},
      "",
      "/support/new?type=purchase&subject=Need%20pricing&title=Ask%20Sales&body=Tell%20me%20more%20about%20pricing",
    );

    render(
      <SupportNew
        config={{ site_name: "Launchpad", zendesk: true }}
        onNavigate={jest.fn()}
      />,
    );

    expect(screen.getByText("Ask Sales")).not.toBeNull();
    expect(screen.getByDisplayValue("Need pricing")).not.toBeNull();
    expect(
      screen.getByDisplayValue("Tell me more about pricing"),
    ).not.toBeNull();
  });

  it("shows a success alert after creating a ticket", async () => {
    mockedApi.mockResolvedValue({
      url: "https://example.zendesk.com/requests/123",
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
