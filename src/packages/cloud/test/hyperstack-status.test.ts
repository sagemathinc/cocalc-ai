import { HyperstackProvider } from "../hyperstack/provider";

const getVirtualMachine = jest.fn();

jest.mock("../hyperstack/client", () => ({
  getVirtualMachine: (...args: any[]) => getVirtualMachine(...args),
}));

describe("HyperstackProvider.getStatus", () => {
  const provider = new HyperstackProvider();
  const runtime = {
    provider: "hyperstack" as const,
    instance_id: "123",
    ssh_user: "ubuntu",
  };
  const creds = {
    apiKey: "key",
    sshPublicKey: "ssh-rsa test",
  };

  beforeEach(() => {
    getVirtualMachine.mockReset();
  });

  it("maps active instances to running", async () => {
    getVirtualMachine.mockResolvedValue({
      id: 123,
      status: "ACTIVE",
      floating_ip: "1.2.3.4",
    });

    await expect(provider.getStatus(runtime, creds)).resolves.toBe("running");
  });

  it("maps shutoff instances to stopped", async () => {
    getVirtualMachine.mockResolvedValue({
      id: 123,
      status: "SHUTOFF",
    });

    await expect(provider.getStatus(runtime, creds)).resolves.toBe("stopped");
  });

  it("treats missing instances as stopped", async () => {
    getVirtualMachine.mockResolvedValue(undefined);

    await expect(provider.getStatus(runtime, creds)).resolves.toBe("stopped");
  });
});
