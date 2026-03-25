/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SupportTicketsView from "./tickets-view";

const mockApi = jest.fn();

jest.mock("antd", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock("@cocalc/frontend/client/api", () => ({
  __esModule: true,
  default: (...args: any[]) => mockApi(...args),
}));

jest.mock("@cocalc/frontend/public/ui/shell", () => ({
  PublicSectionCard: ({ children }: any) => <div>{children}</div>,
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

    expect(await screen.findByText("First ticket")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(2));
    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(mockApi).toHaveBeenNthCalledWith(1, "support/tickets");
    expect(mockApi).toHaveBeenNthCalledWith(2, "support/tickets");
  });
});
