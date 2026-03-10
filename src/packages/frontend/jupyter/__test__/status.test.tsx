import * as immutable from "immutable";
import { render, screen } from "@testing-library/react";
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
});
