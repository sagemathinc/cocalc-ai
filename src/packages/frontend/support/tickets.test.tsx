/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { SupportTickets } from "./tickets";
import openSupportTab from "./open";

const mockedOpenSupportTab = openSupportTab as jest.Mock;

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  useTypedRedux: (store: string, key: string) => {
    if (store === "customize" && key === "help_email") {
      return "help@example.com";
    }
    if (store === "customize" && key === "zendesk") {
      return true;
    }
    return undefined;
  },
}));

jest.mock(
  "@cocalc/frontend/public/support/tickets-view",
  () =>
    function SupportTicketsViewMock() {
      return <div>Zendesk ticket list</div>;
    },
);

jest.mock("./open", () => ({
  __esModule: true,
  default: jest.fn(),
  openSupportTicketsPage: jest.fn(),
}));

describe("SupportTickets", () => {
  beforeEach(() => {
    mockedOpenSupportTab.mockReset();
  });

  it("renders the in-app support page and opens the modal from the action button", () => {
    render(<SupportTickets />);
    expect(screen.getByText("Zendesk ticket list")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New support ticket" }));
    expect(mockedOpenSupportTab).toHaveBeenCalledTimes(1);
  });
});
