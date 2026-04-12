import * as immutable from "immutable";
import { act, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { Kernel } from "../status";

const useRedux = jest.fn();
const getProjectActions = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  React: require("react"),
  CSS: {},
  useRedux: (...args) => useRedux(...args),
  redux: {
    getProjectActions: (...args) => getProjectActions(...args),
  },
}));

jest.mock("@cocalc/frontend/components", () => ({
  A: ({ children, ...props }) => <a {...props}>{children}</a>,
  Icon: ({ name }) => <span>{name}</span>,
  Loading: () => <span>loading</span>,
  IconName: {},
  Tooltip: ({ children }) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("../../components/progress-estimate", () => () => <div />);
jest.mock("../logo", () => () => <div />);
jest.mock("../select-kernel", () => ({
  KernelSelector: () => <div />,
}));

describe("Kernel", () => {
  beforeEach(() => {
    useRedux.mockReset();
    getProjectActions.mockReset();
  });

  it("falls back to actions.project_id when redux project_id is not set yet", () => {
    const actions = {
      name: "jupyter-test",
      project_id: "project-1",
      show_select_kernel: jest.fn(),
      hide_select_kernel: jest.fn(),
      kernel_dont_ask_again: jest.fn(),
      set_kernel: jest.fn(),
    } as any;

    useRedux.mockImplementation(([name, key]) => {
      if (name !== "jupyter-test") {
        return;
      }
      switch (key) {
        case "trust":
          return true;
        case "read_only":
          return false;
        case "kernel":
          return "python3";
        case "kernels":
          return immutable.List();
        case "runProgress":
          return 0;
        case "project_id":
          return undefined;
        case "kernel_info":
          return immutable.fromJS({ display_name: "Python 3 (ipykernel)" });
        case "show_kernel_selector":
          return false;
        case "backend_state":
          return "off";
        case "kernel_state":
          return "idle";
      }
    });

    getProjectActions.mockReturnValue({ project_id: "project-1" });

    render(
      <IntlProvider locale="en" messages={{}}>
        <Kernel actions={actions} />
      </IntlProvider>,
    );

    expect(getProjectActions).toHaveBeenCalledWith("project-1");
    expect(screen.getByText("Python 3 (ipykernel)")).toBeTruthy();
  });

  it("renders a compact embedded header without trust text or halt actions", () => {
    const actions = {
      name: "jupyter-test",
      project_id: "project-1",
      show_select_kernel: jest.fn(),
      hide_select_kernel: jest.fn(),
      kernel_dont_ask_again: jest.fn(),
      set_kernel: jest.fn(),
    } as any;

    useRedux.mockImplementation(([name, key]) => {
      if (name !== "jupyter-test") {
        return;
      }
      switch (key) {
        case "trust":
          return true;
        case "read_only":
          return false;
        case "kernel":
          return "python3";
        case "kernels":
          return immutable.List();
        case "runProgress":
          return 0;
        case "project_id":
          return "project-1";
        case "kernel_info":
          return immutable.fromJS({ display_name: "Python 3 (ipykernel)" });
        case "show_kernel_selector":
          return false;
        case "backend_state":
          return "running";
        case "kernel_state":
          return "idle";
      }
    });

    getProjectActions.mockReturnValue({ project_id: "project-1" });

    render(
      <IntlProvider locale="en" messages={{}}>
        <Kernel actions={actions} compact />
      </IntlProvider>,
    );

    expect(screen.getByText("Python 3 (ipykernel)")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
    expect(screen.queryByText("Trusted")).toBeNull();
    expect(screen.queryByText(/\(halt/i)).toBeNull();
  });

  it("smooths brief busy and idle transitions for kernel display state", async () => {
    jest.useFakeTimers();
    try {
      const actions = {
        name: "jupyter-test",
        project_id: "project-1",
        show_select_kernel: jest.fn(),
        hide_select_kernel: jest.fn(),
        kernel_dont_ask_again: jest.fn(),
        set_kernel: jest.fn(),
      } as any;

      const state = {
        trust: true,
        read_only: false,
        kernel: "python3",
        kernels: immutable.List(),
        runProgress: 0,
        project_id: "project-1",
        kernel_info: immutable.fromJS({ display_name: "Python 3 (ipykernel)" }),
        show_kernel_selector: false,
        backend_state: "running",
        kernel_state: "idle",
      } as Record<string, any>;

      useRedux.mockImplementation(([name, key]) => {
        if (name !== "jupyter-test") {
          return;
        }
        return state[key];
      });
      getProjectActions.mockReturnValue({ project_id: "project-1" });

      const renderView = () => (
        <IntlProvider locale="en" messages={{}}>
          <Kernel actions={actions} compact />
        </IntlProvider>
      );

      const { rerender } = render(renderView());
      expect(screen.getByText("Idle")).toBeTruthy();

      state.kernel_state = "busy";
      rerender(renderView());
      expect(screen.getByText("Idle")).toBeTruthy();

      await act(async () => {
        jest.advanceTimersByTime(349);
      });
      expect(screen.getByText("Idle")).toBeTruthy();

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.getByText("Busy")).toBeTruthy();

      state.kernel_state = "idle";
      rerender(renderView());
      expect(screen.getByText("Busy")).toBeTruthy();

      await act(async () => {
        jest.advanceTimersByTime(999);
      });
      expect(screen.getByText("Busy")).toBeTruthy();

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.getByText("Idle")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
