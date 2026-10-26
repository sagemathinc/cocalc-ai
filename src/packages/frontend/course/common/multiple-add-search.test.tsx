/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { MultipleAddSearch } from "./multiple-add-search";

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }: { name: string }) => <span>{name}</span>,
}));

jest.mock("@cocalc/frontend/components/error", () => ({
  __esModule: true,
  default: ({ error, message }: { error?: unknown; message: string }) =>
    error ? (
      <div role="alert">
        {message}: {`${error}`}
      </div>
    ) : null,
}));

jest.mock("@cocalc/frontend/project/directory-selector", () => ({
  __esModule: true,
  default: ({
    onMultiSelect,
  }: {
    onMultiSelect: (paths: Set<string>) => void;
  }) => (
    <button onClick={() => onMultiSelect(new Set(["assignment-1"]))}>
      Select assignment-1
    </button>
  ),
}));

function renderSearch(
  addSelected: (paths: string[]) => void | Promise<void>,
  isExcluded: (path: string) => boolean = () => false,
) {
  return render(
    <IntlProvider locale="en">
      <MultipleAddSearch
        addSelected={addSelected}
        itemName="assignment"
        isExcluded={isExcluded}
        defaultOpen
        closable
      />
    </IntlProvider>,
  );
}

describe("MultipleAddSearch", () => {
  it("waits for the add operation before closing", async () => {
    let resolve!: () => void;
    const addSelected = jest.fn(
      () => new Promise<void>((done) => (resolve = done)),
    );
    renderSearch(addSelected);

    fireEvent.click(
      screen.getByRole("button", { name: "Select assignment-1" }),
    );
    const addButton = screen.getByRole("button", {
      name: /add 1 assignment/i,
    });
    fireEvent.click(addButton);

    expect(addSelected).toHaveBeenCalledWith(["assignment-1"]);
    expect(addButton).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Select assignment-1" }),
    ).toBeInTheDocument();

    resolve();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Select assignment-1" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps the selector open and shows an error when adding fails", async () => {
    const addSelected = jest.fn(async () => {
      throw new Error("project operation failed");
    });
    renderSearch(addSelected);

    fireEvent.click(
      screen.getByRole("button", { name: "Select assignment-1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /add 1 assignment/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to add selected folders: Error: project operation failed",
    );
    expect(
      screen.getByRole("button", { name: "Select assignment-1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add 1 assignment/i }),
    ).toBeEnabled();
  });

  it("does not resubmit folders that were added before a retry", async () => {
    const added = new Set<string>();
    const addSelected = jest.fn(async (paths: string[]) => {
      for (const path of paths) added.add(path);
    });
    renderSearch(addSelected, (path) => added.has(path));
    added.add("assignment-1"); // added by an earlier, partly failed attempt

    fireEvent.click(
      screen.getByRole("button", { name: "Select assignment-1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /add 1 assignment/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Select assignment-1" }),
      ).not.toBeInTheDocument(),
    );
    expect(addSelected).not.toHaveBeenCalled();
  });
});
