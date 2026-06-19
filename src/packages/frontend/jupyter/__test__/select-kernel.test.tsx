import * as immutable from "immutable";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { KernelSelector } from "../select-kernel";

const useRedux = jest.fn();
const useTypedRedux = jest.fn();
const isAIAllowedByPolicy = jest.fn();
const mockSubmitNavigatorPromptInWorkspaceChat = jest.fn();
const mockSaveSelectedAgentSession = jest.fn();
const mockSetAutoSubmit = jest.fn();
const mockIsNewAgentThreadSelection = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  CSS: {},
  Rendered: {},
  redux: {
    getStore: (name: string) =>
      name === "projects" ? { isAIAllowedByPolicy } : undefined,
  },
  useRedux: (...args) => useRedux(...args),
  useTypedRedux: (...args) => useTypedRedux(...args),
}));

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

jest.mock("@cocalc/frontend/components", () => ({
  AIAvatar: () => <span>agent-avatar</span>,
  Icon: ({ name }) => <span>{name}</span>,
  Paragraph: ({ children, ...props }) => <p {...props}>{children}</p>,
  Text: ({ children, strong, ...props }) => <span {...props}>{children}</span>,
  Tooltip: ({ children }) => <>{children}</>,
}));

jest.mock("@cocalc/frontend/customize", () => ({
  SiteName: () => <span>CoCalc</span>,
}));

jest.mock("@cocalc/frontend/feature", () => ({
  IS_MOBILE: false,
}));

jest.mock("@cocalc/frontend/project/new/navigator-intents", () => ({
  submitNavigatorPromptInWorkspaceChat: (...args) =>
    mockSubmitNavigatorPromptInWorkspaceChat(...args),
}));

jest.mock("@cocalc/frontend/frame-editors/ai/agent-auto-submit", () => ({
  useAgentAutoSubmit: () => [true, mockSetAutoSubmit],
}));

jest.mock("@cocalc/frontend/frame-editors/ai/agent-session-selector", () => ({
  AgentSessionError: () => null,
  AgentSessionSelect: ({ includeNewThreadOption }: any) => (
    <div>
      Recent agent sessions
      {includeNewThreadOption ? " New agent thread" : ""}
    </div>
  ),
  isNewAgentThreadSelection: (...args) =>
    mockIsNewAgentThreadSelection(...args),
  usePersistentAgentSessionSelection: () => ({
    sessions: [],
    selectedSessionId: undefined,
    selectedAgentSession: undefined,
    setSelectedSessionId: jest.fn(),
    saveSelectedAgentSession: mockSaveSelectedAgentSession,
    loading: false,
    error: "",
  }),
}));

jest.mock("@cocalc/frontend/frame-editors/ai/popup-agent-composer", () => ({
  PopupAgentComposer: ({ value, onChange, onSubmit }: any) => (
    <textarea
      aria-label="agent install prompt"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.ctrlKey) {
          onSubmit(value);
        }
      }}
    />
  ),
}));

jest.mock(
  "@cocalc/frontend/course/configuration/customize-student-project-functionality",
  () => ({
    useStudentProjectFunctionality: () => ({}),
  }),
);

jest.mock("@cocalc/frontend/components/run-button/kernel-star", () => ({
  KernelStar: () => null,
}));

jest.mock("../logo", () => () => <span />);

describe("KernelSelector", () => {
  let originalGetComputedStyle: typeof window.getComputedStyle;

  beforeAll(() => {
    originalGetComputedStyle = window.getComputedStyle;
    window.getComputedStyle = ((elt: Element, pseudoElt?: string | null) => {
      if (pseudoElt) {
        return {
          getPropertyValue: () => "0px",
          height: "0px",
          width: "0px",
        } as any;
      }
      return originalGetComputedStyle(elt);
    }) as typeof window.getComputedStyle;
  });

  afterAll(() => {
    window.getComputedStyle = originalGetComputedStyle;
  });

  beforeEach(() => {
    useRedux.mockReset();
    useTypedRedux.mockReset();
    useTypedRedux.mockReturnValue(immutable.Map());
    isAIAllowedByPolicy.mockReset();
    isAIAllowedByPolicy.mockReturnValue(true);
    mockSubmitNavigatorPromptInWorkspaceChat.mockReset();
    mockSubmitNavigatorPromptInWorkspaceChat.mockResolvedValue(true);
    mockSaveSelectedAgentSession.mockReset();
    mockSetAutoSubmit.mockReset();
    mockIsNewAgentThreadSelection.mockReset();
    mockIsNewAgentThreadSelection.mockReturnValue(false);
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

  it("hides Agent kernel install controls when AI is disabled", () => {
    isAIAllowedByPolicy.mockReturnValue(false);
    const actions = {
      name: "jupyter-test",
      project_id: "project-1",
      path: "notebook.ipynb",
      select_kernel: jest.fn(),
      fetch_jupyter_kernels: jest.fn(),
      hide_select_kernel: jest.fn(),
    } as any;

    useRedux.mockImplementation(([name, key]) => {
      if (name !== "jupyter-test") return;
      switch (key) {
        case "kernel":
          return "";
        case "project_id":
          return "project-1";
        case "kernel_selection":
          return immutable.Map();
        case "kernels_by_name":
          return immutable.OrderedMap();
        case "kernels_by_language":
          return immutable.OrderedMap();
      }
    });

    render(
      <IntlProvider locale="en" messages={{}}>
        <KernelSelector actions={actions} embedded />
      </IntlProvider>,
    );

    expect(screen.queryByText("Agent")).toBeNull();
  });

  it("uses the shared Agent composer flow for popular kernel installs", async () => {
    const actions = {
      name: "jupyter-test",
      project_id: "project-1",
      path: "notebook.ipynb",
      select_kernel: jest.fn(),
      fetch_jupyter_kernels: jest.fn(),
      hide_select_kernel: jest.fn(),
    } as any;

    useRedux.mockImplementation(([name, key]) => {
      if (name !== "jupyter-test") return;
      switch (key) {
        case "kernel":
          return "";
        case "project_id":
          return "project-1";
        case "kernel_selection":
          return immutable.Map();
        case "kernels_by_name":
          return immutable.OrderedMap();
        case "kernels_by_language":
          return immutable.OrderedMap();
      }
    });

    render(
      <IntlProvider locale="en" messages={{}}>
        <KernelSelector actions={actions} embedded />
      </IntlProvider>,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Agent" })[2]);

    const prompt = await screen.findByLabelText("agent install prompt");
    expect(prompt).toHaveValue("Install the Bash Jupyter kernel.");

    fireEvent.change(prompt, {
      target: { value: "Install the bash Jupyter kernel with bash_kernel." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));

    await waitFor(() =>
      expect(mockSubmitNavigatorPromptInWorkspaceChat).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: "project-1",
          path: "notebook.ipynb",
          visiblePrompt: "Install the bash Jupyter kernel with bash_kernel.",
          title: "Install Bash Jupyter kernel",
          tag: "intent:jupyter-install-kernel:bash",
          forceCodex: true,
          codexConfig: { model: "gpt-5.4-mini" },
          openFloating: true,
          waitForAgent: false,
          createNewThread: false,
          submitToAgent: true,
        }),
      ),
    );
    const call = mockSubmitNavigatorPromptInWorkspaceChat.mock.calls[0][0];
    expect(call.prompt).toContain("bash_kernel");
    expect(call.prompt).toContain(
      "User request:\nInstall the bash Jupyter kernel with bash_kernel.",
    );
    expect(mockSaveSelectedAgentSession).toHaveBeenCalled();
  });
});
