import * as immutable from "immutable";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { KernelSelector } from "../select-kernel";

const useRedux = jest.fn();
const useTypedRedux = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  CSS: {},
  Rendered: {},
  useRedux: (...args) => useRedux(...args),
  useTypedRedux: (...args) => useTypedRedux(...args),
}));

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

jest.mock("@cocalc/frontend/components", () => ({
  Icon: ({ name }) => <span>{name}</span>,
  Paragraph: ({ children, ...props }) => <p {...props}>{children}</p>,
  Text: ({ children, ...props }) => <span {...props}>{children}</span>,
  Tooltip: ({ children }) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/customize", () => ({
  SiteName: () => <span>CoCalc</span>,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  submitNavigatorPromptInWorkspaceChat: jest.fn(),
  submitNavigatorPromptToCurrentThread: jest.fn(),
}));

jest.mock("@cocalc/frontend/user-tracking", () => jest.fn());

jest.mock("@cocalc/frontend/components/run-button/kernel-star", () => ({
  KernelStar: () => null,
}));

jest.mock("../logo", () => () => <span />);

describe("KernelSelector", () => {
  beforeEach(() => {
    useRedux.mockReset();
    useTypedRedux.mockReset();
    useTypedRedux.mockReturnValue(immutable.Map());
  });

  it("keeps an install-kernel path visible when kernels already exist", () => {
    const actions = {
      name: "jupyter-test",
      project_id: "project-1",
      path: "notebook.ipynb",
      select_kernel: jest.fn(),
      fetch_jupyter_kernels: jest.fn(),
      hide_select_kernel: jest.fn(),
    } as any;
    const kernelsByName = immutable.OrderedMap([
      [
        "python3",
        immutable.fromJS({
          name: "python3",
          display_name: "Python 3",
          language: "python",
          metadata: { cocalc: { priority: 20 } },
        }),
      ],
    ]);
    const kernelsByLanguage = immutable.OrderedMap([
      ["python", immutable.List(["python3"])],
    ]);

    useRedux.mockImplementation(([name, key]) => {
      if (name !== "jupyter-test") {
        return;
      }
      switch (key) {
        case "kernel":
          return "python3";
        case "default_kernel":
          return "python3";
        case "kernel_info":
          return immutable.fromJS({ display_name: "Python 3" });
        case "kernel_selection":
          return immutable.Map({ python: "python3" });
        case "project_id":
          return "project-1";
        case "kernels_by_name":
          return kernelsByName;
        case "kernels_by_language":
          return kernelsByLanguage;
      }
    });

    render(
      <IntlProvider locale="en" messages={{}}>
        <KernelSelector actions={actions} embedded />
      </IntlProvider>,
    );

    expect(screen.getByText("Install")).toBeTruthy();
  });
});
