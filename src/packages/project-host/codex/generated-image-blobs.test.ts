const callHub = jest.fn();
const setGeneratedImageBlobWriter = jest.fn();
const getMasterConatClient = jest.fn(() => ({ id: "master-client" }));
const getLocalHostId = jest.fn(() => "host-1");

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => callHub(...args),
}));

jest.mock("@cocalc/lite/hub/acp", () => ({
  setGeneratedImageBlobWriter: (...args: any[]) =>
    setGeneratedImageBlobWriter(...args),
}));

jest.mock("../master-status", () => ({
  getMasterConatClient: () => getMasterConatClient(),
}));

jest.mock("../sqlite/hosts", () => ({
  getLocalHostId: () => getLocalHostId(),
}));

describe("project-host generated image blob writer", () => {
  beforeEach(() => {
    jest.resetModules();
    callHub.mockReset();
    setGeneratedImageBlobWriter.mockReset();
    getMasterConatClient.mockReset().mockReturnValue({ id: "master-client" });
    getLocalHostId.mockReset().mockReturnValue("host-1");
  });

  it("uploads generated image blobs through the master hub", async () => {
    callHub.mockResolvedValue({ uuid: "blob-uuid" });
    const { initCodexGeneratedImageBlobWriter } =
      await import("./generated-image-blobs");

    initCodexGeneratedImageBlobWriter();

    expect(setGeneratedImageBlobWriter).toHaveBeenCalledTimes(1);
    const writer = setGeneratedImageBlobWriter.mock.calls[0][0];
    const blob = Buffer.from("image");
    await writer({
      uuid: "blob-uuid",
      blob,
      accountId: "account-1",
      projectId: "project-1",
    });

    expect(callHub).toHaveBeenCalledWith({
      client: { id: "master-client" },
      host_id: "host-1",
      name: "db.saveBlob",
      args: [
        {
          account_id: "account-1",
          project_id: "project-1",
          uuid: "blob-uuid",
          blob: blob.toString("base64"),
        },
      ],
      timeout: 60_000,
    });
  });
});
