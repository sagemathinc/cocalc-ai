import { act, render, screen, waitFor } from "@testing-library/react";
import { fromJS } from "immutable";
import userEvent from "@testing-library/user-event";

import { NBConvert } from "./nbconvert";

const downloadFile = jest.fn();
const getProjectStore = jest.fn(() => ({
  fileURL: (path: string) => `/files/${path}`,
}));

jest.mock("antd", () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
  Modal: jest.requireActual("antd").Modal,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getProjectActions: () => ({ download_file: downloadFile }),
    getProjectStore: (...args: any[]) => getProjectStore(...args),
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  A: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  Icon: ({ name }: any) => <span>{name}</span>,
  Loading: () => <span>loading</span>,
  TimeAgo: () => <span>recently</span>,
}));

jest.mock("@cocalc/frontend/components/progress-estimate", () => () => null);

jest.mock("@cocalc/frontend/components/copy-button", () => ({
  __esModule: true,
  default: ({ ariaLabel, value }: any) => (
    <button aria-label={ariaLabel} data-copy-value={value}>
      Copy
    </button>
  ),
}));

function createActions(fileExtension = ".py") {
  return {
    project_id: "project-1",
    store: {
      get_language_info: () => ({ file_extension: fileExtension }),
    },
    focus: jest.fn(),
    nbconvert: jest.fn(),
    cancel_nbconvert_startup: jest.fn(),
    setState: jest.fn(),
  } as any;
}

describe("NBConvert", () => {
  const getComputedStyle = window.getComputedStyle;
  beforeAll(() => {
    // JSDOM has no pseudo-element layout for the real Modal's scrollbar probe.
    jest
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element) => getComputedStyle(element));
  });
  afterAll(() => jest.restoreAllMocks());
  it("allows keyboard cancellation and restores editor focus", async () => {
    const actions = createActions();
    const user = userEvent.setup();
    render(
      <NBConvert
        actions={actions}
        path="test.ipynb"
        project_id="project-1"
        nbconvert_dialog={fromJS({ to: "pdf" })}
        nbconvert={fromJS({ state: "start", phase: "initialization" })}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("30 seconds");
    screen.getByRole("button", { name: "Cancel export startup" }).focus();
    expect(
      screen.getByRole("button", { name: "Cancel export startup" }),
    ).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(actions.cancel_nbconvert_startup).toHaveBeenCalledTimes(1);
    expect(actions.setState).toHaveBeenCalledWith({
      nbconvert_dialog: undefined,
    });
    expect(actions.focus).toHaveBeenCalledWith(true);
  });
  it("cancels pending startup with Escape from the actual dialog", async () => {
    const actions = createActions();
    const user = userEvent.setup();
    render(
      <NBConvert
        actions={actions}
        path="test.ipynb"
        project_id="project-1"
        nbconvert_dialog={fromJS({ to: "pdf" })}
        nbconvert={fromJS({ state: "start", phase: "initialization" })}
      />,
    );
    const dialog = screen.getByRole("dialog", {
      name: /Save and Download as PDF via nbconvert and LaTeX/,
    });
    expect(dialog).toContainElement(
      screen.getByRole("button", { name: "Cancel export startup" }),
    );
    screen.getByRole("button", { name: "Cancel export startup" }).focus();
    await user.keyboard("{Escape}");
    expect(actions.cancel_nbconvert_startup).toHaveBeenCalledTimes(1);
    expect(actions.focus).toHaveBeenCalledWith(true);
  });
  it("announces startup failure, offers keyboard retry, and does not download", async () => {
    const actions = createActions();
    const dialog = fromJS({ to: "pdf" });
    const user = userEvent.setup();
    const props = {
      actions,
      path: "test.ipynb",
      project_id: "project-1",
      nbconvert_dialog: dialog,
    };
    const { rerender } = render(
      <NBConvert
        {...props}
        nbconvert={fromJS({ state: "start", phase: "initialization" })}
      />,
    );
    rerender(
      <NBConvert
        {...props}
        nbconvert={fromJS({
          state: "done",
          phase: "initialization",
          args: ["--to", "pdf"],
          time: Date.now(),
          error: "Permission denied",
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Export did not start");
    expect(downloadFile).not.toHaveBeenCalled();
    const retry = screen.getByRole("button", { name: "Retry export" });
    retry.focus();
    expect(retry).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(actions.nbconvert).toHaveBeenCalledTimes(1);
    expect(actions.nbconvert).toHaveBeenCalledWith(["--to", "pdf"]);
  });
  beforeEach(() => {
    downloadFile.mockReset();
    getProjectStore.mockClear();
  });

  it("starts executable script export without requesting obsolete backend kernel info", async () => {
    const actions = createActions();

    render(
      <NBConvert
        actions={actions}
        path="notebook.ipynb"
        project_id="project-1"
        nbconvert_dialog={fromJS({ to: "script" })}
      />,
    );

    await waitFor(() => {
      expect(actions.nbconvert).toHaveBeenCalledWith(["--to", "script"]);
    });
  });

  it("downloads an exported script using the notebook language extension", async () => {
    const actions = createActions(".R");
    const dialog = fromJS({ to: "script" });
    const { rerender } = render(
      <NBConvert
        actions={actions}
        path="analysis.ipynb"
        project_id="project-1"
        nbconvert={fromJS({ state: "run" })}
        nbconvert_dialog={dialog}
      />,
    );

    rerender(
      <NBConvert
        actions={actions}
        path="analysis.ipynb"
        project_id="project-1"
        nbconvert={fromJS({
          state: "done",
          args: ["--to", "script"],
          time: Date.now(),
        })}
        nbconvert_dialog={dialog}
      />,
    );

    await waitFor(() => {
      expect(downloadFile).toHaveBeenCalledWith({ path: "analysis.R" });
    });
  });

  it("uses the output path reported by the project-side converter", async () => {
    const actions = createActions(".py");
    const dialog = fromJS({ to: "script" });
    const { rerender } = render(
      <NBConvert
        actions={actions}
        path="analysis.ipynb"
        project_id="project-1"
        nbconvert={fromJS({ state: "run" })}
        nbconvert_dialog={dialog}
      />,
    );

    rerender(
      <NBConvert
        actions={actions}
        path="analysis.ipynb"
        project_id="project-1"
        nbconvert={fromJS({
          state: "done",
          args: ["--to", "script"],
          output: "/home/user/analysis.txt",
          time: Date.now(),
        })}
        nbconvert_dialog={dialog}
      />,
    );

    await waitFor(() => {
      expect(downloadFile).toHaveBeenCalledWith({
        path: "/home/user/analysis.txt",
      });
    });
  });

  it("shows a bounded, copyable error log", () => {
    const error =
      "Traceback\nnbconvert/exporters/pdf.py\nfinal conversion error";

    render(
      <NBConvert
        actions={createActions()}
        path="analysis.ipynb"
        project_id="project-1"
        nbconvert={fromJS({
          state: "done",
          args: ["--to", "pdf"],
          error,
          time: Date.now(),
        })}
        nbconvert_dialog={fromJS({ to: "pdf" })}
      />,
    );

    const log = screen.getByRole("region", { name: "nbconvert error log" });
    expect(log.textContent).toBe(error);
    expect(log).toHaveAttribute("tabindex", "0");
    expect(log).toHaveStyle({ maxHeight: "45vh", overflow: "auto" });
    expect(
      screen.getByRole("button", { name: "Copy full error log" }),
    ).toHaveAttribute("data-copy-value", error);
    expect(screen.getByText(/Copy the full log/)).toBeInTheDocument();
    expect(screen.queryByText(/restart your/i)).not.toBeInTheDocument();
  });

  it("scrolls the error log without a global jQuery", () => {
    jest.useFakeTimers();
    const previous = globalThis.$;
    delete (globalThis as any).$;
    try {
      const { unmount } = render(
        <NBConvert
          actions={createActions()}
          path="analysis.ipynb"
          project_id="project-1"
          nbconvert={fromJS({
            state: "done",
            args: ["--to", "pdf"],
            error: "Conversion failed",
            time: Date.now(),
          })}
          nbconvert_dialog={fromJS({ to: "pdf" })}
        />,
      );
      const log = screen.getByRole("region", { name: "nbconvert error log" });
      Object.defineProperty(log, "scrollHeight", { value: 500 });
      act(() => jest.advanceTimersByTime(10));
      expect(log.scrollTop).toBe(500);
      unmount();
      act(() => jest.runOnlyPendingTimers());
    } finally {
      globalThis.$ = previous;
      jest.useRealTimers();
    }
  });
});
