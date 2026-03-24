/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";

import SupportNew from "../new-view";

describe("SupportNew", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/support/new");
    (global as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
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
});
