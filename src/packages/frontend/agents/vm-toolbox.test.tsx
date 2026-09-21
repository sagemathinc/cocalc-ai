/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fromJS } from "immutable";
import { VmToolbox } from "./vm-toolbox";

const id = "062225f1-1cc6-4241-976d-64e5dd0c9cf6";
const mockBinding = {
  agentId: id,
  projectId: id,
  path: "agent.chat",
  threadId: "thread",
  vms: [{ vmId: id, notes: "Conserve disk" }],
};
const mockVm = {
  id,
  name: "connector",
  state: "ready",
  cpu: 2,
  ram_gb: 8,
  boot_disk_gb: 20,
  region: "test",
  funding_mode: "course",
  owner_account_id: "alice",
};
const mockSave = jest.fn();
const mockProbe = jest.fn();
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: (_store, key) =>
    key === "account_id"
      ? "alice"
      : fromJS({ agent_vm_toolbox_v1: JSON.stringify([mockBinding]) }),
}));
jest.mock("@cocalc/frontend/components", () => ({ Icon: () => <span /> }));
jest.mock("@cocalc/frontend/keyboard/boundary", () => ({
  KeyboardBoundary: ({ children }) => <div>{children}</div>,
}));
jest.mock("@cocalc/frontend/auth/fresh-auth", () => ({
  FreshAuthModal: () => null,
  useFreshAuthAction: () => ({
    runFreshAuthAction: async (fn) => {
      await fn();
      return true;
    },
    freshAuthModalProps: {},
  }),
}));
jest.mock(
  "@cocalc/frontend/project/settings/project-to-project-ssh-service",
  () => ({ ensureProjectDeployPublicKey: jest.fn() }),
);
jest.mock("./vm-toolbox-service", () => ({
  assertToolboxAccount: jest.fn(),
  currentVmToolbox: () => [mockBinding],
  listToolboxVms: async () => [mockVm],
  prepareVmSsh: jest.fn(),
  probeVmSsh: (...args) => mockProbe(...args),
  saveVmToolbox: (...args) => mockSave(...args),
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      hub: {
        agent: {
          resolveIdentity: async () => ({ agent_id: id }),
          registerIdentity: async () => ({ agent_id: id }),
        },
      },
    },
  },
}));

test("keyboard opens saved VM, edits advisory notes, checks SSH and detaches without stopping", async () => {
  const user = userEvent.setup();
  const close = jest.fn();
  render(
    <VmToolbox
      projectId={id}
      path="agent.chat"
      threadId="thread"
      open
      onClose={close}
    />,
  );
  const saved = await screen.findByRole("button", { name: "connector" });
  saved.focus();
  await user.keyboard("{Enter}");
  const notes = screen.getByRole("textbox", {
    name: "Instructions for this VM",
  });
  expect(notes).toHaveValue("Conserve disk");
  await user.clear(notes);
  await user.type(notes, "Install packages as needed");
  await user.click(screen.getByRole("button", { name: "Save to toolbox" }));
  await waitFor(() =>
    expect(mockSave).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({
        vms: [{ vmId: id, notes: "Install packages as needed" }],
      }),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Check SSH" }));
  await waitFor(() => expect(mockProbe).toHaveBeenCalledWith(id, id));
  const remove = screen.getByRole("button", {
    name: "Remove connector from toolbox",
  });
  remove.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(mockSave).toHaveBeenLastCalledWith(
      "alice",
      expect.objectContaining({ vms: [] }),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Done", exact: true }));
  expect(close).toHaveBeenCalled();
});
