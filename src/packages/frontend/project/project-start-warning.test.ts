import { fromJS } from "immutable";

const getStore = jest.fn();
const getProjectActions = jest.fn();
const getActions = jest.fn();
const getIntl = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (...args) => getStore(...args),
    getProjectActions: (...args) => getProjectActions(...args),
    getActions: (...args) => getActions(...args),
  },
}));

jest.mock("@cocalc/frontend/i18n", () => ({
  dialogs: {
    project_start_warning_title: "project_start_warning_title",
    project_start_warning_content: "project_start_warning_content",
  },
}));

jest.mock("@cocalc/frontend/i18n/get-intl", () => ({
  getIntl: (...args) => getIntl(...args),
}));

jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

jest.mock("@cocalc/frontend/projects/host-info", () => ({
  getHostInfo: jest.fn(),
}));

jest.mock("@cocalc/frontend/projects/host-operational", () => ({
  evaluateHostOperational: jest.fn(() => ({ state: "available" })),
}));

import { ensure_project_running } from "./project-start-warning";

describe("ensure_project_running", () => {
  const project_id = "project-1";
  const start_project = jest.fn();
  const wait_until_no_modals = jest.fn();
  const show_modal = jest.fn();
  const clear_modal = jest.fn();

  let modalOpen = false;
  let modalWaiters: Array<() => void> = [];
  let modalResolvers: Array<(value: "ok" | "cancel") => void> = [];

  function flushMicrotasks() {
    return Promise.resolve().then(() => Promise.resolve());
  }

  function resolveNextModal(value: "ok" | "cancel") {
    const resolve = modalResolvers.shift();
    if (!resolve) {
      throw new Error("No modal is waiting to resolve");
    }
    modalOpen = false;
    const waiters = modalWaiters;
    modalWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
    resolve(value);
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    modalOpen = false;
    modalWaiters = [];
    modalResolvers = [];

    const projectsStore = {
      get: (key: string) => {
        if (key === "project_map") {
          return fromJS({
            [project_id]: {
              state: { state: "stopped" },
            },
          });
        }
      },
      get_title: () => "Test Project",
    };

    getStore.mockReturnValue(projectsStore);
    getActions.mockReturnValue({ start_project });
    getIntl.mockResolvedValue({
      formatMessage: (_message, values) =>
        values?.what == null ? "Start Project" : `Start ${values.what}`,
    });

    wait_until_no_modals.mockImplementation(async () => {
      if (!modalOpen) {
        return;
      }
      await new Promise<void>((resolve) => {
        modalWaiters.push(resolve);
      });
    });

    show_modal.mockImplementation(async () => {
      await wait_until_no_modals();
      modalOpen = true;
      return await new Promise<"ok" | "cancel">((resolve) => {
        modalResolvers.push(resolve);
      });
    });

    getProjectActions.mockReturnValue({
      wait_until_no_modals,
      show_modal,
      clear_modal,
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("reuses one start warning for concurrent callers", async () => {
    const first = ensure_project_running(project_id, "open a file");
    const second = ensure_project_running(project_id, "download a file");

    await flushMicrotasks();
    expect(show_modal).toHaveBeenCalledTimes(1);

    resolveNextModal("ok");
    await flushMicrotasks();

    expect(show_modal).toHaveBeenCalledTimes(1);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(start_project).toHaveBeenCalledTimes(1);
  });
});
