/** @jest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { openAppDocs } from "@cocalc/frontend/docs/navigation";
import {
  assessExamHostCapacity,
  examRootfsCatalogEntries,
  HostExamPanel,
} from "./host-exam-panel";

const mockGetHostExamState = jest.fn(async () => ({ eligible: true }));
const mockSetHostExamConfig = jest.fn();
const mockCreateHostExamRun = jest.fn();
const mockIncreaseHostExamCapacity = jest.fn();
let mockRootfsCatalog = { images: [] as any[], loading: false };
const mockRunFreshAuthAction = jest.fn(
  async (action: () => Promise<unknown>) => {
    await action();
    return true;
  },
);

jest.mock("@cocalc/frontend/docs/navigation", () => ({
  openAppDocs: jest.fn(),
}));

jest.mock("@cocalc/frontend/rootfs/manifest", () => ({
  managedRootfsCatalogUrl: () => "/rootfs/manifest.json",
  useRootfsImages: () => mockRootfsCatalog,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    browser_id: "browser-1",
    conat_client: {
      hub: {
        hosts: {
          getHostExamState: (...args: any[]) => mockGetHostExamState(...args),
          setHostExamConfig: (...args: any[]) => mockSetHostExamConfig(...args),
          createHostExamRun: (...args: any[]) => mockCreateHostExamRun(...args),
          increaseHostExamCapacity: (...args: any[]) =>
            mockIncreaseHostExamCapacity(...args),
        },
      },
    },
  },
}));

jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    freshAuthModalProps: {},
    runFreshAuthAction: (...args: any[]) => mockRunFreshAuthAction(...args),
  }),
}));

describe("HostExamPanel", () => {
  const savedConfig = {
    host_id: "host-1",
    enabled: true,
    title: "Exam Scratchpad",
    hostname: "exam-host-1.example.test",
    generation: 1,
    max_projects: 100,
    project_cpu: 1,
    project_memory_mb: 2_000,
    project_disk_mb: 5_000,
    project_ttl_minutes: 360,
    cleanup_grace_minutes: 10,
    terminal_enabled: false,
    network_mode: "disabled" as const,
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
    created_by: "account-1",
    updated_by: "account-1",
  };

  beforeEach(() => {
    mockGetHostExamState.mockClear();
    mockSetHostExamConfig.mockReset();
    mockCreateHostExamRun.mockReset();
    mockIncreaseHostExamCapacity.mockReset();
    mockRootfsCatalog = { images: [], loading: false };
    mockRunFreshAuthAction.mockReset();
    mockRunFreshAuthAction.mockImplementation(
      async (action: () => Promise<unknown>) => {
        await action();
        return true;
      },
    );
  });

  it("translates maximum projects into conservative host guidance", () => {
    expect(
      assessExamHostCapacity({ maxProjects: 200, cpu: 8, ramGiB: 104 }),
    ).toEqual({
      level: "success",
      recommendedCpu: 8,
      recommendedRamGiB: 104,
    });
    expect(
      assessExamHostCapacity({ maxProjects: 200, cpu: 8, ramGiB: 50 }),
    ).toEqual({
      level: "close",
      recommendedCpu: 8,
      recommendedRamGiB: 104,
    });
    expect(
      assessExamHostCapacity({ maxProjects: 200, cpu: 2, ramGiB: 32 }),
    ).toEqual({
      level: "warning",
      recommendedCpu: 8,
      recommendedRamGiB: 104,
    });
  });

  it("does not claim that capacity is sufficient without host metrics", () => {
    expect(assessExamHostCapacity({ maxProjects: 20 })).toEqual({
      level: "unknown",
      recommendedCpu: 8,
      recommendedRamGiB: 14,
    });
  });

  it("enriches cached host images with project-creation catalog metadata", () => {
    expect(
      examRootfsCatalogEntries({
        cachedImages: [
          {
            image: "cocalc.local/rootfs/sage",
            digest: "sha256:cached",
          } as any,
        ],
        catalogImages: [
          {
            id: "sage",
            label: "SageMath",
            image: "cocalc.local/rootfs/sage",
            description: "Computational mathematics",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "sage",
        label: "SageMath",
        digest: "sha256:cached",
      }),
    ]);
  });

  it("includes managed catalog images that are not cached yet", () => {
    expect(
      examRootfsCatalogEntries({
        cachedImages: [],
        catalogImages: [
          {
            id: "sage",
            label: "SageMath",
            image: "cocalc.local/rootfs/sage",
            description: "Computational mathematics",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "sage",
        label: "SageMath",
        image: "cocalc.local/rootfs/sage",
      }),
    ]);
  });

  it("opens the exam scratchpad documentation entry", () => {
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Read the setup, testing, and cleanup guide\./,
      }),
    );

    expect(openAppDocs).toHaveBeenCalledWith("hosts/exam-scratchpads");
  });

  it("shows a successful host capacity check", () => {
    render(
      <HostExamPanel
        host={
          {
            id: "host-1",
            status: "running",
            host_cpu_count: 16,
            host_ram_gb: 64,
          } as any
        }
        rootfsImages={[]}
      />,
    );

    expect(
      screen.getByText("Host capacity meets the exam guideline"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/For 100 simultaneous students.*54 GB RAM/),
    ).toBeInTheDocument();
  });

  it("warns without blocking when the exam host uses Spot capacity", () => {
    render(
      <HostExamPanel
        host={
          {
            id: "host-1",
            status: "running",
            pricing_model: "spot",
          } as any
        }
        rootfsImages={[]}
      />,
    );

    expect(
      screen.getByText("Spot capacity can be interrupted during an exam"),
    ).toBeInTheDocument();
    expect(screen.getByText(/use Standard\/on-demand capacity/i)).toBeVisible();
  });

  it("selects an uncached managed catalog image for preparation", async () => {
    mockRootfsCatalog = {
      loading: false,
      images: [
        {
          id: "sage",
          release_id: "release-sage",
          label: "SageMath",
          image: "cocalc.local/rootfs/sage",
          tags: ["preset:standard"],
        },
        {
          id: "teaching",
          release_id: "release-teaching",
          label: "Teaching Python",
          image: "cocalc.local/rootfs/teaching",
          tags: ["preset:teaching"],
        },
      ],
    };
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      config: savedConfig,
    });
    mockCreateHostExamRun.mockResolvedValue({
      eligible: true,
      config: savedConfig,
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    expect(await screen.findByText("SageMath")).toBeVisible();
    expect(screen.queryByText("Teaching Python")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Teaching" }));
    expect(await screen.findByText("Teaching Python")).toBeVisible();
    fireEvent.click(screen.getByText("Teaching Python"));

    const prepare = screen.getByRole("button", {
      name: "Prepare and test run",
    });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    await waitFor(() =>
      expect(mockCreateHostExamRun).toHaveBeenCalledWith(
        expect.objectContaining({
          rootfs_image: "cocalc.local/rootfs/teaching",
        }),
      ),
    );
  });

  it("only enables configuration saving after a field changes", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      config: savedConfig,
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    const save = screen.getByRole("button", { name: "Save configuration" });
    await waitFor(() => expect(save).toBeDisabled());

    fireEvent.change(screen.getAllByRole("spinbutton")[0], {
      target: { value: "101" },
    });
    expect(save).toBeEnabled();
  });

  it("uses authoritative exam state to disable preparation when stopped", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      host_status: "off",
      config: savedConfig,
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[
          {
            image: "cocalc.local/rootfs/exam",
            digest: "sha256:abc",
          } as any,
        ]}
      />,
    );

    expect(
      await screen.findByText("Start the project host to prepare an exam"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Prepare and test run" }),
    ).toBeDisabled();
  });

  it("labels cleanup and defaults to shutting down the host", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      config: savedConfig,
    });
    mockCreateHostExamRun.mockResolvedValue({
      eligible: true,
      config: savedConfig,
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[
          {
            image: "cocalc.local/rootfs/exam",
            digest: "sha256:abc",
          } as any,
        ]}
      />,
    );

    expect(screen.getByText("Delete all exam projects at")).toBeInTheDocument();
    const shutdown = screen.getByRole("checkbox", {
      name: "Also shut down the project host to save resources",
    });
    expect(shutdown).toBeChecked();
    const prepare = screen.getByRole("button", {
      name: "Prepare and test run",
    });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(shutdown);
    expect(shutdown).not.toBeChecked();
    fireEvent.click(prepare);
    await waitFor(() => expect(mockCreateHostExamRun).toHaveBeenCalled());
    expect(mockCreateHostExamRun).toHaveBeenCalledWith(
      expect.objectContaining({
        stop_host_at_deadline: false,
        timeout: 12 * 60_000,
      }),
    );
  });

  it("prepares practice runs without a cleanup deadline", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      config: savedConfig,
    });
    mockCreateHostExamRun.mockResolvedValue({
      eligible: true,
      config: savedConfig,
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[
          {
            image: "cocalc.local/rootfs/exam",
            digest: "sha256:abc",
          } as any,
        ]}
      />,
    );

    const prepare = screen.getByRole("button", {
      name: "Prepare and test run",
    });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Practice mode: erase projects manually (no automatic timeout)",
      }),
    );
    expect(
      screen.getByText("Projects remain until you end and erase the session"),
    ).toBeVisible();
    const practicePrepare = screen.getByRole("button", {
      name: "Prepare and test run",
    });
    expect(practicePrepare).toBeEnabled();
    fireEvent.click(practicePrepare);

    await waitFor(() => expect(mockCreateHostExamRun).toHaveBeenCalled());
    expect(mockCreateHostExamRun).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanup_mode: "manual",
        scheduled_stop_at: undefined,
        stop_host_at_deadline: false,
      }),
    );
  });

  it("reuses one idempotency key when fresh auth retries preparation", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      config: savedConfig,
    });
    mockCreateHostExamRun.mockResolvedValue({
      eligible: true,
      config: savedConfig,
    });
    mockRunFreshAuthAction.mockImplementation(async (action) => {
      await action();
      await action();
      return true;
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[
          {
            image: "cocalc.local/rootfs/exam",
            digest: "sha256:abc",
          } as any,
        ]}
      />,
    );

    const prepare = screen.getByRole("button", {
      name: "Prepare and test run",
    });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    await waitFor(() => expect(mockCreateHostExamRun).toHaveBeenCalledTimes(2));

    const firstKey = mockCreateHostExamRun.mock.calls[0][0].idempotency_key;
    const secondKey = mockCreateHostExamRun.mock.calls[1][0].idempotency_key;
    expect(firstKey).toMatch(/^create:/);
    expect(secondKey).toBe(firstKey);
  });

  it("explains the full rehearsal while preparation is running", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      config: savedConfig,
    });
    let finishPreparation!: (value: unknown) => void;
    mockCreateHostExamRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPreparation = resolve;
        }),
    );
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[
          {
            image: "cocalc.local/rootfs/exam",
            digest: "sha256:abc",
          } as any,
        ]}
      />,
    );

    expect(
      screen.getByText("Preparation runs a complete rehearsal"),
    ).toBeInTheDocument();
    const prepare = screen.getByRole("button", {
      name: "Prepare and test run",
    });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);

    expect(
      await screen.findByText(/creating a smoke-test project/i),
    ).toBeInTheDocument();
    // Progress replaces the static explanation inside the prepare card, where
    // the button was pressed, rather than dimming the whole tab.
    const progress = screen.getByRole("status");
    expect(progress).toHaveTextContent(
      "Preparing and testing the exam environment",
    );
    expect(progress.closest(".ant-card")).toHaveTextContent(
      "Prepare an exam run",
    );
    expect(
      screen.getAllByText(/A first download may take several minutes/),
    ).toHaveLength(1);

    await act(async () => {
      finishPreparation({ eligible: true, config: savedConfig });
    });
    await waitFor(() =>
      expect(
        screen.queryByText(/creating a smoke-test project/i),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps the run settings locked while preparation runs", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      config: savedConfig,
    });
    mockCreateHostExamRun.mockImplementation(() => new Promise(() => {}));
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[
          {
            image: "cocalc.local/rootfs/exam",
            digest: "sha256:abc",
          } as any,
        ]}
      />,
    );
    const prepare = screen.getByRole("button", {
      name: "Prepare and test run",
    });
    await waitFor(() => expect(prepare).toBeEnabled());
    fireEvent.click(prepare);
    await screen.findByRole("status");

    // The run already uses the values it was started with, so they cannot be
    // edited until preparation finishes.
    expect(
      screen.getByRole("checkbox", { name: /Practice mode/ }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Delete all exam projects at")).toBeDisabled();
    expect(
      screen.getByRole("checkbox", {
        name: "Also shut down the project host to save resources",
      }),
    ).toBeDisabled();
  });

  it("does not present a stopped historical run as the current run", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      config: savedConfig,
      run: {
        run_id: "stopped-run",
        status: "stopped",
        rootfs_image: "cocalc.local/rootfs/exam",
        scheduled_stop_at: "2026-07-30T00:00:00.000Z",
        stop_host_at_deadline: true,
      },
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[
          {
            image: "cocalc.local/rootfs/exam",
            digest: "sha256:abc",
          } as any,
        ]}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Prepare and test run" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByText("Current run")).not.toBeInTheDocument();
    expect(screen.queryByText("stopped")).not.toBeInTheDocument();
  });

  it("confirms when the last run ended and that its projects were erased", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      config: savedConfig,
      run: {
        run_id: "stopped-run",
        status: "stopped",
        rootfs_image: "cocalc.local/rootfs/exam",
        scheduled_stop_at: "2026-07-30T00:00:00.000Z",
        stop_host_at_deadline: true,
        stopped_at: "2026-07-29T18:18:00.000Z",
        cleaned_at: "2026-07-29T18:18:00.000Z",
      },
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[
          {
            image: "cocalc.local/rootfs/exam",
            digest: "sha256:abc",
          } as any,
        ]}
      />,
    );

    expect(await screen.findByText("Last run")).toBeInTheDocument();
    expect(screen.getByText("all erased")).toBeInTheDocument();
    expect(screen.getByText("Ended")).toBeInTheDocument();
    expect(screen.queryByText("Current run")).not.toBeInTheDocument();
  });

  it("names its switches and the deletion-time field for assistive technology and agents", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      host_status: "running",
      config: savedConfig,
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    expect(
      await screen.findByRole("switch", { name: "Enable exam mode" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: "Allow terminals (disabled by default)",
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Delete all exam projects at").tagName).toBe(
      "INPUT",
    );
  });

  it("restores the shutdown choice when practice mode is turned off", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      host_status: "running",
      config: savedConfig,
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );
    const shutdownLabel = "Also shut down the project host to save resources";
    const practice = await screen.findByRole("checkbox", {
      name: /Practice mode/,
    });

    // Default: shut down afterward. Practice mode hides the choice.
    expect(screen.getByRole("checkbox", { name: shutdownLabel })).toBeChecked();
    fireEvent.click(practice);
    expect(
      screen.queryByRole("checkbox", { name: shutdownLabel }),
    ).not.toBeInTheDocument();
    fireEvent.click(practice);
    expect(screen.getByRole("checkbox", { name: shutdownLabel })).toBeChecked();

    // A choice the instructor cleared stays cleared.
    fireEvent.click(screen.getByRole("checkbox", { name: shutdownLabel }));
    fireEvent.click(practice);
    fireEvent.click(practice);
    expect(
      screen.getByRole("checkbox", { name: shutdownLabel }),
    ).not.toBeChecked();
  });

  it("names the run's software image from the catalog", async () => {
    mockRootfsCatalog = {
      loading: false,
      images: [
        {
          id: "exam",
          release_id: "release-exam",
          label: "Exam Python",
          image: "cocalc.local/rootfs/exam",
          tags: ["preset:standard"],
        },
      ],
    };
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      host_status: "running",
      config: savedConfig,
      run: {
        run_id: "ready-run",
        status: "ready",
        rootfs_image: "cocalc.local/rootfs/exam",
        cleanup_mode: "scheduled",
        scheduled_stop_at: "2026-08-01T00:00:00.000Z",
        stop_host_at_deadline: true,
        max_projects: 100,
        terminal_enabled: false,
      },
      runtime: {
        admission_open: false,
        active_projects: 0,
      },
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    // The image picker shows the same label until the run state arrives.
    await screen.findByText("Current run");
    expect(screen.getByText("Exam Python")).toHaveTextContent(
      "Exam Python cocalc.local/rootfs/exam",
    );
  });

  it("says what ending the exam does to the project host", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      host_status: "running",
      config: savedConfig,
      run: {
        run_id: "ready-run",
        status: "ready",
        rootfs_image: "cocalc.local/rootfs/exam",
        cleanup_mode: "scheduled",
        scheduled_stop_at: "2026-08-01T00:00:00.000Z",
        stop_host_at_deadline: true,
        max_projects: 100,
        terminal_enabled: false,
      },
      runtime: {
        admission_open: false,
        active_projects: 0,
      },
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    expect(
      await screen.findByText(
        "Erases every student project now, then shuts down the project host.",
      ),
    ).toBeInTheDocument();
    // The shutdown choice is made in the Cleanup group.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Also shut down the project host to save resources",
      }),
    );
    expect(
      screen.getByText(
        "Erases every student project now. The project host keeps running.",
      ),
    ).toBeInTheDocument();
  });

  it("explains what each readiness check verified", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      host_status: "running",
      config: savedConfig,
      run: {
        run_id: "ready-run",
        status: "ready",
        rootfs_image: "cocalc.local/rootfs/exam",
        scheduled_stop_at: "2026-08-01T00:00:00.000Z",
        stop_host_at_deadline: true,
        max_projects: 100,
        terminal_enabled: false,
      },
      runtime: {
        admission_open: false,
        active_projects: 0,
        readiness: [
          { name: "host_running", ok: true },
          { name: "network_policy", ok: true },
          { name: "watchdog", ok: false },
        ],
      },
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    fireEvent.click(await screen.findByText("What these checks mean"));
    expect(
      await screen.findByText(
        /could not look up or connect to Internet addresses/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/ran while the run was prepared and are not repeated/),
    ).toBeInTheDocument();
    expect(screen.getByText(/failed:/)).toBeInTheDocument();
  });

  it("shows the recoverable token after refreshing an active run", async () => {
    mockGetHostExamState.mockResolvedValueOnce({
      eligible: true,
      host_status: "running",
      config: savedConfig,
      token: "exam-token-visible-later",
      run: {
        run_id: "ready-run",
        status: "ready",
        rootfs_image: "cocalc.local/rootfs/exam",
        scheduled_stop_at: "2026-08-01T00:00:00.000Z",
        stop_host_at_deadline: true,
        max_projects: 100,
        terminal_enabled: false,
      },
      runtime: {
        admission_open: false,
        active_projects: 0,
      },
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    expect(await screen.findByText("Student admission")).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(
        "https://exam-host-1.example.test/#token=exam-token-visible-later",
      ),
    ).toBeVisible();
    expect(screen.getByDisplayValue("exam-token-visible-later")).toBeVisible();
    expect(
      screen.getByText(/without sending it to the server in the URL/),
    ).toBeInTheDocument();
  });

  it("increases capacity for the active run without changing its saved default", async () => {
    const activeState = {
      eligible: true,
      host_status: "running",
      config: { ...savedConfig, max_projects: 10 },
      run: {
        run_id: "open-run",
        status: "open",
        rootfs_image: "cocalc.local/rootfs/exam",
        scheduled_stop_at: "2026-08-01T03:00:00.000Z",
        stop_host_at_deadline: false,
        max_projects: 10,
        terminal_enabled: false,
      },
      runtime: {
        status: "open",
        admission_open: true,
        active_projects: 10,
        max_projects: 10,
      },
    };
    mockGetHostExamState.mockResolvedValueOnce(activeState);
    mockIncreaseHostExamCapacity.mockResolvedValue({
      ...activeState,
      run: { ...activeState.run, max_projects: 11 },
      runtime: { ...activeState.runtime, max_projects: 11 },
    });
    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    const capacity = await screen.findByRole("spinbutton", {
      name: "Maximum students for this run",
    });
    fireEvent.change(capacity, { target: { value: "11" } });
    const increase = screen.getByRole("button", {
      name: "Increase capacity",
    });
    expect(increase).toBeEnabled();
    fireEvent.click(increase);

    await waitFor(() =>
      expect(mockIncreaseHostExamCapacity).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "host-1",
          run_id: "open-run",
          max_projects: 11,
          browser_id: "browser-1",
        }),
      ),
    );
    expect(screen.getByText(/saved default remains 10/i)).toBeInTheDocument();
  });

  it("leaves fresh-auth challenges for the fresh-auth flow", async () => {
    const freshAuthError = Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
    mockSetHostExamConfig.mockRejectedValue(freshAuthError);
    mockRunFreshAuthAction.mockImplementation(async (action) => {
      try {
        await action();
      } catch (err) {
        expect(err).toBe(freshAuthError);
        return false;
      }
      throw new Error("expected the protected action to require fresh auth");
    });

    render(
      <HostExamPanel
        host={{ id: "host-1", status: "running" } as any}
        rootfsImages={[]}
      />,
    );

    const save = screen.getByRole("button", { name: "Save configuration" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() =>
      expect(mockRunFreshAuthAction).toHaveBeenCalledTimes(1),
    );
    expect(mockSetHostExamConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        browser_id: "browser-1",
        timeout: 2 * 60_000,
      }),
    );
    expect(screen.queryByText(/fresh auth is required/)).toBeNull();
  });
});
