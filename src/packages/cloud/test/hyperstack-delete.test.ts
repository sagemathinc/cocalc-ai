import { HyperstackProvider } from "../hyperstack/provider";

const deleteVirtualMachine = jest.fn();
const getVirtualMachine = jest.fn();
const deleteVolume = jest.fn();
const getVolumes = jest.fn();

jest.mock("../hyperstack/client", () => ({
  deleteVirtualMachine: (...args: any[]) => deleteVirtualMachine(...args),
  getVirtualMachine: (...args: any[]) => getVirtualMachine(...args),
  deleteVolume: (...args: any[]) => deleteVolume(...args),
  getVolumes: (...args: any[]) => getVolumes(...args),
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
    getVolumes.mockReset();
    getVirtualMachine.mockRejectedValue(new Error("not found"));
    getVolumes.mockResolvedValue([{ id: 456, status: "available" }]);
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

  it("retries deleting the data volume when it is temporarily reserved", async () => {
    deleteVolume
      .mockRejectedValueOnce(
        new Error(
          '{"status":false,"message":"The Volume is not suitable for this operation during \\"reserved\\".","error_reason":"bad_request"}',
        ),
      )
      .mockResolvedValueOnce(undefined);

    await new HyperstackProvider().deleteHost(runtime, creds);

    expect(deleteVolume).toHaveBeenCalledTimes(2);
    expect(getVolumes).toHaveBeenCalled();
  });

  it("treats a missing VM as already deleted", async () => {
    deleteVirtualMachine.mockRejectedValueOnce(
      new Error(
        '{"status":false,"message":"VM 123 does not exists.","error_reason":"not_found"}',
      ),
    );

    await expect(
      new HyperstackProvider().deleteHost(runtime, creds),
    ).resolves.toBeUndefined();

    expect(deleteVolume).toHaveBeenCalledWith(456);
  });
});
