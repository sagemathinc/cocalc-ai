/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { List, Map } from "immutable";
import { IntlProvider } from "react-intl";

import { LatexFiles } from "./files-frame";
import { Output } from "./output";

let mockFiles: List<string> | undefined;
const mockRefresh = jest.fn();
const mockSummaries = jest.fn();
const mockGetHomeDirectory = jest.fn(async () => "/home/user");

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  useEffect: require("react").useEffect,
  useRedux: (keys: string[]) => {
    if (keys[1] === "switch_to_files") return mockFiles;
    if (keys.at(-1) === "activeTab") return "files";
    return undefined;
  },
}));
jest.mock("@cocalc/frontend/components", () => ({
  Icon: () => null,
  Text: ({ children }) => <span>{children}</span>,
  Tip: ({ children }) => <>{children}</>,
}));
jest.mock("@cocalc/frontend/editors/slate/static-markdown", () => ({
  __esModule: true,
  default: ({ value }) => <span>{value}</span>,
}));
jest.mock("@cocalc/frontend/file-associations", () => ({
  filenameIcon: () => "file",
}));
jest.mock("@cocalc/frontend/frame-editors/generic/client", () => ({
  project_api: async () => ({ getHomeDirectory: mockGetHomeDirectory }),
}));
jest.mock("./use-summarize", () => ({
  useTexSummaries: (...args) => {
    mockSummaries(...args);
    return {
      fileSummaries: { "/project/chapter.tex": "Chapter summary" },
      summariesLoading: false,
      refreshSummaries: mockRefresh,
    };
  },
}));
jest.mock("./build", () => ({ Build: () => null }));
jest.mock("./errors-and-warnings", () => ({ ErrorsAndWarnings: () => null }));
jest.mock("./pdfjs", () => ({ PDFJS: () => null }));
jest.mock("./output-control", () => ({ PDFControls: () => null }));
jest.mock("./output-stats", () => ({ OutputStats: () => null }));
jest.mock("./table-of-contents-frame", () => ({ LatexTOCBody: () => null }));

function actionsFixture(): any {
  return {
    name: "latex-editor",
    project_id: "project-1",
    path: "/project/main.tex",
    switch_to_file: jest.fn(async () => "source-frame"),
    updateTableOfContents: jest.fn(),
    scrollToHeading: jest.fn(),
    store: { get: () => Map() },
    setState: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFiles = List([
    "/project/main.tex",
    "/project/z.tex",
    "/project/chapter.tex",
  ]);
});

it.each(["standalone", "output"])(
  "provides keyboard file navigation in the %s view",
  async (surface) => {
    const user = userEvent.setup();
    const actions = actionsFixture();
    render(
      <IntlProvider locale="en">
        {surface === "standalone" ? (
          <LatexFiles actions={actions} font_size={14} />
        ) : (
          <Output
            id="output"
            name={actions.name}
            actions={actions}
            editor_state={Map() as any}
            is_fullscreen={false}
            project_id={actions.project_id}
            path={actions.path}
            font_size={14}
            is_current
            is_visible
            status=""
          />
        )}
      </IntlProvider>,
    );
    await waitFor(() =>
      expect(mockSummaries).toHaveBeenLastCalledWith(
        mockFiles,
        "project-1",
        "/project/main.tex",
        "/home/user",
        undefined,
      ),
    );
    expect(screen.getByText("2 subfiles")).toBeInTheDocument();
    expect(screen.getByText("Chapter summary")).toBeInTheDocument();
    const main = screen.getByRole("button", { name: "Open Main File" });
    await user.click(main);
    expect(actions.switch_to_file).toHaveBeenLastCalledWith(
      "/project/main.tex",
    );
    await user.tab();
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(screen.getByRole("button", { name: "chapter.tex" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(actions.switch_to_file).toHaveBeenLastCalledWith(
      "/project/chapter.tex",
    );
    await user.tab();
    expect(screen.getByRole("button", { name: "z.tex" })).toHaveFocus();
  },
);

it("handles initially undiscovered files and follows discovery updates", async () => {
  mockFiles = undefined;
  const actions = actionsFixture();
  const view = () => (
    <IntlProvider locale="en">
      <LatexFiles actions={actions} font_size={14} />
    </IntlProvider>
  );
  const { rerender } = render(view());
  expect(screen.getByText("0 subfiles")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open Main File" })).toBeEnabled();
  mockFiles = List(["/project/main.tex", "/project/sections/new.tex"]);
  rerender(view());
  expect(
    screen.getByRole("button", { name: "sections/new.tex" }),
  ).toBeInTheDocument();
  expect(screen.getByText("1 subfile")).toBeInTheDocument();
  await waitFor(() => expect(mockGetHomeDirectory).toHaveBeenCalledTimes(1));
});
