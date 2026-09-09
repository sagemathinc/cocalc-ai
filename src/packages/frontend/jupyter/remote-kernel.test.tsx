import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RemoteKernel from "./remote-kernel";
import {
  setupRemoteKernel,
  listRemoteKernelTargets,
  removeRemoteKernelTarget,
} from "./remote-kernel-service";

jest.mock("./remote-kernel-service", () => ({
  setupRemoteKernel: jest.fn(),
  listRemoteKernelTargets: jest.fn(),
  removeRemoteKernelTarget: jest.fn(),
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
  beforeEach(() => jest.clearAllMocks());

  it("opens from the keyboard, focuses the name, and restores focus on Escape", async () => {
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
        screen.getByRole("textbox", { name: "Kernel name" }),
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
    await user.type(
      screen.getByRole("textbox", { name: "SSH destination or alias" }),
      "jupyter",
    );
    await user.click(screen.getByRole("radio", { name: "Existing Python" }));
    await user.type(
      screen.getByRole("textbox", { name: "Remote Python interpreter" }),
      "/home/user/gpu/bin/python",
    );
    await user.click(screen.getByRole("button", { name: "Register kernel" }));
    await waitFor(() =>
      expect(setupRemoteKernel).toHaveBeenCalledWith("p", {
        name: "my-vm",
        host: "jupyter",
        environment: "teaching",
        python: "/home/user/gpu/bin/python",
      }),
    );
    expect(onRegistered).toHaveBeenCalledWith("reflect-my-vm");
  });

  it("keeps failures visible without selecting a kernel", async () => {
    const user = userEvent.setup();
    const onRegistered = jest.fn();
    (setupRemoteKernel as jest.Mock).mockRejectedValue(
      Error("SSH host key verification failed"),
    );
    render(<RemoteKernel project_id="p" onRegistered={onRegistered} />);
    await user.click(screen.getByRole("button", { name: "Remote kernel" }));
    await user.type(
      screen.getByRole("textbox", { name: "SSH destination or alias" }),
      "jupyter",
    );
    await user.click(screen.getByRole("button", { name: "Register kernel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "SSH host key verification failed",
    );
    expect(onRegistered).not.toHaveBeenCalled();
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
    await user.type(
      screen.getByRole("textbox", { name: "SSH destination or alias" }),
      "jupyter",
    );
    await user.click(screen.getByRole("button", { name: "Register kernel" }));
    await waitFor(() => expect(finish).toBeDefined());
    view.unmount();
    finish("reflect-my-vm");
    await Promise.resolve();
    expect(onRegistered).not.toHaveBeenCalled();
  });
});
