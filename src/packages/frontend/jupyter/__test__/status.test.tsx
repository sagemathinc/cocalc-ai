import * as immutable from "immutable";
import { act, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { Kernel } from "../status";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

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
jest.mock("../studio/studio-controls", () => ({
  StudioControls: () => <div />,
}));
jest.mock("../select-kernel", () => ({
  KernelSelector: () => <div />,
}));

describe("Kernel", () => {
  beforeEach(() => {
    useRedux.mockReset();
    getProjectActions.mockReset();
  });

  it.each([false, true])(
    "does not offset the trust button above the header (compact=%s)",
    (compact) => {
      const state = {
        trust: false,
        kernel: "python3",
        kernels: immutable.List(),
        read_only: false,
        backend_state: "running",
        kernel_state: "idle",
        runProgress: 0,
      };
      useRedux.mockImplementation(([, key]) => state[key]);
      getProjectActions.mockReturnValue({ project_id: "project-1" });
      render(
        <IntlProvider locale="en" messages={{}}>
          <Kernel
            actions={{ name: "jupyter-test", project_id: "project-1" } as any}
            compact={compact}
            onLayoutChange={jest.fn()}
          />
        </IntlProvider>,
      );
      const button = screen.getByRole("button", { name: "Not Trusted" });
      expect(button.style.marginTop).toBe("");
      button.focus();
      expect(button).toHaveFocus();
    },
  );

  it.each([false, true])(
    "themes the header (compact=%s) and falls back to actions.project_id",
    (compact) => {
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
          <Kernel actions={actions} compact={compact} />
        </IntlProvider>,
      );

      expect(getProjectActions).toHaveBeenCalledWith("project-1");
      expect(screen.getByText("Python 3 (ipykernel)")).toBeTruthy();
      const name = screen.getByText("Python 3 (ipykernel)");
      expect(name.style.color).toBe(UI_COLORS.link);
      let header: HTMLElement | null = name;
      while (header && !header.style.backgroundColor) {
        header = header.parentElement;
      }
      expect(header?.style.backgroundColor).toBe(UI_COLORS.inset);
      expect(header?.style.color).toBe(UI_COLORS.text);
      expect(header?.style.borderBottom).toBe(`1px solid ${UI_COLORS.border}`);
    },
  );

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

  it("shows the trust indicator in the studio notebook status bar", () => {
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

    // the studio notebook status bar is the compact header with layout
    // controls; unlike other compact embeds it does show the trust state
    render(
      <IntlProvider locale="en" messages={{}}>
        <Kernel
          actions={actions}
          compact
          studioLayout="comfortable"
          onLayoutChange={jest.fn()}
        />
      </IntlProvider>,
    );

    expect(screen.getByText("Trusted")).toBeTruthy();
  });

  it("keeps the kernel header visible while kernel selection is undecided", () => {
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
          return undefined;
        case "kernels":
          return immutable.List();
        case "runProgress":
          return 0;
        case "project_id":
          return "project-1";
        case "kernel_info":
          return undefined;
        case "show_kernel_selector":
          return false;
        case "backend_state":
          return "off";
        case "kernel_state":
          return undefined;
      }
    });

    getProjectActions.mockReturnValue({ project_id: "project-1" });

    render(
      <IntlProvider locale="en" messages={{}}>
        <Kernel actions={actions} />
      </IntlProvider>,
    );

    expect(screen.getByText("No Kernel")).toBeTruthy();
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
  describe("usage meters", () => {
    function renderUsage(extra: any, remote = false) {
      const actions = {
        name: "jupyter-test",
        project_id: "project-1",
        show_select_kernel: jest.fn(),
        hide_select_kernel: jest.fn(),
        kernel_dont_ask_again: jest.fn(),
        set_kernel: jest.fn(),
      } as any;

      useRedux.mockImplementation(([name, key]) => {
        if (name !== "jupyter-test") return;
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
            return 40;
          case "project_id":
            return "project-1";
          case "kernel_info":
            return immutable.fromJS({
              display_name: "Python 3 (ipykernel)",
              metadata: { reflect: { remote } },
            });
          case "show_kernel_selector":
            return false;
          case "backend_state":
            return "running";
          case "kernel_state":
            return "idle";
        }
      });
      getProjectActions.mockReturnValue({ project_id: "project-1" });

      return render(
        <IntlProvider locale="en" messages={{}}>
          <Kernel
            actions={actions}
            compact
            studioLayout="comfortable"
            onLayoutChange={jest.fn()}
            expected_cell_runtime={10}
            usage={
              {
                cpu: 10,
                cpu_runtime: 5,
                mem: 100,
                mem_pct: 30,
                mem_alert: "none",
                cpu_alert: "none",
                time_alert: "none",
              } as any
            }
            {...extra}
          />
        </IntlProvider>,
      );
    }

    it("labels each meter when there is room for the full-size version", () => {
      renderUsage({});
      expect(screen.getByText("Code")).toBeTruthy();
      expect(screen.getByText("CPU")).toBeTruthy();
      expect(screen.getByText("RAM")).toBeTruthy();
    });

    it("does not attribute local CPU and RAM readings to remote kernels", () => {
      const { container } = renderUsage({}, true);
      expect(screen.queryByText("CPU")).toBeNull();
      expect(screen.queryByText("RAM")).toBeNull();
      expect(container.querySelector('[aria-label="RAM"]')).toBeNull();
    });

    it("plumbs the actual readings into the compact bars", () => {
      const { container } = renderUsage({ usageDisplay: "mini" as const });
      const valueOf = (label: string) =>
        container
          .querySelector(`[aria-label="${label}"]`)
          ?.querySelector("[aria-valuenow]")
          ?.getAttribute("aria-valuenow") ??
        container
          .querySelector(`[aria-label="${label}"]`)
          ?.getAttribute("aria-valuenow");

      // runProgress is 40, mem_pct is 30, cpu_runtime/expected_cell_runtime
      // is 5/10 -> 50
      expect(valueOf("Code")).toBe("40");
      expect(valueOf("RAM")).toBe("30");
      expect(valueOf("CPU")).toBe("50");
    });

    it("uses the same compact meters in the classic status bar", () => {
      // the classic bar carries fewer controls, but it runs out of room too
      const { container } = renderUsage({
        compact: false,
        studioLayout: undefined,
        onLayoutChange: undefined,
        usageDisplay: "mini" as const,
      });

      expect(screen.queryByText("CPU")).toBeNull();
      expect(container.querySelectorAll('[aria-label="CPU"]').length).toBe(1);
      expect(container.querySelectorAll('[aria-label="RAM"]').length).toBe(1);
    });

    it("drops the text labels but keeps every reading when narrow", () => {
      const { container } = renderUsage({ usageDisplay: "mini" as const });

      // The labels are what cost the horizontal space, so they go...
      expect(screen.queryByText("CPU")).toBeNull();
      expect(screen.queryByText("RAM")).toBeNull();
      expect(screen.queryByText("Code")).toBeNull();

      // ...but all three readings are still shown, and still named for
      // assistive technology.
      expect(container.querySelectorAll('[aria-label="Code"]').length).toBe(1);
      expect(container.querySelectorAll('[aria-label="CPU"]').length).toBe(1);
      expect(container.querySelectorAll('[aria-label="RAM"]').length).toBe(1);
    });
  });
});
