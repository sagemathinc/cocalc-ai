/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import immutable from "immutable";
import RenameFile from "../rename-file";

const mockUseRedux = jest.fn();
const mockUseProjectContext = jest.fn();

jest.mock("react-intl", () => ({
  defineMessage: (msg: any) => msg,
  defineMessages: (msgs: any) => msgs,
  useIntl: () => ({
    formatMessage: (_msg: any) => "Cancel",
  }),
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  useRedux: (...args: any[]) => mockUseRedux(...args),
}));

jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => mockUseProjectContext(),
}));

jest.mock("../checked-files", () => () => null);
jest.mock("@cocalc/frontend/components/error", () => () => null);
jest.mock("@cocalc/frontend/components/icon", () => ({
  Icon: () => null,
}));

describe("RenameFile duplicate action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("duplicates the selected path rather than copying only its contents", async () => {
    const copyPaths = jest.fn().mockResolvedValue(undefined);
    const get_store = jest.fn(() => ({}));
    mockUseProjectContext.mockReturnValue({
      actions: {
        project_id: "project-1",
        get_store,
        suggestDuplicateFilenameInCurrentDirectory: jest.fn(() => "foo-1.txt"),
        copyPaths,
      },
    });
    mockUseRedux.mockReturnValue(immutable.Set(["/foo.txt"]));

    render(<RenameFile duplicate clear={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Duplicate File/i }));

    await waitFor(() => {
      expect(copyPaths).toHaveBeenCalledWith({
        src: ["/foo.txt"],
        dest: "/foo-1.txt",
      });
    });
  });
});
