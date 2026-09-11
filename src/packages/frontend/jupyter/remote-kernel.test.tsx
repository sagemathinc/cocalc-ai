import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RemoteKernel from "./remote-kernel";
import {
  setupRemoteKernel,
  listRemoteKernelTargets,
  removeRemoteKernelTarget,
  remoteSshTargets,
  probeRemoteKernel,
} from "./remote-kernel-service";

jest.mock("./remote-kernel-service", () => ({
  ...jest.requireActual("./remote-kernel-service"),
  setupRemoteKernel: jest.fn(),
  listRemoteKernelTargets: jest.fn(),
  removeRemoteKernelTarget: jest.fn(),
  remoteSshTargets: jest.fn(),
  probeRemoteKernel: jest.fn(),
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => null }));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useAccountOtherSetting: () => false,
  redux: { getActions: () => ({ erase_active_key_handler: jest.fn() }) },
}));

describe("remote kernel setup", () => {
  const getComputedStyle = window.getComputedStyle;
  beforeAll(() => {
    window.getComputedStyle = (element) => getComputedStyle(element);
  });
  afterAll(() => {
    window.getComputedStyle = getComputedStyle;
  });
  const cpuProbe = {
    platform: "Linux x86_64",
    suggested_name: "jupyter",
    gpu: { status: "absent" },
    kernels: [],
    environments: [],
    warnings: [],
    search_paths: [],
  };
  beforeEach(() => {
    jest.clearAllMocks();
    (remoteSshTargets as jest.Mock).mockResolvedValue({
      aliases: ["jupyter"],
      warnings: [],
    });
    (probeRemoteKernel as jest.Mock).mockResolvedValue(cpuProbe);
  });

  async function connect(user) {
    await user.type(
      screen.getByRole("combobox", { name: "SSH destination or alias" }),
      "jupyter",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("button", { name: "Set up kernel" });
  }

  it("opens from the keyboard, focuses SSH target, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<RemoteKernel project_id="p" onRegistered={jest.fn()} />);
    const trigger = screen.getByRole("button", { name: "Remote kernel" });
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("dialog", { name: "Remote Jupyter kernel" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("combobox", { name: "SSH destination or alias" }),
      ),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("registers an existing interpreter without preparing a new environment", async () => {
    const user = userEvent.setup();
    const onRegistered = jest.fn().mockResolvedValue(undefined);
    (setupRemoteKernel as jest.Mock).mockResolvedValue("reflect-my-vm");
    render(<RemoteKernel project_id="p" onRegistered={onRegistered} />);
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    await connect(user);
    await user.click(screen.getByRole("checkbox", { name: "Advanced" }));
    await user.click(screen.getByRole("radio", { name: "Existing Python" }));
    await user.type(
      screen.getByRole("textbox", { name: "Remote Python interpreter" }),
      "/home/user/gpu/bin/python",
    );
    await user.click(screen.getByRole("button", { name: "Set up kernel" }));
    await waitFor(() =>
      expect(setupRemoteKernel).toHaveBeenCalledWith("p", {
        name: "jupyter",
        host: "jupyter",
        environment: "jupyter-python",
        python: "/home/user/gpu/bin/python",
      }),
    );
    expect(onRegistered).toHaveBeenCalledWith("reflect-my-vm");
  });

  it("keeps failures visible without selecting a kernel", async () => {
    const user = userEvent.setup();
    const onRegistered = jest.fn();
    (probeRemoteKernel as jest.Mock).mockRejectedValue(
      Error("~$ ssh jupyter\nSSH host key verification failed"),
    );
    render(<RemoteKernel project_id="p" onRegistered={onRegistered} />);
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    await user.type(
      screen.getByRole("combobox", { name: "SSH destination or alias" }),
      "jupyter",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SSH host key verification failed",
    );
    expect(screen.getByText(/~\$ ssh jupyter/).textContent).toBe(
      "~$ ssh jupyter\nSSH host key verification failed",
    );
    expect(screen.getByText(/~\$ ssh jupyter/)).toHaveStyle({
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    });
    expect(onRegistered).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox", { name: "Advanced" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up kernel" })).toBeNull();
  });

  it("requires explicit keyboard confirmation to trust a new host", async () => {
    const user = userEvent.setup();
    (probeRemoteKernel as jest.Mock).mockRejectedValueOnce(
      Error(
        "No ED25519 host key is known for gpu and you have requested strict checking.\nHost key verification failed.",
      ),
    );
    render(<RemoteKernel project_id="p" onRegistered={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    await user.type(
      screen.getByRole("combobox", { name: "SSH destination or alias" }),
      "gpu",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    const trust = await screen.findByRole("button", {
      name: "Trust new host and connect",
    });
    expect(screen.queryByRole("button", { name: "Set up kernel" })).toBeNull();
    expect(probeRemoteKernel).toHaveBeenCalledTimes(1);
    trust.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Set up kernel" });
    expect(probeRemoteKernel).toHaveBeenLastCalledWith(
      "p",
      "gpu",
      undefined,
      true,
    );
  });

  it.each([
    "REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.",
    "Restart your project to load updated tools.",
  ])(
    "keeps configuration blocked without a trust bypass: %s",
    async (error) => {
      const user = userEvent.setup();
      (probeRemoteKernel as jest.Mock).mockRejectedValueOnce(Error(error));
      render(<RemoteKernel project_id="p" onRegistered={jest.fn()} />);
      await user.click(screen.getByRole("button", { name: "Remote kernel" }));
      await user.type(
        screen.getByRole("combobox", { name: "SSH destination or alias" }),
        "gpu",
      );
      await user.click(screen.getByRole("button", { name: "Connect" }));
      await screen.findByRole("alert");
      expect(
        screen.queryByRole("button", { name: "Trust new host and connect" }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Set up kernel" }),
      ).toBeNull();
    },
  );

  it("keeps unknown GPU status distinct from CPU-only and preserves advanced names on refresh", async () => {
    const user = userEvent.setup();
    (probeRemoteKernel as jest.Mock).mockResolvedValue({
      ...cpuProbe,
      gpu: { status: "unknown", reason: "Hardware probe timed out" },
    });
    render(<RemoteKernel project_id="p" onRegistered={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    await connect(user);
    expect(screen.getByText("Hardware probe timed out")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Advanced" }));
    const name = screen.getByRole("textbox", { name: "Kernel name" });
    await user.clear(name);
    await user.type(name, "my-custom-kernel");
    await user.click(screen.getByRole("button", { name: "Refresh discovery" }));
    await screen.findByRole("button", { name: "Set up kernel" });
    expect(screen.getByRole("textbox", { name: "Kernel name" })).toHaveValue(
      "my-custom-kernel",
    );
    await user.click(screen.getByRole("combobox", { name: "Kernel software" }));
    expect(
      screen.queryByText("PyTorch 2.8 / CUDA 12.8 (NVIDIA GPU)"),
    ).toBeNull();
  });

  it("requires confirmation before removing a registered kernel", async () => {
    const user = userEvent.setup();
    const onRemoved = jest.fn().mockResolvedValue(undefined);
    (listRemoteKernelTargets as jest.Mock)
      .mockResolvedValueOnce([
        { name: "gpu", host: "jupyter", environment: "teaching" },
      ])
      .mockResolvedValue([]);
    (removeRemoteKernelTarget as jest.Mock).mockResolvedValue(undefined);
    render(
      <RemoteKernel
        project_id="p"
        onRegistered={jest.fn()}
        onRemoved={onRemoved}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    await user.click(screen.getByRole("tab", { name: "Registered kernels" }));
    const remove = await screen.findByRole("button", { name: "Remove gpu" });
    remove.focus();
    await user.keyboard("{Enter}");
    expect(removeRemoteKernelTarget).not.toHaveBeenCalled();
    await user.click(
      await screen.findByRole("button", { name: "Stop kernels and remove" }),
    );
    await waitFor(() =>
      expect(removeRemoteKernelTarget).toHaveBeenCalledWith("p", "gpu"),
    );
    expect(onRemoved).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove gpu" })).toBeNull(),
    );
  });

  it("does not select a late setup result after unmount", async () => {
    const user = userEvent.setup();
    let finish!: (value: string) => void;
    (setupRemoteKernel as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onRegistered = jest.fn();
    const view = render(
      <RemoteKernel project_id="p" onRegistered={onRegistered} />,
    );
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    await connect(user);
    await user.click(screen.getByRole("button", { name: "Set up kernel" }));
    await waitFor(() => expect(finish).toBeDefined());
    view.unmount();
    finish("reflect-my-vm");
    await Promise.resolve();
    expect(onRegistered).not.toHaveBeenCalled();
  });

  it("suggests GPU Python with derived names after only selecting an SSH alias", async () => {
    (probeRemoteKernel as jest.Mock).mockResolvedValue({
      ...cpuProbe,
      gpu: { status: "available", description: "L40S" },
    });
    (setupRemoteKernel as jest.Mock).mockResolvedValue("reflect-jupyter");
    const user = userEvent.setup();
    render(<RemoteKernel project_id="p" onRegistered={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    await user.click(
      screen.getByRole("combobox", { name: "SSH destination or alias" }),
    );
    await user.click(await screen.findByRole("option", { name: "jupyter" }));
    await user.click(
      await screen.findByRole("button", { name: "Set up kernel" }),
    );
    await waitFor(() =>
      expect(setupRemoteKernel).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({
          host: "jupyter",
          name: "jupyter",
          environment: "jupyter-gpu",
          recipe: "pytorch-cu128",
        }),
      ),
    );
  });

  it("registers discovered non-Python kernels without an installation recipe", async () => {
    (probeRemoteKernel as jest.Mock).mockResolvedValue({
      ...cpuProbe,
      kernels: [
        {
          id: "/kernels/sagejs/kernel.json",
          name: "sagejs",
          language: "javascript",
          display_name: "SageJS",
        },
      ],
    });
    (setupRemoteKernel as jest.Mock).mockResolvedValue("reflect-jupyter");
    const user = userEvent.setup();
    render(<RemoteKernel project_id="p" onRegistered={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    await connect(user);
    expect(screen.getByText("SageJS (javascript)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Set up kernel" }));
    await waitFor(() =>
      expect(setupRemoteKernel).toHaveBeenCalledWith(
        "p",
        expect.objectContaining({
          kernel: "/kernels/sagejs/kernel.json",
          recipe: undefined,
          python: undefined,
        }),
      ),
    );
  });

  it("discards a late probe after the SSH target changes", async () => {
    let finish!: (value: unknown) => void;
    (probeRemoteKernel as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<RemoteKernel project_id="p" onRegistered={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    const target = screen.getByRole("combobox", {
      name: "SSH destination or alias",
    });
    await user.type(target, "old");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.clear(target);
    await user.type(target, "new");
    finish(cpuProbe);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Set up kernel" }),
      ).toBeNull(),
    );
  });
});
