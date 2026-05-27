/** @jest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";

import { getDocsEntry } from "@cocalc/docs";
import { DocsBrowser } from "./browser";

describe("DocsBrowser", () => {
  it("notifies when the detail view returns to the index", () => {
    const entry = getDocsEntry("terminal/use-terminal");
    if (entry == null) throw new Error("missing terminal docs entry");
    const onSelectedEntryChange = jest.fn();

    render(
      <DocsBrowser
        initialEntry={entry}
        onSelectedEntryChange={onSelectedEntryChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /All docs/ }));

    expect(onSelectedEntryChange).toHaveBeenCalledWith(undefined);
  });
});
