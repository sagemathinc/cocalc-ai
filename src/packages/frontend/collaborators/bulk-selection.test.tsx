/** @jest-environment jsdom */

/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  CollaboratorBulkSelection,
  bulkSelectableCollaboratorKeys,
  selectAllCollaboratorEntries,
} from "./bulk-selection";

describe("bulkSelectableCollaboratorKeys", () => {
  it("keeps only exact email matches in display order without duplicates", () => {
    expect(
      bulkSelectableCollaboratorKeys(
        ["b@example.com", "account-name", "account-email", "b@example.com", ""],
        new Set(["account-email", "b@example.com", ""]),
      ),
    ).toEqual(["b@example.com", "account-email"]);
  });

  it("returns nothing for empty or name-only results", () => {
    expect(bulkSelectableCollaboratorKeys([], new Set())).toEqual([]);
    expect(
      bulkSelectableCollaboratorKeys(["account-1", "account-2"], new Set()),
    ).toEqual([]);
  });
});

describe("selectAllCollaboratorEntries", () => {
  it("appends new keys after the existing selection and deduplicates", () => {
    expect(
      selectAllCollaboratorEntries(
        ["account-name", "a@example.com"],
        ["a@example.com", "b@example.com"],
      ),
    ).toEqual(["account-name", "a@example.com", "b@example.com"]);
  });
});

function Harness({
  bulkKeys,
  nameMatchCount = 0,
  initial = [],
  onChange,
}: {
  bulkKeys: string[];
  nameMatchCount?: number;
  initial?: string[];
  onChange?: (selected: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  return (
    <CollaboratorBulkSelection
      bulkKeys={bulkKeys}
      nameMatchCount={nameMatchCount}
      selectedEntries={selected}
      onChange={(next) => {
        setSelected(next);
        onChange?.(next);
      }}
    />
  );
}

describe("CollaboratorBulkSelection", () => {
  it("selects all exact matches and clears the selection from the keyboard", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(
      <Harness
        bulkKeys={["a@example.com", "account-b"]}
        initial={["account-name"]}
        onChange={onChange}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("1 selected");
    const selectAll = screen.getByRole("button", {
      name: /select all 2 email matches/i,
    });
    const clear = screen.getByRole("button", { name: /clear selection/i });

    await user.tab();
    expect(selectAll).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([
      "account-name",
      "a@example.com",
      "account-b",
    ]);
    expect(status).toHaveTextContent("3 selected");
    expect(selectAll).toBeDisabled();

    await user.tab();
    expect(clear).toHaveFocus();
    await user.keyboard(" ");
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(status).toHaveTextContent("0 selected");
    expect(clear).toBeDisabled();
    expect(selectAll).toBeEnabled();
  });

  it("disables Select all when there are no exact matches and explains name matches", () => {
    render(<Harness bulkKeys={[]} nameMatchCount={2} />);
    expect(
      screen.getByRole("button", { name: /select all 0 email matches/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /clear selection/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/2 name-search matches are not included/i),
    ).toBeInTheDocument();
  });

  it("does not show the name-match note when every result is an exact match", () => {
    render(<Harness bulkKeys={["a@example.com"]} />);
    expect(
      screen.getByRole("button", { name: /select all 1 email match$/i }),
    ).toBeEnabled();
    expect(screen.queryByText(/name-search/i)).not.toBeInTheDocument();
  });
});
