const callHub = jest.fn();
const setAttachmentBlobReader = jest.fn();
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
  setAttachmentBlobReader: (...args: any[]) => setAttachmentBlobReader(...args),
  setGeneratedImageBlobWriter: (...args: any[]) =>
    setGeneratedImageBlobWriter(...args),
}));

jest.mock("../master-conat-client", () => ({
  getMasterConatClient: () => getMasterConatClient(),
}));

jest.mock("../sqlite/hosts", () => ({
  getLocalHostId: () => getLocalHostId(),
}));

describe("project-host generated image blob writer", () => {
  beforeEach(() => {
    jest.resetModules();
    callHub.mockReset();
    setAttachmentBlobReader.mockReset();
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

  it("reads chat attachment blobs through the master hub", async () => {
    const blob = Buffer.from("image");
    callHub.mockResolvedValue({ blob: blob.toString("base64") });
    const { initCodexAttachmentBlobReader } =
      await import("./generated-image-blobs");

    initCodexAttachmentBlobReader();

    expect(setAttachmentBlobReader).toHaveBeenCalledTimes(1);
    const reader = setAttachmentBlobReader.mock.calls[0][0];
    await expect(
      reader({ uuid: "blob-uuid", projectId: "project-1" }),
    ).resolves.toEqual(blob);
    expect(callHub).toHaveBeenCalledWith({
      client: { id: "master-client" },
      host_id: "host-1",
      name: "db.getBlob",
      args: [{ project_id: "project-1", uuid: "blob-uuid" }],
      timeout: 60_000,
    });
  });
});
