/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { BulkSeatEmailAssign } from "./bulk-seat-assign";

describe("BulkSeatEmailAssign", () => {
  it("labels the list, previews the plan and assigns only valid new addresses", async () => {
    const assignEmails = jest.fn(async (emails: string[]) => ({
      assigned: emails,
      failed: [],
    }));
    render(
      <BulkSeatEmailAssign
        seatName="team"
        availableSeats={1}
        alreadyAssigned={new Set()}
        assignEmails={assignEmails}
      />,
    );
    const button = screen.getByRole("button", { name: "Assign seats" });
    expect(button).toBeDisabled();
    const list = screen.getByRole("textbox", { name: "Email addresses" });
    fireEvent.change(list, {
      target: { value: "a@example.edu\nb@example.edu\nnonsense" },
    });
    expect(screen.getByRole("status").textContent).toMatch(
      /1 seat will be assigned; 1 do not fit/,
    );
    expect(
      screen.getByText(/Not valid email addresses: nonsense/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Assign 1 seat" }));
    await waitFor(() => {
      expect(screen.getByText("Assigned 1 seat.")).toBeTruthy();
    });
    expect(assignEmails).toHaveBeenCalledWith(["a@example.edu"]);
    expect((list as HTMLTextAreaElement).value).toBe("");
  });
});
