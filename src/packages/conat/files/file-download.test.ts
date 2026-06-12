import { handleFileDownload, DOWNLOAD_ERROR_HEADER } from "./file-download";

const mockReadFile = jest.fn();
const mockFsStat = jest.fn();
const mockFsRm = jest.fn();
const mockFsClient = jest.fn(() => ({
  stat: mockFsStat,
  rm: mockFsRm,
}));
const mockFsSubject = jest.fn(() => "fs.project-test");

jest.mock("./read", () => ({
  readFile: (...args) => mockReadFile(...args),
}));

jest.mock("./fs", () => ({
  fsClient: (...args) => mockFsClient(...args),
  fsSubject: (...args) => mockFsSubject(...args),
}));

describe("handleFileDownload", () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockFsStat.mockReset();
    mockFsRm.mockReset();
    mockFsClient.mockClear();
    mockFsSubject.mockClear();
  });

  it("uses stat instead of streaming for allowed HEAD downloads", async () => {
    mockFsStat.mockResolvedValue({
      size: 123,
      mtime: new Date("2026-04-26T21:00:00.000Z"),
    });
    const req: any = {
      method: "HEAD",
      url: "/project-123/files/home/user/a.tar?download",
    };
    const headers: Record<string, any> = {};
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn((key, value) => {
        headers[key] = value;
      }),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(mockFsSubject).toHaveBeenCalledWith({ project_id: "project-123" });
    expect(mockFsClient).toHaveBeenCalledWith({
      client: { id: "client-1" },
      subject: "fs.project-test",
    });
    expect(mockFsStat).toHaveBeenCalledWith("/home/user/a.tar");
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(headers["Content-Length"]).toBe(123);
    expect(headers["Last-Modified"]).toBe("Sun, 26 Apr 2026 21:00:00 GMT");
    expect(res.end).toHaveBeenCalled();
  });

  it("parses legacy /projects project file URLs for HEAD downloads", async () => {
    mockFsStat.mockResolvedValue({ size: 123 });
    const req: any = {
      method: "HEAD",
      url: "/projects/project-123/files/home/user/a.tar?download",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(mockFsSubject).toHaveBeenCalledWith({ project_id: "project-123" });
    expect(mockFsStat).toHaveBeenCalledWith("/home/user/a.tar");
    expect(res.statusCode).toBe(200);
  });

  it("parses legacy /projects project file URLs for streamed downloads", async () => {
    mockReadFile.mockResolvedValue([
      Buffer.from("hello"),
      Buffer.from(" world"),
    ]);
    const req: any = {
      method: "GET",
      url: "/projects/project-123/files/home/user/a.txt?download",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      write: jest.fn(() => true),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(mockReadFile).toHaveBeenCalledWith({
      client: { id: "client-1" },
      project_id: "project-123",
      path: "/home/user/a.txt",
      maxWait: 1000 * 60 * 60,
    });
    expect(res.write).toHaveBeenCalledWith(Buffer.from("hello"));
    expect(res.write).toHaveBeenCalledWith(Buffer.from(" world"));
    expect(res.end).toHaveBeenCalled();
  });

  it("uses an explicit read service name for streamed downloads", async () => {
    mockReadFile.mockResolvedValue([Buffer.from("hello")]);
    const req: any = {
      method: "GET",
      url: "/project-123/files/home/user/a.txt?download",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      write: jest.fn(() => true),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
      readServiceName: ":project-host",
    });

    expect(mockReadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "project-123",
        path: "/home/user/a.txt",
        name: ":project-host",
      }),
    );
  });

  it("uses the requested display filename and removes temporary archives after streaming", async () => {
    mockReadFile.mockResolvedValue([Buffer.from("archive")]);
    mockFsRm.mockResolvedValue(undefined);
    const headers: Record<string, any> = {};
    const req: any = {
      method: "GET",
      url: "/project-123/files/tmp/.cocalc-download-archive-token-selection.zip?download&deleteAfterDownload=1&downloadFilename=selection.zip",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn((key, value) => {
        headers[key] = value;
      }),
      write: jest.fn(() => true),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(headers["Content-disposition"]).toBe(
      "attachment; filename*=UTF-8''selection.zip",
    );
    expect(mockReadFile).toHaveBeenCalledWith({
      client: { id: "client-1" },
      project_id: "project-123",
      path: "/tmp/.cocalc-download-archive-token-selection.zip",
      maxWait: 1000 * 60 * 60,
    });
    expect(mockFsRm).toHaveBeenCalledWith(
      "/tmp/.cocalc-download-archive-token-selection.zip",
      { force: true },
    );
  });

  it("ignores delete-after-download for non-temporary paths", async () => {
    mockReadFile.mockResolvedValue([Buffer.from("data")]);
    const req: any = {
      method: "GET",
      url: "/project-123/files/home/user/a.txt?download&deleteAfterDownload=1",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      write: jest.fn(() => true),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
    });

    expect(mockFsRm).not.toHaveBeenCalled();
  });

  it("removes temporary archives when a GET download is rejected before streaming", async () => {
    mockFsRm.mockResolvedValue(undefined);
    const req: any = {
      method: "GET",
      url: "/project-123/files/tmp/.cocalc-download-archive-token-selection.zip?download&deleteAfterDownload=1&downloadFilename=selection.zip",
    };
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn(),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
      beforeExplicitDownload: async () => ({
        allowed: false,
        message: "managed egress blocked",
      }),
    });

    expect(res.statusCode).toBe(429);
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(mockFsRm).toHaveBeenCalledWith(
      "/tmp/.cocalc-download-archive-token-selection.zip",
      { force: true },
    );
  });

  it("returns the managed download error for blocked HEAD preflight", async () => {
    const req: any = {
      method: "HEAD",
      url: "/project-123/files/home/user/a.tar?download",
    };
    const headers: Record<string, any> = {};
    const res: any = {
      statusCode: undefined,
      setHeader: jest.fn((key, value) => {
        headers[key] = value;
      }),
      end: jest.fn(),
      on: jest.fn(),
      writableEnded: false,
      destroyed: false,
    };

    await handleFileDownload({
      req,
      res,
      client: { id: "client-1" } as any,
      beforeExplicitDownload: async () => ({
        allowed: false,
        message: "managed egress blocked",
      }),
    });

    expect(res.statusCode).toBe(429);
    expect(headers[DOWNLOAD_ERROR_HEADER]).toBe(
      encodeURIComponent("managed egress blocked"),
    );
    expect(mockFsStat).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });
});
