/** @jest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import { UnknownEditor } from "./editor";

const exec = jest.fn();
const actions = {
  open_directory: jest.fn(),
  close_file: jest.fn(),
  open_file: jest.fn(),
};

jest.mock("../../app-framework", () => {
  const React = require("react");
  return {
    React,
    CSS: {} as any,
    useActions: () => actions,
    useTypedRedux: () => "CoCalc Launchpad",
  };
});

jest.mock("../../webapp-client", () => ({
  webapp_client: {
    project_client: {
      exec: (...args: any[]) => exec(...args),
    },
  },
}));

jest.mock("../../frame-editors/frame-tree/register", () => ({
  register_file_editor: jest.fn(),
}));

jest.mock("../../components", () => ({
  Loading: () => <div>Loading...</div>,
}));

jest.mock("../../frame-editors/code-editor/editor", () => ({
  Editor: () => null,
}));

jest.mock("../../frame-editors/code-editor/actions", () => ({
  Actions: class Actions {},
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: jest.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
});

describe("UnknownEditor", () => {
  beforeEach(() => {
    exec.mockReset();
    actions.open_directory.mockReset();
    actions.close_file.mockReset();
    actions.open_file.mockReset();
  });

  it("falls back cleanly when the file probe command is unavailable", async () => {
    exec
      .mockResolvedValueOnce({
        stdout: "",
        stderr:
          '{"errno":-2,"code":"ENOENT","syscall":"spawn file","path":"file"}',
        exit_code: 1,
      })
      .mockResolvedValueOnce({
        stdout: "hello there\nthis is text\n",
        stderr: "",
        exit_code: 0,
      });

    render(<UnknownEditor project_id="p" path="foo" />);

    await waitFor(() => {
      expect(screen.getByText(/might contain plain text/i)).toBeTruthy();
    });

    expect(screen.queryByText(/^Error$/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /open .* code editor/i }),
    ).toBeTruthy();
  });
});
