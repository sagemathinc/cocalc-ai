const mockStateSlots: any[] = [];
const mockEffectSlots: {
  deps?: unknown[];
  cleanup?: () => void;
}[] = [];
let mockHookIndex = 0;

function mockDepsChanged(prev: unknown[] | undefined, next: unknown[]) {
  return (
    prev == null ||
    prev.length !== next.length ||
    prev.some((value, i) => value !== next[i])
  );
}

function mockResetHookCursor() {
  mockHookIndex = 0;
}

function mockResetHooks() {
  for (const slot of mockEffectSlots) {
    slot?.cleanup?.();
  }
  mockStateSlots.length = 0;
  mockEffectSlots.length = 0;
  mockHookIndex = 0;
}

jest.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void), inputs: unknown[] = []) => {
    const i = mockHookIndex++;
    const slot = (mockEffectSlots[i] ??= {});
    if (!mockDepsChanged(slot.deps, inputs)) {
      return;
    }
    slot.cleanup?.();
    slot.deps = inputs;
    slot.cleanup = effect() ?? undefined;
  },
  useState: (initial: unknown) => {
    const i = mockHookIndex++;
    if (!(i in mockStateSlots)) {
      mockStateSlots[i] = typeof initial === "function" ? initial() : initial;
    }
    const setState = (next: unknown) => {
      mockStateSlots[i] =
        typeof next === "function" ? next(mockStateSlots[i]) : next;
    };
    return [mockStateSlots[i], setState];
  },
}));

jest.mock("@cocalc/util/async-utils", () => ({
  sleep: jest.fn(() => Promise.resolve()),
  withTimeout: jest.fn(async (promise: Promise<any>) => await promise),
}));

const loggerWarn = jest.fn();
jest.mock("@cocalc/conat/logger", () => ({
  getLogger: () => ({
    warn: loggerWarn,
  }),
}));

const projectFs = jest.fn();
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      projectFs: (...args: any[]) => projectFs(...args),
    },
  },
}));

const mockProjectContext = {
  publicDirectoryShare: undefined as undefined | { id: string },
};
jest.mock("@cocalc/frontend/project/context", () => ({
  useProjectContext: () => mockProjectContext,
}));

import { sleep, withTimeout } from "@cocalc/util/async-utils";
import useFs from "./use-fs";

async function flushEffects() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

function useFsForTest(project_id: string) {
  mockResetHookCursor();
  return useFs({ project_id });
}

describe("useFs", () => {
  beforeEach(() => {
    mockResetHooks();
    jest.clearAllMocks();
  });

  afterEach(() => {
    mockResetHooks();
  });

  it("retries transient projectFs bootstrap failures and recovers", async () => {
    const transientErr: any = new Error(
      "failed to sign in - Error: too many authentication failures from ip:1.2.3.4; retry in about 51s",
    );
    transientErr.code = "408";
    const fs = { readdir: jest.fn() } as any;
    projectFs.mockRejectedValueOnce(transientErr).mockResolvedValueOnce(fs);

    useFsForTest("project-1");
    await flushEffects();

    const result = useFsForTest("project-1");
    expect(projectFs).toHaveBeenCalledTimes(2);
    expect(projectFs).toHaveBeenNthCalledWith(1, {
      project_id: "project-1",
      caller: "useFs",
    });
    expect(projectFs).toHaveBeenNthCalledWith(2, {
      project_id: "project-1",
      caller: "useFs",
    });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(loggerWarn).toHaveBeenCalled();
    expect(result).toBe(fs);
  });

  it("retries project-host routing warmup failures and recovers", async () => {
    const transientErr = new Error(
      "unable to route 'useFs' to project-host for project project-3; host routing info unavailable",
    );
    const fs = { readdir: jest.fn() } as any;
    projectFs.mockRejectedValueOnce(transientErr).mockResolvedValueOnce(fs);

    useFsForTest("project-3");
    await flushEffects();

    const result = useFsForTest("project-3");
    expect(projectFs).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(result).toBe(fs);
  });

  it("retries project startup not-running failures and recovers", async () => {
    const transientErr = new Error("project not running");
    const fs = { readdir: jest.fn() } as any;
    projectFs.mockRejectedValueOnce(transientErr).mockResolvedValueOnce(fs);

    useFsForTest("project-4");
    await flushEffects();

    const result = useFsForTest("project-4");
    expect(projectFs).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(result).toBe(fs);
  });

  it("retries a hung projectFs bootstrap after timeout", async () => {
    const fs = { readdir: jest.fn() } as any;
    (withTimeout as jest.Mock)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockImplementation(async (promise: Promise<any>) => await promise);
    projectFs.mockResolvedValue(fs);

    useFsForTest("project-5");
    await flushEffects();

    const result = useFsForTest("project-5");
    expect(projectFs).toHaveBeenCalledTimes(2);
    expect(withTimeout).toHaveBeenCalledWith(expect.any(Promise), 10000);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(result).toBe(fs);
  });

  it("does not retry non-retryable projectFs failures", async () => {
    projectFs.mockRejectedValueOnce(new Error("permission denied"));

    useFsForTest("project-2");
    await flushEffects();

    const result = useFsForTest("project-2");
    expect(projectFs).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
