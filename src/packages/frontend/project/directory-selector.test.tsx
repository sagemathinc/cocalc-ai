/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { redux } from "@cocalc/frontend/app-framework";
import DirectorySelector from "./directory-selector";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

const refresh = jest.fn();
const mockFs = {
  exists: jest.fn(async () => false),
  mkdir: jest.fn(),
};

jest.mock("@cocalc/frontend/app-framework", () => {
  const actual = jest.requireActual("@cocalc/frontend/app-framework");
  return {
    ...actual,
    useTypedRedux: jest.fn(() => undefined),
  };
});

jest.mock("@cocalc/frontend/project/listing/use-fs", () => ({
  __esModule: true,
  default: jest.fn(() => mockFs),
}));

jest.mock("@cocalc/frontend/project/listing/use-files", () => ({
  __esModule: true,
  default: jest.fn(() => ({ files: {}, refresh })),
  getCacheId: jest.fn(() => "test-cache"),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolve0) => {
    resolve = resolve0;
  });
  return { promise, resolve };
}

describe("DirectorySelector", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const getComputedStyle = window.getComputedStyle;
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) => getComputedStyle(element));
    jest.spyOn(redux, "getProjectActions").mockReturnValue({
      fs: () => mockFs,
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps the selected folder label theme-aware", () => {
    render(<DirectorySelector project_id="project-id" onSelect={jest.fn()} />);
    const checkbox = screen.getByRole("checkbox", { name: /Home Folder/ });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    const label = screen.getByText(/Home Folder/);
    expect(label.closest("span[style]")?.getAttribute("style")).toContain(
      UI_COLORS.text,
    );
  });

  it("keeps the new-folder dialog open until mkdir finishes", async () => {
    const mkdir = deferred();
    mockFs.mkdir.mockReturnValueOnce(mkdir.promise);
    const onSelect = jest.fn();
    render(<DirectorySelector project_id="project-id" onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /new folder/i }));
    const dialog = await screen.findByRole("dialog", { name: /new folder/i });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() =>
      expect(mockFs.mkdir).toHaveBeenCalledWith("New Folder"),
    );
    expect(dialog).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();

    mkdir.resolve();

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /new folder/i }),
      ).not.toBeInTheDocument(),
    );
    expect(onSelect).toHaveBeenCalledWith("New Folder");
  });
});
