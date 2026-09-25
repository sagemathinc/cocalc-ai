import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type {
  ComputeVm,
  ComputeVmProjectAccess,
} from "@cocalc/conat/hub/api/compute";
import { VmAccessModal, VmDetailsModal } from "./compute-vms";

jest.mock("@cocalc/frontend/projects/project-title", () => ({
  ProjectTitle: ({ project_id }: { project_id: string }) => (
    <span>Project {project_id}</span>
  ),
}));

jest.mock("@cocalc/frontend/projects/select-project", () => ({
  SelectProject: () => <div>Select project</div>,
}));

const vm = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "compute-vm",
  ssh_user: "user",
} as ComputeVm;

const access = [
  {
    vm_id: vm.id,
    project_id: "22222222-2222-4222-8222-222222222222",
    state: "ready",
  } as ComputeVmProjectAccess,
];

test("VM details lead with hardware and keep technical fields collapsed", () => {
  render(
    <VmDetailsModal
      open
      vm={{
        ...vm,
        provider: "gcp",
        cpu: 4,
        ram_gb: 16,
        boot_disk_gb: 30,
        machine_type: "n2-standard-4",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        state: "stopped",
        desired_state: "stopped",
      }}
      onClose={jest.fn()}
    />,
  );
  expect(
    screen.getByRole("region", { name: "Machine configuration" }),
  ).toHaveTextContent("4 vCPU");
  const disclosure = screen.getByText("Technical details");
  expect(disclosure.parentElement).not.toHaveAttribute("open");
  fireEvent.click(disclosure);
  expect(disclosure.parentElement).toHaveAttribute("open");
});

describe("VmAccessModal", () => {
  it("explains the one-way project boundary and manages direct public keys", async () => {
    const onAddSshKey = jest.fn(async () => true);
    render(
      <VmAccessModal
        vm={vm}
        access={access}
        sshKeys={[
          {
            fingerprint: "SHA256:fingerprint",
            key_type: "ssh-ed25519",
            comment: "laptop",
            ssh_public_key: "ssh-ed25519 AAAATEST laptop",
          },
        ]}
        loadingKeys={false}
        saving={false}
        onClose={jest.fn()}
        onGrant={jest.fn(async () => undefined)}
        onRevoke={jest.fn(async () => undefined)}
        onAddSshKey={onAddSshKey}
        onRevokeSshKey={jest.fn(async () => undefined)}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Access to compute-vm" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not gain the ability to SSH to the project/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Projects with access")).toBeInTheDocument();
    expect(screen.getByText("Public SSH keys")).toBeInTheDocument();
    expect(screen.getByText("SHA256:fingerprint")).toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "Public SSH key" });
    fireEvent.change(input, {
      target: { value: "ssh-ed25519 AAAANEW workstation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add public key" }));

    await waitFor(() =>
      expect(onAddSshKey).toHaveBeenCalledWith(
        "ssh-ed25519 AAAANEW workstation",
      ),
    );
  });
});
