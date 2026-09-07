/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PUBLIC_COLORS } from "../theme";
import SupportTicketsView from "./tickets-view";

const mockApi = jest.fn();

jest.mock("antd", () => ({
  Button: ({ children, loading, ...props }: any) => (
    <button
      aria-busy={loading ? "true" : undefined}
      disabled={loading || props.disabled}
      {...props}
    >
      {children}
    </button>
  ),
}));

jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: (...args: any[]) => mockApi(...args),
}));

jest.mock("@cocalc/frontend/public/layout/shell", () => ({
  PublicSection: ({ children }: any) => <div>{children}</div>,
}));

describe("SupportTicketsView", () => {
  beforeEach(() => {
    mockApi.mockReset();
  });

  it("refreshes the ticket list on demand", async () => {
    mockApi
      .mockResolvedValueOnce({
        tickets: [
          { id: 1, subject: "First ticket", description: "Initial body" },
        ],
      })
      .mockResolvedValueOnce({ tickets: [] });

    render(<SupportTicketsView config={{ zendesk: true }} />);

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "First ticket",
      }),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(2));
    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(mockApi).toHaveBeenNthCalledWith(1, "support/tickets");
    expect(mockApi).toHaveBeenNthCalledWith(2, "support/tickets");
  });

  it("renders status metadata with accessible contrast and target sizing", async () => {
    mockApi.mockResolvedValueOnce({
      tickets: [
        {
          created_at: "2026-06-20T10:00:00Z",
          description: "Waiting on a reply.",
          id: 2,
          status: "pending",
          subject: "Pending ticket",
          type: "problem",
          updated_at: "2026-06-20T11:00:00Z",
        },
      ],
    });

    render(<SupportTicketsView config={{ zendesk: true }} />);

    const status = await screen.findByText("PENDING");
    expect(status.style.color).not.toBe("white");
    expect(status.style.minHeight).toBe("24px");
    expect(status.style.border).toContain("1px solid");

    const type = screen.getByText("problem");
    expect(type.style.minHeight).toBe("24px");
    expect(type.style.color).not.toBe("white");

    const dates = screen.getByText(/Created .* updated/i);
    expect(dates.style.color).not.toBe("rgb(128, 128, 128)");
  });

  it("uses public color tokens for ticket alert states", () => {
    render(<SupportTicketsView config={{ zendesk: false }} />);

    const error = screen.getByText("Support tickets are not configured.");
    expect(error).toHaveStyle({
      background: PUBLIC_COLORS.errorTint,
      color: PUBLIC_COLORS.error,
    });
    expect(error.style.borderWidth).toBe("1px");
    expect(error.style.borderStyle).toBe("solid");
    expect(error.style.borderColor).toBe(PUBLIC_COLORS.errorBorder);

    mockApi.mockReturnValue(new Promise(() => {}));
    render(<SupportTicketsView config={{ zendesk: true }} />);

    const loading = screen.getByText("Loading support tickets...");
    expect(loading).toHaveStyle({
      background: PUBLIC_COLORS.infoTint,
      color: PUBLIC_COLORS.info,
    });
    expect(loading.style.borderColor).toBe(PUBLIC_COLORS.infoBorder);
  });
});
