/** @jest-environment jsdom */

jest.mock("@cocalc/frontend/rootfs/manifest", () => ({
  useRootfsImages: () => ({ images: [] }),
}));

import { fireEvent, render, screen } from "@testing-library/react";
import { version } from "@cocalc/util/smc-version";
import { RowEntry } from "./row-entry";

function renderVersionRow(name: string, value: string) {
  const onChangeEntry = jest.fn();
  render(
    <RowEntry
      name={name}
      value={value}
      password={false}
      isReadonly={{}}
      onChangeEntry={onChangeEntry}
      onDraftEntry={jest.fn()}
      onJsonEntryChange={jest.fn()}
    />,
  );
  return onChangeEntry;
}

describe("browser version settings", () => {
  for (const name of ["version_min_browser", "version_recommended_browser"]) {
    it(`${name}: offers this page's version`, () => {
      const onChangeEntry = renderVersionRow(name, "0");
      fireEvent.click(screen.getByText("Use this version"));
      expect(onChangeEntry).toHaveBeenCalledWith(name, `${version}`);
    });

    it(`${name}: flags a version newer than this page's`, () => {
      renderVersionRow(name, `${version + 1000}`);
      expect(
        screen.getByText(/Higher than the version of this page/),
      ).toBeTruthy();
    });

    it(`${name}: no warning or button at this page's version`, () => {
      renderVersionRow(name, `${version}`);
      expect(screen.queryByText(/Higher than the version/)).toBeNull();
      expect(screen.queryByText("Use this version")).toBeNull();
    });
  }

  it("explains that the required version needs the recommended one too", () => {
    renderVersionRow("version_min_browser", "0");
    expect(screen.getByText(/set both to force/)).toBeTruthy();
  });
});
