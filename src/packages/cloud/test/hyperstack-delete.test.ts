import { HyperstackProvider } from "../hyperstack/provider";

const deleteVirtualMachine = jest.fn();
const getVirtualMachine = jest.fn();
const deleteVolume = jest.fn();

jest.mock("../hyperstack/client", () => ({
  deleteVirtualMachine: (...args: any[]) => deleteVirtualMachine(...args),
  getVirtualMachine: (...args: any[]) => getVirtualMachine(...args),
  deleteVolume: (...args: any[]) => deleteVolume(...args),
}));

describe("HyperstackProvider.deleteHost", () => {
  const runtime = {
    provider: "hyperstack" as const,
    instance_id: "123",
    ssh_user: "ubuntu",
    metadata: {
      data_volume_id: 456,
    },
  };
  const creds = {
    apiKey: "key",
    sshPublicKey: "ssh-rsa test",
  };

  beforeEach(() => {
    deleteVirtualMachine.mockReset();
    getVirtualMachine.mockReset();
    deleteVolume.mockReset();
    getVirtualMachine.mockRejectedValue(new Error("not found"));
  });

  it("deletes the data volume by default", async () => {
    await new HyperstackProvider().deleteHost(runtime, creds);

    expect(deleteVirtualMachine).toHaveBeenCalledWith(123);
    expect(deleteVolume).toHaveBeenCalledWith(456);
  });

  it("preserves the data volume when requested", async () => {
    await new HyperstackProvider().deleteHost(runtime, creds, {
      preserveDataDisk: true,
    });

    expect(deleteVirtualMachine).toHaveBeenCalledWith(123);
    expect(deleteVolume).not.toHaveBeenCalled();
  });
});
